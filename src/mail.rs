//! Outgoing mail and the communication log.
//!
//! Creating an outgoing Email communication queues it: status Queued, a Message-ID, threading
//! headers from the message it answers, the sending account. After commit [`MailSink`] sends it.
//! Each send first claims the row (Queued → Sending) in a transaction of its own, so redelivered
//! events and concurrent workers never send twice, and records the outcome afterwards. A crash
//! between the SMTP handover and that record leaves the row in Sending; maintenance queues it
//! again after ten minutes, so a crash at that exact point can send a message twice — at most
//! once more per crash. Transient failures (timeouts, 4xx replies) retry with backoff until the
//! tenant's `max_send_attempts`; permanent ones (5xx replies, bad addresses) fail at once.

use crate::account::{self, Account, Security, Server};
use crate::template;
use crate::util::{self, File, id, int, s};
use async_trait::async_trait;
use ferrum_kernel::outbox::Event;
use ferrum_kernel::{Access, Action, Ctx, Doc, DocHook, Error, EventSink, FieldError, HookCtx, Kernel, Result, Tx, notify};
use lettre::message::header::{ContentType, HeaderName, HeaderValue};
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde_json::{Map, Value, json};
use sqlx::{Postgres, QueryBuilder};
use std::sync::LazyLock;
use std::time::Duration;
use uuid::Uuid;

/// SMTP command timeout; the whole handover is bounded by twice that.
const SMTP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RECIPIENTS: usize = 100;
/// Fields that record what was sent or received; they cannot change once the mail left or arrived.
const SENT_FIELDS: &[&str] = &[
    "subject",
    "channel",
    "direction",
    "email_account",
    "recipients",
    "cc",
    "bcc",
    "content",
    "text_content",
    "attachments",
    "communication_date",
    "reply_to",
];

// ───────────────────────────── addresses and MIME ─────────────────────────────

/// Splits an address list on commas, semicolons and line breaks outside quotes and `<...>`.
fn split_addresses(v: &str) -> Vec<&str> {
    let (mut out, mut start, mut quoted, mut angle) = (Vec::new(), 0, false, false);
    for (i, c) in v.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '<' if !quoted => angle = true,
            '>' if !quoted => angle = false,
            ',' | ';' | '\n' | '\r' if !quoted && !angle => {
                out.push(&v[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&v[start..]);
    out.into_iter().map(str::trim).filter(|p| !p.is_empty()).collect()
}

/// Parses a list of addresses (`a@b.test, "Rao, Priya" <p@x.test>`; `;` separates too).
pub fn mailboxes(v: Option<&str>) -> std::result::Result<Vec<Mailbox>, String> {
    let mut out = Vec::new();
    for part in split_addresses(v.unwrap_or_default()) {
        out.push(part.parse::<Mailbox>().map_err(|_| format!("'{part}' is not a valid email address"))?);
    }
    Ok(out)
}

fn join(list: &[Mailbox]) -> String {
    list.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
}

/// A recipients value from JSON: a string or a list of strings.
fn recipients_value(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(a)) => Some(a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")),
        _ => None,
    }
}

pub struct Outgoing {
    pub from: Mailbox,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub bcc: Vec<Mailbox>,
    pub subject: String,
    pub html: String,
    pub text: String,
    /// Without angle brackets.
    pub message_id: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<File>,
    /// iCalendar invitation: (METHOD, text).
    pub ics: Option<(String, String)>,
    pub headers: Vec<(String, String)>,
}

fn ctype(v: &str) -> ContentType {
    ContentType::parse(v).unwrap_or(ContentType::parse("application/octet-stream").expect("valid content type"))
}

/// Builds the MIME message: multipart/alternative (text, HTML and an iCalendar part for
/// invitations) inside multipart/mixed when there are attachments.
pub fn build(o: Outgoing) -> std::result::Result<Message, String> {
    let mut alt = MultiPart::alternative().singlepart(SinglePart::plain(o.text)).singlepart(SinglePart::html(o.html));
    if let Some((method, ics)) = &o.ics {
        alt = alt.singlepart(SinglePart::builder().header(ctype(&format!("text/calendar; charset=utf-8; method={method}"))).body(ics.clone()));
    }
    let body = if o.attachments.is_empty() && o.ics.is_none() {
        alt
    } else {
        let mut mixed = MultiPart::mixed().multipart(alt);
        if let Some((_, ics)) = &o.ics {
            mixed = mixed.singlepart(Attachment::new("invite.ics".into()).body(ics.clone(), ctype("application/ics")));
        }
        for a in o.attachments {
            mixed = mixed.singlepart(Attachment::new(a.file_name).body(a.data, ctype(&a.content_type)));
        }
        mixed
    };
    let mut b = Message::builder().from(o.from).subject(o.subject).message_id(Some(format!("<{}>", o.message_id)));
    for m in o.to {
        b = b.to(m);
    }
    for m in o.cc {
        b = b.cc(m);
    }
    for m in o.bcc {
        b = b.bcc(m);
    }
    if let Some(r) = o.in_reply_to {
        b = b.in_reply_to(format!("<{r}>"));
    }
    if !o.references.is_empty() {
        b = b.references(o.references.iter().map(|r| format!("<{r}>")).collect::<Vec<_>>().join(" "));
    }
    for (k, v) in o.headers {
        let name = HeaderName::new_from_ascii(k).map_err(|e| e.to_string())?;
        b = b.raw_header(HeaderValue::new(name, v));
    }
    b.multipart(body).map_err(|e| e.to_string())
}

#[derive(Debug)]
pub struct SendError {
    pub permanent: bool,
    pub message: String,
}

impl SendError {
    fn permanent(m: impl Into<String>) -> Self {
        SendError { permanent: true, message: m.into() }
    }
    fn transient(m: impl Into<String>) -> Self {
        SendError { permanent: false, message: m.into() }
    }
}

/// Hands a message to an SMTP server.
pub async fn smtp_send(server: &Server, message: &Message) -> std::result::Result<(), SendError> {
    let builder = match server.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&server.host),
        Security::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&server.host),
        Security::None => Ok(AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&server.host)),
    };
    let mut builder = builder.map_err(|e| SendError::permanent(format!("SMTP: {e}")))?.port(server.port).timeout(Some(SMTP_TIMEOUT));
    if let Some(user) = &server.username {
        builder = builder.credentials(Credentials::new(user.clone(), server.password.clone().unwrap_or_default()));
    }
    let transport = builder.build();
    match tokio::time::timeout(SMTP_TIMEOUT * 2, transport.send(message.clone())).await {
        Err(_) => Err(SendError::transient("the SMTP server did not answer in time")),
        Ok(Err(e)) if e.is_permanent() => Err(SendError::permanent(format!("SMTP: {e}"))),
        Ok(Err(e)) => Err(SendError::transient(format!("SMTP: {e}"))),
        Ok(Ok(_)) => Ok(()),
    }
}

/// The From mailbox of an account.
pub fn from_mailbox(a: &Account) -> std::result::Result<Mailbox, String> {
    let address = a.address.parse().map_err(|_| format!("the account address {} is invalid", a.address))?;
    Ok(Mailbox::new(a.display_name.clone(), address))
}

/// HTML for display: scripts, event handlers, forms and dangerous URLs removed; a safe subset of
/// inline styles kept so mail still looks like mail.
pub fn safe_html(html: &str) -> String {
    static CLEANER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
        let mut b = ammonia::Builder::default();
        b.add_generic_attributes(["style", "align", "valign", "width", "height", "bgcolor", "border", "cellpadding", "cellspacing", "colspan", "rowspan"])
            .filter_style_properties(
                [
                    "color",
                    "background-color",
                    "font-family",
                    "font-size",
                    "font-style",
                    "font-weight",
                    "text-align",
                    "text-decoration",
                    "line-height",
                    "margin",
                    "margin-top",
                    "margin-bottom",
                    "margin-left",
                    "margin-right",
                    "padding",
                    "padding-top",
                    "padding-bottom",
                    "padding-left",
                    "padding-right",
                    "border",
                    "border-collapse",
                    "width",
                    "max-width",
                    "height",
                    "vertical-align",
                    "white-space",
                ]
                .into_iter()
                .collect(),
            )
            .link_rel(Some("noopener noreferrer nofollow"));
        b
    });
    CLEANER.clean(html).to_string()
}

fn ics_method(ics: &str) -> String {
    crate::ics::unfold(ics).iter().find_map(|l| l.strip_prefix("METHOD:").map(|m| m.trim().to_ascii_uppercase())).unwrap_or_else(|| "REQUEST".into())
}

// ───────────────────────────── the communication hook ─────────────────────────────

fn is_outgoing_email(doc: &Doc) -> bool {
    s(doc, "channel") == Some("Email") && s(doc, "direction") != Some("Received")
}

/// The company of the record a mail is sent from, to pick that company's account.
async fn reference_company(hc: &mut HookCtx<'_>, doc: &Doc) -> Option<Uuid> {
    let (e, r) = (s(doc, "reference_entity")?, id(doc, "reference_id")?);
    hc.ctx.schema.entity(e)?.field("company")?;
    let rec = hc.kernel.get_tx(&util::sys(hc.ctx), hc.tx, e, r, false).await.ok()?;
    id(&rec, "company")
}

pub struct CommunicationHook;

#[async_trait]
impl DocHook for CommunicationHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        // Attachments from users: files they may read, listed with their names and sizes.
        if !hc.ctx.is_system && doc.get("attachments").is_some_and(|v| !v.is_null()) {
            let stored: Option<Value> = match id(doc, "id").filter(|_| doc.contains_key("created_at")) {
                Some(c) => sqlx::query_scalar("select attachments from e_communication where tenant_id = $1 and id = $2")
                    .bind(hc.ctx.tenant)
                    .bind(c)
                    .fetch_optional(&mut **hc.tx)
                    .await?
                    .flatten(),
                None => None,
            };
            if stored.as_ref() != doc.get("attachments") {
                let list = util::check_files(hc.kernel, hc.tx, hc.ctx, doc.get("attachments")).await?;
                doc.insert("attachments".into(), list);
            }
        }
        if doc.contains_key("created_at") {
            return Ok(());
        }
        let set = |doc: &mut Doc, k: &str, v: Value| {
            doc.insert(k.to_string(), v);
        };
        if s(doc, "communication_date").is_none() {
            set(doc, "communication_date", json!(util::ts(util::now())));
        }
        // A copy of mail sent from elsewhere (filed from a hosted mailbox): a record, never sent again.
        if hc.ctx.is_system && s(doc, "channel") == Some("Email") && s(doc, "status") == Some("Sent") {
            return Ok(());
        }
        if s(doc, "channel") == Some("Email") && s(doc, "direction") == Some("Received") {
            if s(doc, "status").is_none() {
                set(doc, "status", json!("Received"));
            }
            return Ok(());
        }
        if !is_outgoing_email(doc) {
            return Ok(());
        }
        // Threading: answer the message `reply_to` points at.
        if let Some(parent) = id(doc, "reply_to")
            && let Ok(p) = hc.kernel.get_tx(&util::sys(hc.ctx), hc.tx, "Communication", parent, false).await
        {
            if let Some(mid) = s(&p, "message_id") {
                let mut refs: Vec<String> = s(&p, "mail_references").unwrap_or_default().split_whitespace().map(str::to_string).collect();
                refs.push(mid.to_string());
                let keep = refs.len().saturating_sub(20);
                set(doc, "in_reply_to", json!(mid));
                set(doc, "mail_references", json!(refs[keep..].join(" ")));
                set(doc, "thread_key", json!(s(&p, "thread_key").unwrap_or(mid)));
            }
            if s(doc, "reference_entity").is_none() {
                set(doc, "reference_entity", p.get("reference_entity").cloned().unwrap_or(Value::Null));
                set(doc, "reference_id", p.get("reference_id").cloned().unwrap_or(Value::Null));
            }
            if s(doc, "subject").is_none() {
                let subject = s(&p, "subject").unwrap_or_default();
                let re = if subject.to_lowercase().starts_with("re:") { subject.to_string() } else { format!("Re: {subject}") };
                set(doc, "subject", json!(util::cut(&re, 990)));
            }
        }
        let account_id = match id(doc, "email_account") {
            Some(a) => Some(a),
            None => {
                let company = reference_company(hc, doc).await;
                account::default_outgoing(hc.tx, hc.ctx.tenant, company).await?
            }
        };
        set(doc, "email_account", json!(account_id.map(|a| a.to_string())));
        let account = match account_id {
            Some(a) => account::load(hc.kernel, hc.tx, hc.ctx.tenant, a).await?,
            None => None,
        };
        let domain = account.as_ref().map(|a| a.domain().to_string()).unwrap_or_else(|| "ferrum.local".into());
        if !(hc.ctx.is_system && s(doc, "message_id").is_some()) {
            set(doc, "message_id", json!(format!("{}@{domain}", Uuid::now_v7().simple())));
        }
        if s(doc, "thread_key").is_none() {
            let mid = doc.get("message_id").cloned().unwrap_or(Value::Null);
            set(doc, "thread_key", mid);
        }
        set(doc, "sender", json!(account.as_ref().map(|a| a.address.clone())));
        set(doc, "sender_name", json!(account.as_ref().and_then(|a| a.display_name.clone())));
        // The stored content is what recipients get: the account's signature is part of it.
        if let Some(sig) = account.as_ref().and_then(|a| a.signature.clone())
            && !hc.ctx.is_system
        {
            let content = s(doc, "content")
                .map(str::to_string)
                .unwrap_or_else(|| s(doc, "text_content").map(mail_parser::decoders::html::text_to_html).unwrap_or_default());
            set(doc, "content", json!(format!("{content}<br><br>{sig}")));
        }
        for (k, v) in [("status", json!("Queued")), ("attempts", json!(0)), ("next_attempt_at", Value::Null), ("error", Value::Null), ("sent_at", Value::Null)]
        {
            set(doc, k, v);
        }
        for f in ["recipients", "cc", "bcc"] {
            if let Ok(list) = mailboxes(s(doc, f)) {
                set(doc, f, if list.is_empty() { Value::Null } else { json!(join(&list)) });
            }
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        let outgoing = is_outgoing_email(doc);
        if outgoing {
            let mut count = 0;
            for f in ["recipients", "cc", "bcc"] {
                match mailboxes(s(doc, f)) {
                    Ok(l) => count += l.len(),
                    Err(m) => errors.push(FieldError::new(f, m)),
                }
            }
            if count == 0 && errors.is_empty() {
                errors.push(FieldError::new("recipients", "add at least one recipient"));
            }
            if count > MAX_RECIPIENTS {
                errors.push(FieldError::new("recipients", format!("at most {MAX_RECIPIENTS} recipients per message")));
            }
            if s(doc, "content").is_none() && s(doc, "text_content").is_none() && util::attachment_ids(doc.get("attachments")).is_empty() {
                errors.push(FieldError::new("content", "write a message"));
            }
        }
        match (s(doc, "reference_entity"), s(doc, "reference_id")) {
            (None, None) => {}
            (Some(e), Some(r)) => {
                if hc.ctx.schema.entity(e).is_none() {
                    errors.push(FieldError::new("reference_entity", format!("{e} is not an installed entity")));
                } else if r.parse::<Uuid>().is_err() {
                    errors.push(FieldError::new("reference_id", "must be a record id"));
                }
            }
            _ => errors.push(FieldError::new("reference_id", "set both the entity and the record, or neither")),
        }
        if !errors.is_empty() {
            return Err(Error::Validation(errors));
        }
        if !hc.ctx.is_system && !doc.contains_key("created_at") {
            check_user_input(hc, doc, None).await?;
        }
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
        if let Some(old) = old
            && !hc.ctx.is_system
        {
            if old.get("channel") != doc.get("channel") || old.get("direction") != doc.get("direction") {
                return Err(Error::invalid("the channel and direction of a communication cannot change"));
            }
            if s(old, "channel") == Some("Email") && !matches!(s(old, "status"), None | Some("Queued") | Some("Failed")) {
                for f in SENT_FIELDS {
                    if old.get(*f) != doc.get(*f) {
                        return Err(Error::invalid(format!(
                            "this email was already {}; only Seen and the linked record can change",
                            s(old, "status").unwrap_or("sent").to_lowercase()
                        )));
                    }
                }
            }
            check_user_input(hc, doc, Some(old)).await?;
        }
        // Uploads attached to nothing yet join the record the mail is about (or the mail itself),
        // so they list with it and follow its access rules.
        let owner = match (s(doc, "reference_entity"), id(doc, "reference_id")) {
            (Some(e), Some(r)) => (e.to_string(), r),
            _ => ("Communication".to_string(), util::doc_id(doc)?),
        };
        util::attach_files(hc.tx, hc.ctx.tenant, doc.get("attachments"), &owner.0, owner.1).await
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        if name != "retry" {
            return Ok(None);
        }
        if s(doc, "status") != Some("Failed") {
            return Err(Error::invalid("only failed emails can be retried"));
        }
        let comm = util::doc_id(doc)?;
        let mut values = Doc::new();
        for (k, v) in [("status", json!("Queued")), ("attempts", json!(0)), ("next_attempt_at", Value::Null), ("error", Value::Null)] {
            values.insert(k.into(), v);
        }
        hc.kernel.set_values_tx(hc.ctx, hc.tx, "Communication", comm, values.clone()).await?;
        let mut queued = doc.clone();
        queued.extend(values);
        let payload =
            json!({"entity": "Communication", "id": comm, "event": "updated", "actor": (!hc.ctx.user.is_nil()).then_some(hc.ctx.user), "doc": queued});
        ferrum_kernel::outbox::enqueue(hc.tx, hc.ctx.tenant, "Communication.updated", Some("Communication"), Some(comm), payload).await?;
        Ok(Some(json!({"status": "Queued"})))
    }
}

/// What a user (not the engine) may write: on records they can read, replying to what they can
/// see, from accounts of their companies, with attachments they uploaded. On updates only the
/// changed parts are checked.
async fn check_user_input(hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
    let changed = |f: &str| old.is_none_or(|o| o.get(f) != doc.get(f));
    if old.is_none() && s(doc, "channel") == Some("Email") && s(doc, "direction") == Some("Received") {
        return Err(Error::Forbidden("received mail is recorded by the mail importer".into()));
    }
    if changed("reference_entity") || changed("reference_id") {
        if old.is_some_and(|o| s(o, "channel") == Some("Email") && !matches!(s(o, "status"), None | Some("Queued") | Some("Failed")))
            && hc.ctx.perms.access("Communication", Action::Write) != Access::All
        {
            return Err(Error::Forbidden("only communication managers can move a received or sent email to another record".into()));
        }
        if let (Some(e), Some(r)) = (s(doc, "reference_entity"), id(doc, "reference_id"))
            && hc.kernel.get_tx(hc.ctx, hc.tx, e, r, false).await.is_err()
        {
            return Err(Error::field("reference_id", "the record does not exist or you cannot access it"));
        }
    }
    if changed("reply_to")
        && let Some(parent) = id(doc, "reply_to")
        && !visible(hc.kernel, hc.ctx, hc.tx, parent).await?
    {
        return Err(Error::field("reply_to", "that message does not exist or you cannot see it"));
    }
    if is_outgoing_email(doc)
        && changed("email_account")
        && let Some(a) = id(doc, "email_account")
    {
        let acc = account::load(hc.kernel, hc.tx, hc.ctx.tenant, a).await?.ok_or_else(|| Error::field("email_account", "does not exist"))?;
        if !acc.enable_outgoing {
            return Err(Error::field("email_account", format!("{} does not send mail", acc.name)));
        }
        let allowed = hc.ctx.is_admin || acc.company.is_none_or(|c| hc.ctx.scopes.get("Company").is_none_or(|ids| ids.contains(&c)));
        if !allowed {
            return Err(Error::field("email_account", "this account belongs to a company you cannot use"));
        }
    }
    Ok(())
}

/// Whether the caller may see a communication: managers see all; others what they created or
/// what is linked to a record they can read.
pub async fn visible(k: &Kernel, ctx: &Ctx, tx: &mut Tx, comm: Uuid) -> Result<bool> {
    let row: Option<(Option<Uuid>, Option<String>, Option<String>)> =
        sqlx::query_as("select created_by, reference_entity, reference_id from e_communication where tenant_id = $1 and id = $2")
            .bind(ctx.tenant)
            .bind(comm)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((created_by, entity, record)) = row else { return Ok(false) };
    if ctx.is_system || ctx.perms.access("Communication", Action::Read) == Access::All || (created_by == Some(ctx.user) && !ctx.user.is_nil()) {
        return Ok(true);
    }
    match (entity, record.and_then(|r| r.parse::<Uuid>().ok())) {
        (Some(e), Some(r)) if ctx.schema.entity(&e).is_some() => Ok(k.get_tx(ctx, tx, &e, r, false).await.is_ok()),
        _ => Ok(false),
    }
}

// ───────────────────────────── delivery ─────────────────────────────

/// Sends queued communications as their creation (or retry) events arrive.
pub struct MailSink;

#[async_trait]
impl EventSink for MailSink {
    async fn on_event(&self, k: &Kernel, ev: &Event) -> Result<()> {
        if ev.entity.as_deref() != Some("Communication") || !(ev.topic.ends_with(".created") || ev.topic.ends_with(".updated")) {
            return Ok(());
        }
        let Some(comm) = ev.record_id else { return Ok(()) };
        // Large documents travel without their body; the claim checks the row anyway.
        let (queued, account) = match ev.payload.get("doc") {
            Some(d) => (d["channel"] == json!("Email") && d["status"] == json!("Queued"), d["email_account"].as_str().and_then(|a| a.parse().ok())),
            None => (true, None),
        };
        // A worker handles its leased batch in order: while an account's server is failing, new
        // mail waits for maintenance instead of making every later event (any tenant's webhooks,
        // automations, live updates) wait out an SMTP timeout per queued message.
        if queued && !server_failing(k, ev.tenant_id, account).await? {
            deliver(k, ev.tenant_id, comm).await?;
        }
        Ok(())
    }
}

/// Whether mail of this account (or of the server's mailer) is waiting for a retry after a
/// transient failure.
async fn server_failing(k: &Kernel, tenant: Uuid, account: Option<Uuid>) -> Result<bool> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let failing: bool = sqlx::query_scalar(
        "select exists (select 1 from e_communication where tenant_id = $1 and email_account is not distinct from $2 \
         and status = 'Queued' and attempts > 0 and next_attempt_at > now())",
    )
    .bind(tenant)
    .bind(account)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(failing)
}

fn backoff_secs(attempts: i64) -> i64 {
    // 1, 4, 16, 64 minutes..., at most 6 hours.
    (60i64 << (2 * (attempts - 1).clamp(0, 6))).min(6 * 3600)
}

/// Claims and sends one queued communication; returns its new status, or `None` when it was not
/// due (already sent, claimed elsewhere or waiting for a retry).
pub async fn deliver(k: &Kernel, tenant: Uuid, comm: Uuid) -> Result<Option<String>> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<Value> = sqlx::query_scalar(
        "update e_communication c set status = 'Sending', attempts = coalesce(c.attempts, 0) + 1, version = c.version + 1, updated_at = now() \
         where c.tenant_id = $1 and c.id = $2 and c.status = 'Queued' and c.channel = 'Email' and c.direction = 'Sent' \
         and coalesce(c.next_attempt_at, '-infinity') <= now() returning to_jsonb(c)",
    )
    .bind(tenant)
    .bind(comm)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    let Some(doc) = row.map(util::obj) else { return Ok(None) };
    let mut tx = k.db.tenant_tx(tenant).await?;
    let settings = util::settings(&mut tx, tenant).await?;
    let account = match id(&doc, "email_account") {
        Some(a) => account::load(k, &mut tx, tenant, a).await?,
        None => None,
    };
    tx.commit().await?;
    let mut delivered: Vec<String> =
        doc.get("delivered_to").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    // Storage that cannot be read now is a transient failure like an unreachable server.
    let outcome = match util::load_files(k, tenant, doc.get("attachments")).await {
        Ok(files) => send_doc(k, &doc, account.as_ref(), files, &mut delivered).await,
        Err(e) => Err(SendError::transient(format!("attachments: {e}"))),
    };
    record(k, tenant, &doc, &settings, outcome, delivered).await.map(Some)
}

async fn send_doc(k: &Kernel, doc: &Doc, account: Option<&Account>, files: Vec<File>, delivered: &mut Vec<String>) -> std::result::Result<(), SendError> {
    let list = |f: &str| mailboxes(s(doc, f)).map_err(SendError::permanent);
    let (to, cc, bcc) = (list("recipients")?, list("cc")?, list("bcc")?);
    let subject = s(doc, "subject").unwrap_or_default().to_string();
    let html =
        s(doc, "content").map(str::to_string).unwrap_or_else(|| s(doc, "text_content").map(mail_parser::decoders::html::text_to_html).unwrap_or_default());
    let text = s(doc, "text_content").map(str::to_string).unwrap_or_else(|| mail_parser::decoders::html::html_to_text(&html));
    let ics = s(doc, "ics").map(|i| (ics_method(i), i.to_string()));
    match account {
        Some(acc) => {
            if !acc.enable_outgoing {
                return Err(SendError::permanent(format!("the email account {} does not send mail", acc.name)));
            }
            let server = acc.smtp.as_ref().ok_or_else(|| SendError::permanent(format!("the email account {} has no SMTP host", acc.name)))?;
            let message = build(Outgoing {
                from: from_mailbox(acc).map_err(SendError::permanent)?,
                to,
                cc,
                bcc,
                subject,
                html,
                text,
                message_id: s(doc, "message_id").map(str::to_string).unwrap_or_else(|| format!("{}@{}", Uuid::now_v7().simple(), acc.domain())),
                in_reply_to: s(doc, "in_reply_to").map(str::to_string),
                references: s(doc, "mail_references").unwrap_or_default().split_whitespace().map(str::to_string).collect(),
                attachments: files,
                ics,
                headers: vec![],
            })
            .map_err(SendError::permanent)?;
            smtp_send(server, &message).await
        }
        // No account: the server's own mailer, one simple HTML mail per recipient (it cannot carry
        // threading headers, attachments or invitations).
        None => {
            let mailer = k.mailer.as_ref().ok_or_else(|| SendError::permanent("no outgoing email account is set up and the server has no mailer"))?;
            for m in to.iter().chain(&cc).chain(&bcc) {
                let address = m.email.to_string();
                if delivered.contains(&address) {
                    continue;
                }
                mailer.send(&address, &subject, &html).await.map_err(|e| SendError::transient(e.to_string()))?;
                delivered.push(address);
            }
            Ok(())
        }
    }
}

async fn record(
    k: &Kernel,
    tenant: Uuid,
    doc: &Doc,
    settings: &util::Settings,
    outcome: std::result::Result<(), SendError>,
    delivered: Vec<String>,
) -> Result<String> {
    let comm = util::doc_id(doc)?;
    let attempts = int(doc, "attempts");
    let creator = id(doc, "created_by");
    let delivered = (!delivered.is_empty()).then(|| json!(delivered));
    let mut tx = k.db.tenant_tx(tenant).await?;
    let (status, error, retry_in): (&str, Option<String>, Option<i64>) = match outcome {
        Ok(()) => ("Sent", None, None),
        Err(e) if e.permanent || attempts >= settings.max_attempts => ("Failed", Some(e.message), None),
        Err(e) => ("Queued", Some(e.message), Some(backoff_secs(attempts))),
    };
    sqlx::query(
        "update e_communication set status = $3, error = $4, delivered_to = $5, \
         next_attempt_at = case when $6::bigint is null then null else now() + make_interval(secs => $6::bigint) end, \
         sent_at = case when $3 = 'Sent' then now() else sent_at end, version = version + 1, updated_at = now() \
         where tenant_id = $1 and id = $2 and status = 'Sending'",
    )
    .bind(tenant)
    .bind(comm)
    .bind(status)
    .bind(&error)
    .bind(&delivered)
    .bind(retry_in)
    .execute(&mut *tx)
    .await?;
    if let Some(user) = creator {
        if status == "Failed" {
            let title = format!("Email not delivered: {}", s(doc, "subject").unwrap_or("(no subject)"));
            notify::send(&mut tx, tenant, user, &util::cut(&title, 200), error.as_deref(), Some("Communication"), Some(comm)).await?;
        }
        notify::push(&mut tx, tenant, user, "mail", json!({"communication": comm, "status": status})).await?;
    }
    tx.commit().await?;
    if let Some(e) = &error {
        tracing::warn!(%tenant, communication = %comm, attempts, status, "email delivery failed: {e}");
    }
    Ok(status.to_string())
}

/// Retries due mail (within `budget`) and requeues mail stuck in Sending (a worker died mid-send).
pub async fn retry_due(k: &Kernel, tenant: Uuid, budget: Duration) -> Result<usize> {
    let started = std::time::Instant::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query(
        "update e_communication set status = 'Queued', next_attempt_at = now(), version = version + 1, updated_at = now(), \
         error = coalesce(error, 'interrupted while sending; queued again') \
         where tenant_id = $1 and status = 'Sending' and updated_at < now() - interval '10 minutes'",
    )
    .bind(tenant)
    .execute(&mut *tx)
    .await?;
    // Rows without a retry time were missed by the event sink (it runs right after commit).
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_communication where tenant_id = $1 and status = 'Queued' and channel = 'Email' and direction = 'Sent' \
         and coalesce(next_attempt_at, created_at + interval '2 minutes') <= now() order by coalesce(next_attempt_at, created_at) limit 25",
    )
    .bind(tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut n = 0;
    for comm in due {
        if started.elapsed() > budget {
            break;
        }
        if deliver(k, tenant, comm).await?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

// ───────────────────────────── endpoints ─────────────────────────────

/// `GET /accounts`: outgoing accounts the caller may send from.
pub async fn accounts(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<(Uuid, String, String, Option<String>, Option<Uuid>, bool)> = sqlx::query_as(
        "select id, account_name, email_address, display_name, company, default_outgoing from e_email_account \
         where tenant_id = $1 and enable_outgoing order by account_name",
    )
    .bind(ctx.tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let companies = ctx.scopes.get("Company");
    let list: Vec<Value> = rows
        .into_iter()
        .filter(|r| ctx.is_admin || r.4.is_none_or(|c| companies.is_none_or(|ids| ids.contains(&c))))
        .map(|(id, name, address, display, company, default)| {
            json!({"id": id, "account_name": name, "email_address": address, "display_name": display, "company": company, "default_outgoing": default})
        })
        .collect();
    Ok(json!({"accounts": list}))
}

async fn template_doc(k: &Kernel, ctx: &Ctx, key: &str) -> Result<Doc> {
    ctx.require("EmailTemplate", Action::Read)?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let found: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from e_email_template t where t.tenant_id = $1 and (t.id::text = $2 or t.template_name = $2)")
            .bind(ctx.tenant)
            .bind(key)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    let t = found.map(util::obj).ok_or_else(|| Error::NotFound(format!("email template {key}")))?;
    if util::b(&t, "disabled") {
        return Err(Error::invalid(format!("the email template {key} is disabled")));
    }
    Ok(t)
}

/// The record a mail is about, as the caller may read it, plus the template context.
async fn template_context(k: &Kernel, ctx: &Ctx, body: &Map<String, Value>) -> Result<Value> {
    let record = match (body.get("reference_entity").and_then(Value::as_str), body.get("reference_id").and_then(Value::as_str)) {
        (Some(e), Some(r)) => {
            let r: Uuid = r.parse().map_err(|_| Error::field("reference_id", "must be a record id"))?;
            Value::Object(k.get(ctx, e, r, true).await?)
        }
        _ => json!({}),
    };
    Ok(json!({"doc": record, "user": {"full_name": ctx.full_name, "email": ctx.email}, "entity": body.get("reference_entity")}))
}

/// `POST /templates/preview`: renders a saved template (`template`: id or name) or the given
/// `subject`/`body` against a record the caller can read.
pub async fn preview(k: &Kernel, ctx: &Ctx, body: Map<String, Value>) -> Result<Value> {
    let (subject, html) = match body.get("template").and_then(Value::as_str) {
        Some(key) => {
            let t = template_doc(k, ctx, key).await?;
            (s(&t, "subject").unwrap_or_default().to_string(), s(&t, "body").unwrap_or_default().to_string())
        }
        None => (
            body.get("subject").and_then(Value::as_str).unwrap_or_default().to_string(),
            body.get("body").and_then(Value::as_str).unwrap_or_default().to_string(),
        ),
    };
    let c = template_context(k, ctx, &body).await?;
    Ok(json!({"subject": template::render_subject(&subject, &c)?, "html": template::render_html(&html, &c)?}))
}

/// `POST /send`: logs a communication on a record the caller can read; outgoing email is queued
/// and sent right after the request. `template` fills a missing subject/content.
pub async fn send(k: &Kernel, ctx: &Ctx, body: Map<String, Value>) -> Result<Value> {
    ctx.require("Communication", Action::Create)?;
    let mut subject = body.get("subject").and_then(Value::as_str).map(str::to_string).filter(|v| !v.trim().is_empty());
    let mut content = body.get("content").and_then(Value::as_str).map(str::to_string).filter(|v| !v.trim().is_empty());
    let c = template_context(k, ctx, &body).await?;
    if let Some(key) = body.get("template").and_then(Value::as_str) {
        let t = template_doc(k, ctx, key).await?;
        if subject.is_none() {
            subject = Some(template::render_subject(s(&t, "subject").unwrap_or_default(), &c)?);
        }
        if content.is_none() {
            content = Some(template::render_html(s(&t, "body").unwrap_or_default(), &c)?);
        }
    }
    let mut doc = Doc::new();
    doc.insert("channel".into(), body.get("channel").cloned().unwrap_or(json!("Email")));
    doc.insert("direction".into(), body.get("direction").cloned().unwrap_or(json!("Sent")));
    doc.insert("subject".into(), json!(subject));
    doc.insert("content".into(), json!(content));
    for (k, v) in [("recipients", "to"), ("cc", "cc"), ("bcc", "bcc")] {
        doc.insert(k.into(), json!(recipients_value(body.get(v).or(body.get(k)))));
    }
    for f in ["text_content", "email_account", "reference_entity", "reference_id", "reply_to", "attachments", "communication_date"] {
        if let Some(v) = body.get(f) {
            doc.insert(f.into(), v.clone());
        }
    }
    Ok(present(ctx, k.insert(ctx, "Communication", doc).await?, true))
}

/// A communication for display: HTML sanitized, Bcc only for its author and managers.
pub fn present(ctx: &Ctx, mut doc: Doc, full: bool) -> Value {
    let html = s(&doc, "content").map(safe_html);
    let author = id(&doc, "created_by") == Some(ctx.user) || ctx.perms.access("Communication", Action::Read) == Access::All;
    if !author {
        doc.remove("bcc");
    }
    for k in ["ics", "delivered_to", "next_attempt_at", "ext"] {
        doc.remove(k);
    }
    doc.remove("content");
    doc.insert("content_html".into(), json!(html));
    if !full {
        for k in ["text_content", "mail_references", "in_reply_to"] {
            doc.remove(k);
        }
    }
    Value::Object(doc)
}

/// `GET /communications`: a record's timeline (`reference_entity` + `reference_id`), the caller's
/// own communications, or — for managers — any filtered by `email_account`, `direction`,
/// `status`, `channel`. Newest first; `cursor` continues.
pub async fn list(k: &Kernel, ctx: &Ctx, q: &Map<String, Value>) -> Result<Value> {
    let get = |key: &str| q.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
    let limit = get("limit").and_then(|l| l.parse::<i64>().ok()).unwrap_or(50).clamp(1, 100);
    let manager = ctx.perms.access("Communication", Action::Read) == Access::All;
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("select to_jsonb(c) from e_communication c where c.tenant_id = ");
    qb.push_bind(ctx.tenant);
    match (get("reference_entity"), get("reference_id")) {
        (Some(e), Some(r)) => {
            let r: Uuid = r.parse().map_err(|_| Error::field("reference_id", "must be a record id"))?;
            k.get(ctx, e, r, false).await?;
            qb.push(" and c.reference_entity = ").push_bind(e.to_string()).push(" and c.reference_id = ").push_bind(r.to_string());
        }
        _ if manager && get("mine").is_none() => {}
        _ => {
            qb.push(" and c.created_by = ").push_bind(ctx.user);
        }
    }
    for f in ["direction", "status", "channel", "thread_key"] {
        if let Some(v) = get(f) {
            qb.push(format!(" and c.{f} = ")).push_bind(v.to_string());
        }
    }
    if let Some(a) = get("email_account") {
        let a: Uuid = a.parse().map_err(|_| Error::field("email_account", "must be an id"))?;
        qb.push(" and c.email_account = ").push_bind(a);
    }
    if let Some(c) = get("cursor") {
        let (t, cid) = ferrum_kernel::query::decode_cursor(c)?;
        let t = util::parse_ts(&t).ok_or_else(|| Error::invalid("bad cursor"))?;
        qb.push(" and (c.communication_date, c.id) < (").push_bind(t).push(", ").push_bind(cid).push(")");
    }
    qb.push(" order by c.communication_date desc, c.id desc limit ").push_bind(limit + 1);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<Value> = qb.build_query_scalar().fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let more = rows.len() as i64 > limit;
    let docs: Vec<Doc> = rows.into_iter().take(limit as usize).map(util::obj).map(normalize_row).collect();
    let next = if more { docs.last().and_then(|d| Some(ferrum_kernel::query::encode_cursor(s(d, "communication_date")?, s(d, "id")?))) } else { None };
    Ok(json!({"communications": docs.into_iter().map(|d| present(ctx, d, false)).collect::<Vec<_>>(), "next_cursor": next}))
}

/// Raw rows (`to_jsonb`) use Postgres' date-time text; the API uses RFC 3339 UTC.
fn normalize_row(mut d: Doc) -> Doc {
    for k in ["communication_date", "sent_at", "created_at", "updated_at"] {
        if let Some(t) = util::time(&d, k) {
            d.insert(k.into(), json!(util::ts(t)));
        }
    }
    d.remove("tenant_id");
    d
}

/// `GET /communications/{id}`.
pub async fn detail(k: &Kernel, ctx: &Ctx, comm: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    if !visible(k, ctx, &mut tx, comm).await? {
        return Err(Error::NotFound("Communication".into()));
    }
    tx.commit().await?;
    let doc = k.get(&util::sys(ctx), "Communication", comm, true).await?;
    Ok(present(ctx, doc, true))
}

/// `POST /communications/{id}/seen` `{seen}`.
pub async fn mark_seen(k: &Kernel, ctx: &Ctx, comm: Uuid, body: Map<String, Value>) -> Result<Value> {
    let seen = body.get("seen").and_then(Value::as_bool).unwrap_or(true);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    if !visible(k, ctx, &mut tx, comm).await? {
        return Err(Error::NotFound("Communication".into()));
    }
    let mut v = Doc::new();
    v.insert("seen".into(), json!(seen));
    k.set_values_tx(&util::sys(ctx), &mut tx, "Communication", comm, v).await?;
    tx.commit().await?;
    Ok(json!({"id": comm, "seen": seen}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_lists() {
        let l = mailboxes(Some("a@x.test; \"Rao, Priya\" <p@x.test>,\nb@y.test")).unwrap();
        assert_eq!(l.len(), 3);
        assert_eq!(l[1].email.to_string(), "p@x.test");
        assert_eq!(join(&l), "a@x.test, \"Rao, Priya\" <p@x.test>, b@y.test");
        assert_eq!(mailboxes(Some("not an address")).unwrap_err(), "'not an address' is not a valid email address");
        assert!(mailboxes(Some("  ")).unwrap().is_empty());
        assert_eq!(recipients_value(Some(&json!(["a@x.test", "b@x.test"]))).as_deref(), Some("a@x.test, b@x.test"));
    }

    #[test]
    fn builds_threaded_multipart_mail() {
        let msg = build(Outgoing {
            from: "Acme Sales <sales@acme.test>".parse().unwrap(),
            to: vec!["c@cust.test".parse().unwrap()],
            cc: vec![],
            bcc: vec!["hidden@acme.test".parse().unwrap()],
            subject: "Re: Quote — ünïcode".into(),
            html: "<p>Hello</p>".into(),
            text: "Hello".into(),
            message_id: "abc@acme.test".into(),
            in_reply_to: Some("orig@cust.test".into()),
            references: vec!["root@cust.test".into(), "orig@cust.test".into()],
            attachments: vec![File { file_name: "quote.pdf".into(), content_type: "application/pdf".into(), data: b"%PDF-1.4".to_vec() }],
            ics: Some(("REQUEST".into(), "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n".into())),
            headers: vec![("List-Unsubscribe".into(), "<https://x.test/u>".into())],
        })
        .unwrap();
        let raw = String::from_utf8(msg.formatted()).unwrap();
        assert!(raw.contains("Message-ID: <abc@acme.test>"));
        assert!(raw.contains("In-Reply-To: <orig@cust.test>"));
        assert!(raw.contains("References: <root@cust.test> <orig@cust.test>"));
        assert!(raw.contains("List-Unsubscribe: <https://x.test/u>"));
        assert!(raw.contains("multipart/mixed") && raw.contains("multipart/alternative"));
        assert!(raw.contains("text/calendar; charset=utf-8; method=REQUEST"));
        assert!(raw.contains("filename=\"quote.pdf\"") || raw.contains("filename=quote.pdf"));
        assert!(!raw.contains("hidden@acme.test"), "Bcc stays out of the headers");
        assert_eq!(msg.envelope().to().len(), 2, "but Bcc is in the envelope");
        // mail-parser reads it back with the same threading.
        let parsed = crate::inbound::parse_mime(raw.as_bytes()).unwrap();
        assert_eq!(parsed.message_id.as_deref(), Some("abc@acme.test"));
        assert_eq!(parsed.in_reply_to, vec!["orig@cust.test".to_string()]);
        assert_eq!(parsed.subject, "Re: Quote — ünïcode");
        // The iCalendar alternative counts as an attachment too.
        let names: Vec<&str> = parsed.attachments.iter().map(|a| a.file_name.as_str()).collect();
        assert!(names.contains(&"quote.pdf") && names.contains(&"invite.ics"), "{names:?}");
    }

    #[test]
    fn display_html_is_sanitized() {
        let dirty = r#"<p style="color:red;position:fixed" onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)><a href="https://ok.test">ok</a></p>"#;
        let clean = safe_html(dirty);
        assert!(!clean.contains("script") && !clean.contains("onclick") && !clean.contains("onerror") && !clean.contains("javascript:"));
        assert!(clean.contains("color:red") && !clean.contains("position"), "{clean}");
        assert!(clean.contains("href=\"https://ok.test\""));
        assert_eq!(backoff_secs(1), 60);
        assert_eq!(backoff_secs(3), 960);
        assert_eq!(backoff_secs(30), 6 * 3600);
        assert_eq!(ics_method("BEGIN:VCALENDAR\r\nMETHOD:cancel\r\n"), "CANCEL");
    }
}
