//! What happens to hosted mail when it arrives, with nobody's tab open: a step of the app's
//! maintenance (every minute, one replica at a time) that looks at each hosted mailbox as its owner
//! (`hosted.rs` keeps the password) and, for the messages that arrived since it last looked:
//! * files mail from senders the workspace blocks into Spam, and mail from senders it allows out of
//!   Spam (`comms_mail_sender`, administered in Mail settings);
//! * applies calendar answers and cancellations (`itip.rs`);
//! * sends the person one notification (`comms.newmail`) for the new, unread mail in their Inbox
//!   that is not their own, as their Mail setting says (all, people they wrote to, nothing);
//! * brings snoozed conversations whose time came back to the Inbox, unread.
//!
//! Where it last looked is the mail server's Email state, kept per mailbox (`comms_mail_cursor`). The
//! first look notifies about nothing old; a state the server forgot (`cannotCalculateChanges`)
//! starts again from now without a flood. The state moves by compare-and-set in the transaction
//! that stores the notification, so a second replica, or a round after a crash, never notifies
//! twice and never skips one. Each mailbox gets one request at a time (the server allows four per
//! account; the person's open tabs use up to three); a mailbox the server is busy for waits for the
//! next round, one that fails backs off without holding up the others. Nothing of a message is
//! logged; the notification carries the sender and subject, never the body.

use crate::itip;
use crate::{hosted, util};
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use ferrum_kernel::{Error, Kernel, Result, notify};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use uuid::Uuid;

const USING: &[&str] = &["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission", "urn:ietf:params:jmap:sieve"];
/// Changes asked for at once, and how many such pages one look reads (the rest next round).
const PAGE: u64 = 256;
const PAGES: usize = 4;
/// The server's limit of calls in one request (`maxCallsInRequest`).
const CALLS: usize = 16;
/// Senders looked up for "people I have written to" in one look.
const PEOPLE: usize = 30;
/// The Mail script Mail owns (`ui/src/lib/filters.ts`) and its data line.
const SCRIPT: &str = "ferrum-mail";
const DATA: &str = "# ferrum: ";
/// Snoozed mail: its folder and its wake time as a keyword (`ui/src/lib/watch.ts`).
const SNOOZED: &str = "Snoozed";
const WAKE: &str = "$ferrum_wake_";

/// Why the mail server did not answer.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal {
    /// Too many requests for the account at once, or too many lately: try next round.
    Busy,
    /// The kept password was refused.
    SignIn,
    Failed(String),
}

impl From<Refusal> for Error {
    fn from(r: Refusal) -> Error {
        match r {
            Refusal::Busy => Error::Unavailable("the mail server is busy; try again in a moment".into()),
            Refusal::SignIn => Error::Unavailable("the mail server refused the mailbox's sign-in".into()),
            Refusal::Failed(e) => Error::Unavailable(format!("the mail server: {e}")),
        }
    }
}

/// A mailbox as its owner reaches it: JMAP method calls (`[[method, args, id], ...]` in, the
/// answers out) and blob downloads.
#[async_trait]
pub(crate) trait Mail: Send + Sync {
    async fn call(&self, calls: Value) -> std::result::Result<Vec<Value>, Refusal>;
    async fn download(&self, account: &str, blob: &str, max: usize) -> std::result::Result<Vec<u8>, Refusal>;
}

/// What a mail server's HTTP status and body mean for the step.
pub(crate) fn refusal(status: u16, body: &[u8]) -> Option<Refusal> {
    match status {
        200..=299 => None,
        401 => Some(Refusal::SignIn),
        429 => Some(Refusal::Busy),
        // RFC 8620 §3.6.1: a request over the account's concurrent-request limit.
        400 if String::from_utf8_lossy(body).contains("maxConcurrentRequests") => Some(Refusal::Busy),
        _ => Some(Refusal::Failed(format!("answered {status}"))),
    }
}

/// A hosted mailbox signed in with its kept password (maintenance has no person's session).
pub(crate) struct Owner<'a> {
    pub k: &'a Kernel,
    pub url: String,
    pub auth: String,
}

#[async_trait]
impl Mail for Owner<'_> {
    async fn call(&self, calls: Value) -> std::result::Result<Vec<Value>, Refusal> {
        let body = json!({"using": USING, "methodCalls": calls}).to_string().into_bytes();
        let (status, _, out) = hosted::send(self.k, &self.url, &self.auth, "/jmap/", Some(("application/json", body)), 16 << 20)
            .await
            .map_err(|e| Refusal::Failed(e.to_string()))?;
        if let Some(r) = refusal(status, &out) {
            return Err(r);
        }
        let v: Value = serde_json::from_slice(&out).map_err(|_| Refusal::Failed("not JSON".into()))?;
        v["methodResponses"].as_array().cloned().ok_or_else(|| Refusal::Failed("no answers".into()))
    }
    async fn download(&self, account: &str, blob: &str, max: usize) -> std::result::Result<Vec<u8>, Refusal> {
        let path = format!("/jmap/download/{account}/{blob}/part?accept=application/octet-stream");
        let (status, _, out) = hosted::send(self.k, &self.url, &self.auth, &path, None, max).await.map_err(|e| Refusal::Failed(e.to_string()))?;
        refusal(status, &out).map_or(Ok(out), Err)
    }
}

/// Which new mail notifies: the person's Mail setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Notify {
    All,
    People,
    Nothing,
}

impl Notify {
    fn word(self) -> &'static str {
        match self {
            Notify::All => "all",
            Notify::People => "people",
            Notify::Nothing => "none",
        }
    }
    fn from_word(w: &str) -> Notify {
        match w {
            "people" => Notify::People,
            "none" => Notify::Nothing,
            _ => Notify::All,
        }
    }
}

/// The setting as Mail's script keeps it (its `# ferrum: {...}` line, `prefs.notify`); all when unset.
pub(crate) fn notify_in_script(script: &str) -> Notify {
    let data = script.lines().find_map(|l| l.strip_prefix(DATA)).and_then(|d| serde_json::from_str::<Value>(d).ok());
    Notify::from_word(data.as_ref().and_then(|d| d["prefs"]["notify"].as_str()).unwrap_or("all"))
}

/// The workspace's allowed and blocked senders: addresses and domains, lower case.
#[derive(Debug, Default)]
pub(crate) struct Senders {
    pub allow: BTreeSet<String>,
    pub block: BTreeSet<String>,
}

impl Senders {
    /// Whether mail from `email` is blocked (`Some(true)`) or allowed (`Some(false)`): the address
    /// itself decides first, then its domain and the domains above it, nearest first.
    pub(crate) fn verdict(&self, email: &str) -> Option<bool> {
        let email = email.trim().to_lowercase();
        let of = |key: &str| {
            if self.block.contains(key) {
                Some(true)
            } else if self.allow.contains(key) {
                Some(false)
            } else {
                None
            }
        };
        if let Some(v) = of(&email) {
            return Some(v);
        }
        let mut domain = email.split_once('@')?.1;
        loop {
            if let Some(v) = of(domain) {
                return Some(v);
            }
            domain = domain.split_once('.')?.1;
            if !domain.contains('.') {
                return None;
            }
        }
    }
}

/// Where the step last left a mailbox.
#[derive(Debug, Clone)]
pub(crate) struct Cursor {
    pub state: Option<String>,
    pub notify: Notify,
    pub script_blob: Option<String>,
}

/// A message that notifies.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Arrival {
    pub id: String,
    pub from: String,
    pub name: String,
    pub subject: String,
    pub received: String,
}

/// What one look found and did.
#[derive(Debug, Default)]
pub(crate) struct Look {
    pub state: String,
    pub notify: Option<Notify>,
    pub script_blob: Option<String>,
    /// Newest first.
    pub news: Vec<Arrival>,
    pub inbox: Option<String>,
    /// Messages with a calendar part to apply.
    pub calendar: Vec<String>,
    /// The server forgot the old state: started again from now.
    pub reset: bool,
    pub filed: usize,
    pub woke: usize,
}

fn mailbox_with<'a>(boxes: &'a [Value], f: impl Fn(&Value) -> bool) -> Option<&'a str> {
    boxes.iter().find(|b| f(b)).and_then(|b| b["id"].as_str())
}

fn error_type(answer: &Value) -> Option<&str> {
    (answer[0] == "error").then(|| answer[1]["type"].as_str().unwrap_or("serverFail"))
}

fn answer<'a>(answers: &'a [Value], i: usize) -> std::result::Result<&'a Value, Refusal> {
    let a = answers.get(i).ok_or_else(|| Refusal::Failed("too few answers".into()))?;
    match error_type(a) {
        Some(t) => Err(Refusal::Failed(format!("{} refused: {t}", a[0]))),
        None => Ok(&a[1]),
    }
}

/// The wake time in a snoozed message's keywords (`$ferrum_wake_YYYYMMDDHHMM`, UTC).
pub(crate) fn wake_of(keywords: &Value) -> Option<(String, DateTime<Utc>)> {
    let (k, _) = keywords.as_object()?.iter().find(|(k, _)| k.to_ascii_lowercase().starts_with(WAKE))?;
    let d = k.get(WAKE.len()..)?;
    let n = |a: usize, b: usize| d.get(a..b)?.parse::<u32>().ok();
    let at = Utc.with_ymd_and_hms(n(0, 4)? as i32, n(4, 6)?, n(6, 8)?, n(8, 10)?, n(10, 12)?, 0).single()?;
    Some((k.clone(), at))
}

const ARRIVED: &[&str] = &["threadId", "mailboxIds", "keywords", "from", "subject", "receivedAt", "attachments"];

/// Looks at `account` (owned by the addresses `own`) since `cur`, files and wakes what the
/// workspace's senders and snooze say, and returns what notifies.
pub(crate) async fn look(
    mail: &dyn Mail,
    account: &str,
    own: &[String],
    cur: &Cursor,
    senders: &Senders,
    now: DateTime<Utc>,
) -> std::result::Result<Look, Refusal> {
    let mut out = Look::default();
    let boxes_call = json!(["Mailbox/get", {"accountId": account, "properties": ["name", "role", "parentId", "totalEmails"]}, "b"]);
    let get_created = |from: &str| json!(["Email/get", {"accountId": account, "#ids": {"resultOf": from, "name": "Email/changes", "path": "/created"}, "properties": ARRIVED, "bodyProperties": ["type"]}, "g"]);
    let mut created: Vec<Value> = Vec::new();
    let boxes: Vec<Value>;
    match &cur.state {
        None => {
            // The first look: from now on; and the setting, from the person's Mail script.
            let r = mail.call(json!([boxes_call, ["Email/get", {"accountId": account, "ids": [], "properties": ["id"]}, "s"]])).await?;
            boxes = answer(&r, 0)?["list"].as_array().cloned().unwrap_or_default();
            out.state = answer(&r, 1)?["state"].as_str().unwrap_or_default().to_string();
            let (n, blob) = read_notify(mail, account, cur).await?;
            (out.notify, out.script_blob) = (Some(n), blob);
        }
        Some(state) => {
            let mut since = state.clone();
            let mut first = Some(boxes_call);
            let mut got_boxes = Vec::new();
            for _ in 0..PAGES {
                let mut calls = vec![json!(["Email/changes", {"accountId": account, "sinceState": since, "maxChanges": PAGE}, "c"]), get_created("c")];
                let with_boxes = first.take().map(|b| calls.insert(0, b)).is_some();
                let r = mail.call(Value::Array(calls)).await?;
                let at = usize::from(with_boxes);
                if with_boxes {
                    got_boxes = answer(&r, 0)?["list"].as_array().cloned().unwrap_or_default();
                }
                let changes = r.get(at).ok_or_else(|| Refusal::Failed("too few answers".into()))?;
                match error_type(changes) {
                    // Forgotten (or never valid) state: start again from now, notifying about nothing.
                    Some("cannotCalculateChanges" | "invalidArguments") => {
                        let r = mail.call(json!([["Email/get", {"accountId": account, "ids": [], "properties": ["id"]}, "s"]])).await?;
                        since = answer(&r, 0)?["state"].as_str().unwrap_or_default().to_string();
                        out.reset = true;
                        created.clear();
                        break;
                    }
                    Some(t) => return Err(Refusal::Failed(format!("Email/changes refused: {t}"))),
                    None => {}
                }
                created.extend(answer(&r, at + 1)?["list"].as_array().cloned().unwrap_or_default());
                since = changes[1]["newState"].as_str().unwrap_or(&since).to_string();
                if changes[1]["hasMoreChanges"] != json!(true) {
                    break;
                }
            }
            boxes = got_boxes;
            out.state = since;
        }
    }
    let inbox = mailbox_with(&boxes, |b| b["role"] == "inbox").map(String::from);
    let junk = mailbox_with(&boxes, |b| b["role"] == "junk").map(String::from);
    let sent = mailbox_with(&boxes, |b| b["role"] == "sent").map(String::from);
    out.inbox = inbox.clone();
    let own: BTreeSet<String> = own.iter().map(|a| a.to_lowercase()).collect();

    // Arrivals: filed by the workspace's senders, then read for the calendar and for notifying.
    let mut moves = serde_json::Map::new();
    let mut candidates = Vec::new();
    for m in &created {
        let (Some(id), Some(ids)) = (m["id"].as_str(), m["mailboxIds"].as_object()) else { continue };
        let from = m["from"][0]["email"].as_str().unwrap_or_default().to_lowercase();
        let mine = own.contains(&from);
        let mut in_inbox = inbox.as_ref().is_some_and(|i| ids.contains_key(i));
        let in_junk = junk.as_ref().is_some_and(|j| ids.contains_key(j));
        match (senders.verdict(&from), &inbox, &junk) {
            (Some(true), Some(i), Some(j)) if in_inbox && !mine => {
                moves.insert(
                    id.into(),
                    json!({format!("mailboxIds/{i}"): null, format!("mailboxIds/{j}"): true, "keywords/$junk": true, "keywords/$notjunk": null}),
                );
                in_inbox = false;
            }
            (Some(false), Some(i), Some(j)) if in_junk => {
                moves.insert(
                    id.into(),
                    json!({format!("mailboxIds/{j}"): null, format!("mailboxIds/{i}"): true, "keywords/$junk": null, "keywords/$notjunk": true}),
                );
                in_inbox = true;
            }
            _ => {}
        }
        if !in_inbox {
            continue;
        }
        let kw = &m["keywords"];
        let calendar = m["attachments"].as_array().into_iter().flatten().any(|p| itip::is_calendar(p["type"].as_str().unwrap_or_default()));
        if calendar && kw[itip::APPLIED] != json!(true) && !mine {
            out.calendar.push(id.to_string());
        }
        if kw["$seen"] == json!(true) || kw["$draft"] == json!(true) || mine || from.is_empty() {
            continue;
        }
        let name = m["from"][0]["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&from).to_string();
        candidates.push(Arrival {
            id: id.to_string(),
            from,
            name,
            subject: m["subject"].as_str().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("(no subject)").to_string(),
            received: m["receivedAt"].as_str().unwrap_or_default().to_string(),
        });
    }
    out.filed = moves.len();
    if !moves.is_empty() {
        let r = mail.call(json!([["Email/set", {"accountId": account, "update": moves}, "0"]])).await?;
        answer(&r, 0)?;
    }

    // Who to tell: the setting is read again only when the script changed.
    if !candidates.is_empty() && !out.reset {
        let notify = match out.notify {
            Some(n) => n,
            None => {
                let (n, blob) = read_notify(mail, account, cur).await?;
                (out.notify, out.script_blob) = (Some(n), blob);
                n
            }
        };
        out.news = match notify {
            Notify::Nothing => vec![],
            Notify::All => candidates,
            Notify::People => {
                let known = written_to(mail, account, sent.as_deref(), &candidates).await?;
                candidates.into_iter().filter(|a| known.contains(&a.from)).collect()
            }
        };
        out.news.sort_by(|a, b| b.received.cmp(&a.received));
    }

    // Snoozed conversations whose time came: back to the Inbox, unread.
    let snoozed = boxes.iter().find(|b| b["role"].is_null() && b["parentId"].is_null() && b["name"] == SNOOZED);
    if let (Some(s), Some(i)) = (snoozed, &inbox)
        && s["totalEmails"].as_u64().unwrap_or(0) > 0
        && let Some(sid) = s["id"].as_str()
    {
        let r = mail
            .call(json!([
                ["Email/query", {"accountId": account, "filter": {"inMailbox": sid}, "limit": 500}, "q"],
                ["Email/get", {"accountId": account, "#ids": {"resultOf": "q", "name": "Email/query", "path": "/ids"}, "properties": ["keywords"]}, "g"],
            ]))
            .await?;
        let mut wake = serde_json::Map::new();
        for m in answer(&r, 1)?["list"].as_array().into_iter().flatten() {
            let (Some(id), Some((key, at))) = (m["id"].as_str(), wake_of(&m["keywords"])) else { continue };
            if at <= now {
                wake.insert(
                    id.into(),
                    json!({format!("mailboxIds/{sid}"): null, format!("mailboxIds/{i}"): true, "keywords/$seen": null, format!("keywords/{key}"): null}),
                );
            }
        }
        out.woke = wake.len();
        if !wake.is_empty() {
            let r = mail.call(json!([["Email/set", {"accountId": account, "update": wake}, "0"]])).await?;
            answer(&r, 0)?;
        }
    }
    Ok(out)
}

/// The person's notification setting and the script blob it was read from (the cached one when the
/// script did not change).
async fn read_notify(mail: &dyn Mail, account: &str, cur: &Cursor) -> std::result::Result<(Notify, Option<String>), Refusal> {
    let r = mail.call(json!([["SieveScript/get", {"accountId": account, "properties": ["name", "blobId"]}, "0"]])).await?;
    let blob = answer(&r, 0)?["list"].as_array().into_iter().flatten().find(|s| s["name"] == SCRIPT).and_then(|s| s["blobId"].as_str()).map(String::from);
    match &blob {
        None => Ok((Notify::All, None)),
        Some(b) if cur.script_blob.as_ref() == Some(b) => Ok((cur.notify, blob)),
        Some(b) => {
            let script = mail.download(account, b, 1 << 20).await?;
            Ok((notify_in_script(&String::from_utf8_lossy(&script)), blob))
        }
    }
}

/// Which of the senders the person has written to (something of theirs in Sent is to them).
async fn written_to(mail: &dyn Mail, account: &str, sent: Option<&str>, list: &[Arrival]) -> std::result::Result<BTreeSet<String>, Refusal> {
    let Some(sent) = sent else { return Ok(BTreeSet::new()) };
    let senders: Vec<&String> = list.iter().map(|a| &a.from).collect::<BTreeSet<_>>().into_iter().take(PEOPLE).collect();
    let mut known = BTreeSet::new();
    for chunk in senders.chunks(CALLS) {
        let calls: Vec<Value> = chunk
            .iter()
            .enumerate()
            .map(|(i, e)| json!(["Email/query", {"accountId": account, "filter": {"inMailbox": sent, "to": e}, "limit": 1}, i.to_string()]))
            .collect();
        let r = mail.call(Value::Array(calls)).await?;
        for (i, e) in chunk.iter().enumerate() {
            if answer(&r, i)?["ids"].as_array().is_some_and(|ids| !ids.is_empty()) {
                known.insert((*e).clone());
            }
        }
    }
    Ok(known)
}

/// The notification for `news` (newest first): its title and line. Sender and subject, never the body.
pub(crate) fn wording(news: &[Arrival]) -> (String, String) {
    let newest = &news[0];
    let title = if news.len() == 1 { format!("New message from {}", newest.name) } else { format!("{} new messages", news.len()) };
    (util::cut(&title, 200), util::cut(&format!("{}: {}", newest.name, newest.subject), 300))
}

/// How long a failing mailbox waits: 2, 4, 8... minutes, at most six hours.
pub(crate) fn backoff(failures: i32) -> chrono::Duration {
    chrono::Duration::minutes(2i64.saturating_pow(failures.clamp(1, 9) as u32).min(360))
}

/// From maintenance: every hosted mailbox of the workspace, oldest look first, while `budget` lasts.
/// Returns how many mailboxes were looked at.
pub async fn run(k: &Kernel, tenant: Uuid, budget: Duration) -> Result<usize> {
    let Some(url) = hosted::server_url() else { return Ok(0) };
    if hosted::mail_domain(k, tenant).await?.is_none() {
        return Ok(0);
    }
    let started = Instant::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    let rows: Vec<(Uuid, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<i32>, bool)> = sqlx::query_as(
        "select m.id, m.user_id, lower(m.email), m.account_id, c.email_state, c.notify, c.script_blob, c.failures, c.mailbox_id is not null \
         from e_hosted_mailbox m left join comms_mail_cursor c on c.tenant_id = m.tenant_id and c.mailbox_id = m.id \
         where m.tenant_id = $1 and m.status = 'Active' and m.account_id is not null and (c.retry_at is null or c.retry_at <= now()) \
         order by c.checked_at nulls first",
    )
    .bind(tenant)
    .fetch_all(&mut *tx)
    .await?;
    let senders: Vec<(String, String)> =
        sqlx::query_as("select sender, kind from comms_mail_sender where tenant_id = $1").bind(tenant).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let senders = Senders {
        allow: senders.iter().filter(|s| s.1 == "allow").map(|s| s.0.clone()).collect(),
        block: senders.iter().filter(|s| s.1 == "block").map(|s| s.0.clone()).collect(),
    };
    let mut looked = 0;
    for (mailbox, user, email, account, state, notify, blob, failures, known) in rows {
        if started.elapsed() >= budget {
            break;
        }
        let (Ok(user), Some(account)) = (user.parse::<Uuid>(), account) else { continue };
        let mut tx = k.db.tenant_tx(tenant).await?;
        let secret = k.secret(&mut tx, tenant, "HostedMailbox", mailbox, "secret").await?;
        tx.commit().await?;
        let Some(secret) = secret else { continue };
        let owner = Owner { k, url: url.clone(), auth: hosted::basic(&email, &secret) };
        let cur = Cursor { state: state.clone(), notify: Notify::from_word(notify.as_deref().unwrap_or("all")), script_blob: blob };
        looked += 1;
        match look(&owner, &account, std::slice::from_ref(&email), &cur, &senders, util::now()).await {
            Ok(found) => {
                for id in &found.calendar {
                    if let Err(e) = itip::from_message(k, tenant, &owner, &account, id, &email).await {
                        tracing::warn!(%tenant, %mailbox, "a calendar message was not applied: {e}");
                    }
                }
                if let Err(e) = commit(k, tenant, mailbox, user, &account, state.as_deref(), known, &cur, &found).await {
                    tracing::warn!(%tenant, %mailbox, "new mail not recorded: {e}");
                }
            }
            Err(Refusal::Busy) => {}
            Err(r) => {
                let n = failures.unwrap_or(0) + 1;
                tracing::warn!(%tenant, %mailbox, failures = n, "new mail not looked at: {:?}", match &r { Refusal::Failed(e) => e.as_str(), _ => "sign-in refused" });
                fail(k, tenant, mailbox, &account, n).await?;
                // As webmail does: a refused password is replaced (once, not on every retry).
                if r == Refusal::SignIn && n == 1 {
                    let _ = hosted::renew(k, tenant, mailbox).await;
                }
            }
        }
    }
    Ok(looked)
}

/// Moves the cursor from `old` to what `found` saw and, in the same transaction, notifies. When
/// another replica moved it first, nothing is stored or sent.
#[allow(clippy::too_many_arguments)]
async fn commit(k: &Kernel, tenant: Uuid, mailbox: Uuid, user: Uuid, account: &str, old: Option<&str>, known: bool, cur: &Cursor, found: &Look) -> Result<()> {
    let notify = found.notify.unwrap_or(cur.notify).word();
    let blob = if found.notify.is_some() { found.script_blob.clone() } else { cur.script_blob.clone() };
    let mut tx = k.db.tenant_tx(tenant).await?;
    let moved = if known {
        sqlx::query(
            "update comms_mail_cursor set email_state = $3, account_id = $4, notify = $5, script_blob = $6, failures = 0, retry_at = null, checked_at = now() \
             where tenant_id = $1 and mailbox_id = $2 and email_state is not distinct from $7",
        )
        .bind(tenant)
        .bind(mailbox)
        .bind(&found.state)
        .bind(account)
        .bind(notify)
        .bind(&blob)
        .bind(old)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    } else {
        sqlx::query(
            "insert into comms_mail_cursor (tenant_id, mailbox_id, account_id, email_state, notify, script_blob, checked_at) values ($1, $2, $3, $4, $5, $6, now()) \
             on conflict (tenant_id, mailbox_id) do nothing",
        )
        .bind(tenant)
        .bind(mailbox)
        .bind(account)
        .bind(&found.state)
        .bind(notify)
        .bind(&blob)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    if moved == 0 {
        return Ok(());
    }
    if !found.news.is_empty() && old.is_some() {
        let (title, line) = wording(&found.news);
        let notice = Uuid::now_v7();
        let one = (found.news.len() == 1).then(|| found.news[0].id.clone());
        sqlx::query("insert into comms_mail_notice (tenant_id, id, user_id, account_id, email_id, folder) values ($1, $2, $3, $4, $5, $6)")
            .bind(tenant)
            .bind(notice)
            .bind(user)
            .bind(account)
            .bind(&one)
            .bind(&found.inbox)
            .execute(&mut *tx)
            .await?;
        notify::send_kind(&mut tx, tenant, user, "comms.newmail", "inapp", &title, Some(&line), Some("MailMessage"), Some(notice)).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// A mailbox that failed waits before it is looked at again.
async fn fail(k: &Kernel, tenant: Uuid, mailbox: Uuid, account: &str, failures: i32) -> Result<()> {
    let retry = util::now() + backoff(failures);
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query(
        "insert into comms_mail_cursor (tenant_id, mailbox_id, account_id, failures, retry_at, checked_at) values ($1, $2, $3, $4, $5, now()) \
         on conflict (tenant_id, mailbox_id) do update set failures = excluded.failures, retry_at = excluded.retry_at, checked_at = now()",
    )
    .bind(tenant)
    .bind(mailbox)
    .bind(account)
    .bind(failures)
    .bind(retry)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// `GET /mail/notice/{id}`: what a new-mail notification of the signed-in person opens.
pub(crate) async fn notice(k: &Kernel, tenant: Uuid, user: Uuid, id: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("select account_id, email_id, folder from comms_mail_notice where tenant_id = $1 and id = $2 and user_id = $3")
            .bind(tenant)
            .bind(id)
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    let (account, email, folder) = row.ok_or_else(|| Error::NotFound("notification".into()))?;
    Ok(json!({"account": account, "email": email, "folder": folder}))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// A mail server that answers each request with the next canned answer (per method, in order of
    /// the calls in the request) and records what it was asked.
    #[derive(Default)]
    pub(crate) struct Fake {
        pub answers: Mutex<VecDeque<std::result::Result<Vec<Value>, Refusal>>>,
        pub asked: Mutex<Vec<Value>>,
        pub blobs: Vec<(String, Vec<u8>)>,
    }

    impl Fake {
        pub(crate) fn new(answers: Vec<std::result::Result<Vec<Value>, Refusal>>) -> Fake {
            Fake { answers: Mutex::new(answers.into()), ..Default::default() }
        }
        pub(crate) fn methods(&self) -> Vec<String> {
            self.asked
                .lock()
                .unwrap()
                .iter()
                .flat_map(|r| r.as_array().cloned().unwrap_or_default())
                .map(|c| c[0].as_str().unwrap_or_default().to_string())
                .collect()
        }
        fn sets(&self) -> Vec<Value> {
            self.asked
                .lock()
                .unwrap()
                .iter()
                .flat_map(|r| r.as_array().cloned().unwrap_or_default())
                .filter(|c| c[0] == "Email/set")
                .map(|c| c[1]["update"].clone())
                .collect()
        }
    }

    #[async_trait]
    impl Mail for Fake {
        async fn call(&self, calls: Value) -> std::result::Result<Vec<Value>, Refusal> {
            self.asked.lock().unwrap().push(calls);
            self.answers.lock().unwrap().pop_front().unwrap_or_else(|| Err(Refusal::Failed("unexpected request".into())))
        }
        async fn download(&self, _account: &str, blob: &str, _max: usize) -> std::result::Result<Vec<u8>, Refusal> {
            self.blobs.iter().find(|(b, _)| b == blob).map(|(_, d)| d.clone()).ok_or(Refusal::Failed("no blob".into()))
        }
    }

    fn boxes(snoozed: u64) -> Value {
        json!(["Mailbox/get", {"list": [
            {"id": "I", "role": "inbox", "name": "Inbox", "parentId": null, "totalEmails": 40},
            {"id": "J", "role": "junk", "name": "Junk Mail", "parentId": null, "totalEmails": 3},
            {"id": "S", "role": "sent", "name": "Sent Items", "parentId": null, "totalEmails": 11},
            {"id": "Z", "role": null, "name": "Snoozed", "parentId": null, "totalEmails": snoozed},
        ]}, "b"])
    }

    fn msg(id: &str, boxes: &[&str], from: (&str, &str), subject: &str, at: &str, kw: Value) -> Value {
        json!({"id": id, "threadId": format!("t{id}"), "mailboxIds": boxes.iter().map(|b| (b.to_string(), json!(true))).collect::<serde_json::Map<_, _>>(),
               "keywords": kw, "from": [{"name": from.0, "email": from.1}], "subject": subject, "receivedAt": at, "attachments": []})
    }

    fn changes(new: &str, more: bool, created: Vec<Value>) -> Vec<Value> {
        vec![
            json!(["Email/changes", {"newState": new, "hasMoreChanges": more, "created": created.iter().map(|m| m["id"].clone()).collect::<Vec<_>>()}, "c"]),
            json!(["Email/get", {"list": created}, "g"]),
        ]
    }

    fn cursor(state: Option<&str>, notify: Notify) -> Cursor {
        Cursor { state: state.map(String::from), notify, script_blob: Some("blob1".into()) }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 12, 9, 0, 0).unwrap()
    }

    const ME: &str = "omar@demo.test";

    #[tokio::test]
    async fn the_first_look_remembers_where_the_mailbox_is_and_notifies_about_nothing_old() {
        let script = b"require [\"fileinto\"];\n# ferrum: {\"v\":1,\"prefs\":{\"notify\":\"people\"}}\n".to_vec();
        let fake = Fake {
            blobs: vec![("blob2".into(), script)],
            ..Fake::new(vec![
                Ok(vec![boxes(0), json!(["Email/get", {"state": "s9", "list": []}, "s"])]),
                Ok(vec![
                    json!(["SieveScript/get", {"list": [{"id": "1", "name": "vacation", "blobId": "v"}, {"id": "2", "name": "ferrum-mail", "blobId": "blob2"}]}, "0"]),
                ]),
            ])
        };
        let found = look(&fake, "h", &[ME.into()], &Cursor { state: None, notify: Notify::All, script_blob: None }, &Senders::default(), now()).await.unwrap();
        assert_eq!(found.state, "s9");
        assert!(found.news.is_empty());
        assert_eq!(found.notify, Some(Notify::People), "the wave 3 setting, read from the person's Mail script");
        assert_eq!(found.script_blob.as_deref(), Some("blob2"));
        assert_eq!(fake.methods(), ["Mailbox/get", "Email/get", "SieveScript/get"]);
    }

    #[tokio::test]
    async fn new_unread_inbox_mail_from_others_notifies_newest_first() {
        let created = vec![
            msg("a", &["I"], ("Ann Lee", "ann@customer.example"), "Quote", "2026-11-12T08:58:00Z", json!({})),
            msg("b", &["I"], ("", "bob@supplier.example"), "", "2026-11-12T08:59:00Z", json!({})),
            msg("c", &["I"], ("Omar", ME), "My own", "2026-11-12T08:59:30Z", json!({})),
            msg("d", &["I"], ("Cat", "cat@x.example"), "Read already", "2026-11-12T08:57:00Z", json!({"$seen": true})),
            msg("e", &["F"], ("Dan", "dan@x.example"), "Filed by a rule", "2026-11-12T08:56:00Z", json!({})),
            msg("f", &["J"], ("Spam", "spam@x.example"), "Won", "2026-11-12T08:55:00Z", json!({})),
            msg("g", &["I"], ("Me", ME), "Draft", "2026-11-12T08:55:00Z", json!({"$draft": true})),
        ];
        let mut first = vec![boxes(0)];
        first.extend(changes("s2", false, created));
        let fake = Fake::new(vec![Ok(first), Ok(vec![json!(["SieveScript/get", {"list": [{"id": "2", "name": "ferrum-mail", "blobId": "blob1"}]}, "0"])])]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::All), &Senders::default(), now()).await.unwrap();
        assert_eq!(found.state, "s2");
        assert_eq!(found.news.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(found.news[0].name, "bob@supplier.example", "no name: the address");
        assert_eq!(found.news[0].subject, "(no subject)");
        assert_eq!(wording(&found.news), ("2 new messages".to_string(), "bob@supplier.example: (no subject)".to_string()));
        assert_eq!(wording(&found.news[1..]), ("New message from Ann Lee".to_string(), "Ann Lee: Quote".to_string()));
        assert_eq!(found.notify, Some(Notify::All), "the script did not change: the setting is the one kept, not downloaded again");
        assert_eq!(fake.methods(), ["Mailbox/get", "Email/changes", "Email/get", "SieveScript/get"]);
    }

    #[tokio::test]
    async fn many_changes_are_read_page_by_page_and_a_forgotten_state_starts_again_quietly() {
        let mut first = vec![boxes(0)];
        first.extend(changes("s2", true, vec![msg("a", &["I"], ("A", "a@x.example"), "One", "2026-11-12T08:00:00Z", json!({}))]));
        let fake = Fake::new(vec![
            Ok(first),
            Ok(changes("s3", false, vec![msg("b", &["I"], ("B", "b@x.example"), "Two", "2026-11-12T08:01:00Z", json!({}))])),
            Ok(vec![json!(["SieveScript/get", {"list": [{"id": "2", "name": "ferrum-mail", "blobId": "blob1"}]}, "0"])]),
        ]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::All), &Senders::default(), now()).await.unwrap();
        assert_eq!((found.state.as_str(), found.news.len()), ("s3", 2));

        let fake = Fake::new(vec![
            Ok(vec![boxes(0), json!(["error", {"type": "cannotCalculateChanges"}, "c"]), json!(["error", {"type": "invalidResultReference"}, "g"])]),
            Ok(vec![json!(["Email/get", {"state": "s50", "list": []}, "s"])]),
        ]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::All), &Senders::default(), now()).await.unwrap();
        assert!(found.reset && found.news.is_empty());
        assert_eq!(found.state, "s50");

        let fake = Fake::new(vec![Err(Refusal::Busy)]);
        assert_eq!(look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::All), &Senders::default(), now()).await.unwrap_err(), Refusal::Busy);
        assert_eq!(refusal(400, br#"{"type":"urn:ietf:params:jmap:error:limit","limit":"maxConcurrentRequests"}"#), Some(Refusal::Busy));
        assert_eq!(refusal(429, b""), Some(Refusal::Busy));
        assert_eq!(refusal(401, b""), Some(Refusal::SignIn));
        assert_eq!(refusal(500, b"boom"), Some(Refusal::Failed("answered 500".into())));
        assert_eq!(refusal(200, b""), None);
    }

    #[tokio::test]
    async fn the_setting_decides_who_notifies() {
        let created = || {
            vec![
                msg("a", &["I"], ("Ann", "ann@x.example"), "Hi", "2026-11-12T08:00:00Z", json!({})),
                msg("b", &["I"], ("Bob", "bob@x.example"), "Yo", "2026-11-12T08:01:00Z", json!({})),
            ]
        };
        let mut first = vec![boxes(0)];
        first.extend(changes("s2", false, created()));
        let fake = Fake::new(vec![
            Ok(first.clone()),
            Ok(vec![json!(["SieveScript/get", {"list": [{"id": "2", "name": "ferrum-mail", "blobId": "blob1"}]}, "0"])]),
            Ok(vec![json!(["Email/query", {"ids": ["x1"]}, "0"]), json!(["Email/query", {"ids": []}, "1"])]),
        ]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::People), &Senders::default(), now()).await.unwrap();
        assert_eq!(found.news.iter().map(|a| a.from.as_str()).collect::<Vec<_>>(), ["ann@x.example"], "only someone written to");
        let asked = fake.asked.lock().unwrap().last().cloned().unwrap();
        assert_eq!(asked[0][1]["filter"], json!({"inMailbox": "S", "to": "ann@x.example"}));

        let fake = Fake::new(vec![Ok(first), Ok(vec![json!(["SieveScript/get", {"list": [{"id": "2", "name": "ferrum-mail", "blobId": "blob1"}]}, "0"])])]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::Nothing), &Senders::default(), now()).await.unwrap();
        assert!(found.news.is_empty());
        assert_eq!(notify_in_script("# ferrum: {\"prefs\":{\"notify\":\"none\"}}"), Notify::Nothing);
        assert_eq!(notify_in_script("# ferrum: {broken"), Notify::All);
        assert_eq!(notify_in_script(""), Notify::All);
    }

    #[tokio::test]
    async fn the_workspace_s_senders_file_mail_and_snoozed_mail_wakes() {
        let senders = Senders { allow: ["partner.example".to_string()].into(), block: ["promo.example".to_string(), "ann@partner.example".to_string()].into() };
        assert_eq!(senders.verdict("x@mail.promo.example"), Some(true), "a domain covers its subdomains");
        assert_eq!(senders.verdict("bob@partner.example"), Some(false));
        assert_eq!(senders.verdict("ANN@partner.example"), Some(true), "the address decides before its domain");
        assert_eq!(senders.verdict("eve@example"), None);
        assert_eq!(senders.verdict("not an address"), None);
        let created = vec![
            msg("a", &["I"], ("Promo", "deals@promo.example"), "Sale", "2026-11-12T08:00:00Z", json!({})),
            msg("b", &["J"], ("Bob", "bob@partner.example"), "Contract", "2026-11-12T08:01:00Z", json!({"$junk": true})),
        ];
        let mut first = vec![boxes(2)];
        first.extend(changes("s2", false, created));
        let fake = Fake::new(vec![
            Ok(first),
            Ok(vec![json!(["Email/set", {"updated": {"a": null, "b": null}}, "0"])]),
            Ok(vec![json!(["SieveScript/get", {"list": [{"id": "2", "name": "ferrum-mail", "blobId": "blob1"}]}, "0"])]),
            Ok(vec![
                json!(["Email/query", {"ids": ["z1", "z2"]}, "q"]),
                json!(["Email/get", {"list": [{"id": "z1", "keywords": {"$ferrum_wake_202611120830": true, "$seen": true}}, {"id": "z2", "keywords": {"$ferrum_wake_202611121800": true}}]}, "g"]),
            ]),
            Ok(vec![json!(["Email/set", {"updated": {"z1": null}}, "0"])]),
        ]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::All), &senders, now()).await.unwrap();
        assert_eq!((found.filed, found.woke), (2, 1));
        assert_eq!(found.news.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["b"], "the blocked one is not announced; the allowed one is");
        let sets = fake.sets();
        assert_eq!(sets[0]["a"], json!({"mailboxIds/I": null, "mailboxIds/J": true, "keywords/$junk": true, "keywords/$notjunk": null}));
        assert_eq!(sets[0]["b"], json!({"mailboxIds/J": null, "mailboxIds/I": true, "keywords/$junk": null, "keywords/$notjunk": true}));
        assert_eq!(
            sets[1],
            json!({"z1": {"mailboxIds/Z": null, "mailboxIds/I": true, "keywords/$seen": null, "keywords/$ferrum_wake_202611120830": null}}),
            "only the one due"
        );
        assert_eq!(wake_of(&json!({"$ferrum_wake_202611120830": true})).map(|w| w.1), Some(Utc.with_ymd_and_hms(2026, 11, 12, 8, 30, 0).unwrap()));
        assert_eq!(wake_of(&json!({"$ferrum_wake_2026": true})), None);
        assert_eq!((backoff(1).num_minutes(), backoff(3).num_minutes(), backoff(30).num_minutes()), (2, 8, 360));
    }

    #[tokio::test]
    async fn calendar_mail_is_picked_out_for_the_calendar() {
        let mut reply = msg("r", &["I"], ("Bob", "bob@out.example"), "Accepted: Review", "2026-11-12T08:00:00Z", json!({}));
        reply["attachments"] = json!([{"type": "text/calendar; method=REPLY"}]);
        let mut done =
            msg("d", &["I"], ("Bob", "bob@out.example"), "Accepted: Old", "2026-11-12T07:00:00Z", json!({"$seen": true, "ferrum-rsvp-applied": true}));
        done["attachments"] = json!([{"type": "text/calendar"}]);
        let mut first = vec![boxes(0)];
        first.extend(changes("s2", false, vec![reply, done]));
        let fake = Fake::new(vec![Ok(first), Ok(vec![json!(["SieveScript/get", {"list": []}, "0"])])]);
        let found = look(&fake, "h", &[ME.into()], &cursor(Some("s1"), Notify::All), &Senders::default(), now()).await.unwrap();
        assert_eq!(found.calendar, ["r"]);
        assert_eq!(found.notify, Some(Notify::All), "no Mail script: everything notifies");
    }
}
