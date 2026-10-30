//! Hosted mail: a Stalwart mail server the operator runs holds the workspace's mailboxes. Every
//! active person whose address is in the workspace's mail domain (`CommsSettings.mail_domain`)
//! has an account there, kept in step by [`reconcile`]: made for new people, renamed when their
//! address changes, locked (a new random password nobody keeps) when they are deactivated or move
//! out of the domain, unlocked when they come back. Ferrum keeps each account's password sealed
//! (`HostedMailbox.secret`) to reach the mailbox for its owner.
//!
//! The operator turns it on with `FERRUM_MAIL_URL` (Stalwart's HTTP address as this server reaches
//! it) and `FERRUM_MAIL_ADMIN` / `FERRUM_MAIL_ADMIN_SECRET` (one of its administrators). Stalwart
//! 1.0 is administered over JMAP (`urn:stalwart:jmap`). Its open-source edition has no tenants:
//! workspaces sharing a server are kept apart by their domains, and each account carries
//! `externalId = ferrum:<workspace>:<person>`.
//
// ponytail: each reconcile pages through every account on the server; filter on the server once a
// shared server holds enough workspaces for that to matter.

use crate::groups;
use crate::util::{self, obj};
use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// How often maintenance brings a workspace's mailboxes in step.
const EVERY: Duration = Duration::from_secs(600);
const PAGE: usize = 100;

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The mail server's address, when the operator set one.
pub(crate) fn server_url() -> Option<String> {
    var("FERRUM_MAIL_URL").map(|u| u.trim_end_matches('/').to_string())
}

/// The mail server's address and an administrator's Basic credentials, when the operator set them.
fn configured() -> Option<(String, String)> {
    Some((server_url()?, basic(&var("FERRUM_MAIL_ADMIN")?, &var("FERRUM_MAIL_ADMIN_SECRET")?)))
}

pub(crate) fn basic(user: &str, password: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{user}:{password}")))
}

/// A request to the mail server signed in with `auth`: a POST of `body` (content type, bytes) or
/// a GET. Returns the status, content type and body; a body over `max` bytes is an error.
pub(crate) async fn send(k: &Kernel, url: &str, auth: &str, path: &str, body: Option<(&str, Vec<u8>)>, max: usize) -> Result<(u16, String, Vec<u8>)> {
    let url = format!("{url}{path}");
    // The operator's own server, usually beside Ferrum: private addresses allowed.
    let (client, parsed) = k.vetted_client(&url, true, Duration::from_secs(30), "Ferrum Comms").await?;
    let req = match body {
        Some((ctype, b)) => client.post(parsed).header("content-type", ctype).body(b),
        None => client.get(parsed),
    };
    let mut res = req.header("authorization", auth).send().await.map_err(unavailable)?;
    let status = res.status().as_u16();
    let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    let mut out = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(unavailable)? {
        if out.len() + chunk.len() > max {
            return Err(Error::invalid(format!("larger than {} MB", max / 1024 / 1024)));
        }
        out.extend_from_slice(&chunk);
    }
    Ok((status, ctype, out))
}

fn unavailable(e: impl std::fmt::Display) -> Error {
    Error::Unavailable(format!("the mail server: {e}"))
}

/// The mail server's administration API, signed in.
pub(crate) struct Admin {
    url: String,
    auth: String,
    account: String,
}

impl Admin {
    async fn connect(k: &Kernel) -> Result<Admin> {
        let (url, auth) = configured().ok_or_else(|| {
            Error::Unavailable("hosted mail is not set up on this server (FERRUM_MAIL_URL, FERRUM_MAIL_ADMIN, FERRUM_MAIL_ADMIN_SECRET)".into())
        })?;
        let mut admin = Admin { url, auth, account: String::new() };
        let session = admin.request(k, "/jmap/session", None).await?;
        admin.account =
            session["primaryAccounts"]["urn:stalwart:jmap"].as_str().ok_or_else(|| unavailable("FERRUM_MAIL_ADMIN is not an administrator"))?.to_string();
        Ok(admin)
    }

    async fn request(&self, k: &Kernel, path: &str, body: Option<&Value>) -> Result<Value> {
        let body = body.map(|b| ("application/json", b.to_string().into_bytes()));
        let (status, _, out) = send(k, &self.url, &self.auth, path, body, 16 << 20).await?;
        if !(200..300).contains(&status) {
            return Err(unavailable(format!("{path} answered {status}: {}", util::cut(&String::from_utf8_lossy(&out), 200))));
        }
        serde_json::from_slice(&out).map_err(unavailable)
    }

    /// One JMAP request of administration calls; their answers in order (call `i` has id `"i"`).
    pub(crate) async fn jmap(&self, k: &Kernel, calls: Vec<(&str, Value)>) -> Result<Vec<Value>> {
        let calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(i, (method, mut args))| {
                args["accountId"] = json!(self.account);
                json!([method, args, i.to_string()])
            })
            .collect();
        let out = self.request(k, "/jmap/", Some(&json!({"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": calls}))).await?;
        out["methodResponses"]
            .as_array()
            .ok_or_else(|| unavailable("no answers"))?
            .iter()
            .map(|r| if r[0] == "error" { Err(unavailable(&r[1])) } else { Ok(r[1].clone()) })
            .collect()
    }

    /// The domain's id, made when missing.
    async fn domain(&self, k: &Kernel, name: &str) -> Result<String> {
        let found = self.jmap(k, vec![("x:Domain/query", json!({"filter": {"name": name}}))]).await?;
        if let Some(id) = found[0]["ids"].get(0).and_then(Value::as_str) {
            return Ok(id.to_string());
        }
        let made = self.jmap(k, vec![("x:Domain/set", json!({"create": {"d": {"name": name}}}))]).await?;
        created(&made[0], "d")
    }

    /// The workspace's accounts: its people's and its shared mailboxes' (`groups.rs`).
    pub(crate) async fn accounts(&self, k: &Kernel, tenant: Uuid) -> Result<Accounts> {
        let prefix = format!("ferrum:{tenant}:");
        let mut out = Accounts::default();
        let mut position = 0;
        loop {
            let r = self
                .jmap(
                    k,
                    vec![
                        ("x:Account/query", json!({"position": position, "limit": PAGE})),
                        (
                            "x:Account/get",
                            json!({"#ids": {"resultOf": "0", "name": "x:Account/query", "path": "/ids"},
                                   "properties": ["externalId", "name", "description", "domainId", "memberGroupIds"]}),
                        ),
                    ],
                )
                .await?;
            for a in r[1]["list"].as_array().into_iter().flatten() {
                let (Some(id), Some(ours)) = (a["id"].as_str(), a["externalId"].as_str().and_then(|x| x.strip_prefix(&prefix))) else { continue };
                let account = Account {
                    id: id.to_string(),
                    name: a["name"].as_str().unwrap_or_default().to_string(),
                    description: a["description"].as_str().unwrap_or_default().to_string(),
                    domain: a["domainId"].as_str().unwrap_or_default().to_string(),
                    groups: a["memberGroupIds"].as_object().map(|g| g.keys().cloned().collect()).unwrap_or_default(),
                };
                match ours.strip_prefix("group:") {
                    Some(g) => g.parse().ok().map(|g| out.groups.insert(g, account)),
                    None => ours.parse().ok().map(|p| out.people.insert(p, account)),
                };
            }
            match r[0]["ids"].as_array().map_or(0, Vec::len) {
                0 => return Ok(out),
                n => position += n,
            }
        }
    }

    async fn create(&self, k: &Kernel, tenant: Uuid, domain: &str, p: &Person, secret: &str) -> Result<String> {
        let account = json!({
            "@type": "User", "name": p.local(), "domainId": domain, "description": p.full_name,
            "externalId": format!("ferrum:{tenant}:{}", p.id), "roles": {"@type": "User"},
            "credentials": {"0": {"@type": "Password", "secret": secret}},
        });
        let r = self.jmap(k, vec![("x:Account/set", json!({"create": {"u": account}}))]).await?;
        created(&r[0], "u")
    }

    /// Moves an account to the person's address (with `to`), and with `secret` replaces every
    /// credential it has (app passwords too) with that password.
    async fn update(&self, k: &Kernel, account: &str, to: Option<(&str, &Person)>, secret: Option<&str>) -> Result<()> {
        let mut patch = json!({});
        if let Some((domain, p)) = to {
            patch["name"] = json!(p.local());
            patch["domainId"] = json!(domain);
            patch["description"] = json!(p.full_name);
        }
        if let Some(secret) = secret {
            patch["credentials"] = json!({"0": {"@type": "Password", "secret": secret}});
        }
        let r = self.jmap(k, vec![("x:Account/set", json!({"update": {account: patch}}))]).await?;
        updated(&r[0], account)
    }
}

/// The workspace's accounts on the server, by Ferrum id: its people's and its shared mailboxes'.
#[derive(Debug, Default)]
pub(crate) struct Accounts {
    pub people: BTreeMap<Uuid, Account>,
    pub groups: BTreeMap<Uuid, Account>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Account {
    pub id: String,
    pub name: String,
    pub description: String,
    pub domain: String,
    /// The group accounts it is a member of.
    pub groups: BTreeSet<String>,
}

pub(crate) fn created(r: &Value, key: &str) -> Result<String> {
    r["created"][key]["id"].as_str().map(String::from).ok_or_else(|| unavailable(format!("refused it: {}", r["notCreated"][key])))
}

/// Whether an update was taken.
pub(crate) fn updated(r: &Value, id: &str) -> Result<()> {
    match r["updated"].get(id) {
        Some(_) => Ok(()),
        None => Err(unavailable(format!("refused the change: {}", r["notUpdated"][id]))),
    }
}

fn new_secret() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>())
}

#[derive(Debug)]
pub(crate) struct Person {
    pub id: Uuid,
    pub email: String,
    pub full_name: String,
    pub active: bool,
}

impl Person {
    fn local(&self) -> &str {
        self.email.split('@').next().unwrap_or_default()
    }

    /// Whether they have an unlocked mailbox in `domain` (lowercase).
    pub(crate) fn hosted(&self, domain: &str) -> bool {
        self.active && self.email.strip_suffix(domain).is_some_and(|l| l.ends_with('@'))
    }
}

/// A person's `HostedMailbox`, as the last reconcile left it.
struct Kept {
    email: String,
    status: String,
    /// Whether its password is kept.
    secret: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Create(Uuid),
    /// To the person's current address; with a new password when it was locked or its password
    /// is not kept.
    Update {
        person: Uuid,
        account: String,
        password: bool,
    },
    Lock(Uuid, String),
}

impl Step {
    fn person(&self) -> Uuid {
        match self {
            Step::Create(p) | Step::Update { person: p, .. } | Step::Lock(p, _) => *p,
        }
    }
    fn name(&self) -> &'static str {
        match self {
            Step::Create(_) => "created",
            Step::Update { .. } => "updated",
            Step::Lock(..) => "locked",
        }
    }
}

/// What brings the server in step with the people (emails lowercase): an active person in the
/// domain has an unlocked account at their address; anyone else's account is locked.
fn plan(people: &[Person], domain: &str, accounts: &BTreeMap<Uuid, String>, kept: &HashMap<Uuid, Kept>) -> Vec<Step> {
    let domain = domain.to_ascii_lowercase();
    people
        .iter()
        .filter_map(|p| {
            let kept = kept.get(&p.id);
            let active = kept.is_some_and(|k| k.status == "Active" && k.secret);
            match (p.hosted(&domain), accounts.get(&p.id)) {
                (true, None) => Some(Step::Create(p.id)),
                (true, Some(a)) if !active => Some(Step::Update { person: p.id, account: a.clone(), password: true }),
                (true, Some(a)) if kept.is_some_and(|k| k.email != p.email) => Some(Step::Update { person: p.id, account: a.clone(), password: false }),
                (false, Some(a)) if kept.is_none_or(|k| k.status != "Locked") => Some(Step::Lock(p.id, a.clone())),
                _ => None,
            }
        })
        .collect()
}

/// The workspace's mail domain, when hosted mail is on for it.
async fn mail_domain(k: &Kernel, tenant: Uuid) -> Result<Option<String>> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let d: Option<Option<String>> =
        sqlx::query_scalar("select mail_domain from e_comms_settings where tenant_id = $1 limit 1").bind(tenant).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(d.flatten().map(|d| d.trim().trim_start_matches('@').to_ascii_lowercase()).filter(|d| !d.is_empty()))
}

/// Brings the mail server in step with the workspace's people, shared mailboxes and distribution
/// lists (`groups.rs`): `{domain, created, updated, locked, shared, lists, failed: [{email, step,
/// error}]}`. A step that fails does not stop the others.
pub async fn reconcile(k: &Kernel, tenant: Uuid) -> Result<Value> {
    let domain = mail_domain(k, tenant).await?.ok_or_else(|| Error::invalid("set the Mail Domain in Communication Settings first"))?;
    let admin = Admin::connect(k).await?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let people: Vec<(Uuid, String, String, bool)> =
        sqlx::query_as("select id, lower(email::text), full_name, is_active from app_user where tenant_id = $1").bind(tenant).fetch_all(&mut *tx).await?;
    let rows: Vec<(Uuid, String, String, Option<String>, bool)> = sqlx::query_as(
        "select m.id, m.user_id, m.email, m.status, exists (select 1 from record_secret s where s.tenant_id = m.tenant_id \
         and s.entity = 'HostedMailbox' and s.record_id = m.id and s.field = 'secret') from e_hosted_mailbox m where m.tenant_id = $1",
    )
    .bind(tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let people: Vec<Person> = people.into_iter().map(|(id, email, full_name, active)| Person { id, email, full_name, active }).collect();
    let mut row_of = HashMap::new();
    let mut kept = HashMap::new();
    for (row, user, email, status, secret) in rows {
        if let Ok(user) = user.parse::<Uuid>() {
            row_of.insert(user, row);
            kept.insert(user, Kept { email, status: status.unwrap_or_default(), secret });
        }
    }

    let domain_id = admin.domain(k, &domain).await?;
    let mut accounts = admin.accounts(k, tenant).await?;
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    let mut report = json!({"domain": domain, "created": 0, "updated": 0, "locked": 0, "shared": 0, "lists": 0, "failed": []});
    let ids: BTreeMap<Uuid, String> = accounts.people.iter().map(|(p, a)| (*p, a.id.clone())).collect();
    for step in plan(&people, &domain, &ids, &kept) {
        let Some(p) = people.iter().find(|p| p.id == step.person()) else { continue };
        let done = async {
            let (account, status, secret) = match &step {
                Step::Create(_) => {
                    let secret = new_secret();
                    (admin.create(k, tenant, &domain_id, p, &secret).await?, "Active", json!(secret))
                }
                Step::Update { account, password, .. } => {
                    let secret = password.then(new_secret);
                    admin.update(k, account, Some((&domain_id, p)), secret.as_deref()).await?;
                    // `true` keeps the stored password.
                    (account.clone(), "Active", secret.map_or(json!(true), Value::String))
                }
                Step::Lock(_, account) => {
                    // A password nobody keeps: the mailbox and its mail stay, nobody signs in.
                    admin.update(k, account, None, Some(&new_secret())).await?;
                    (account.clone(), "Locked", Value::Null)
                }
            };
            let row = obj(json!({
                "email": p.email, "user_id": p.id.to_string(), "account_id": account, "status": status,
                "secret": secret, "synced_at": util::ts(util::now()),
            }));
            match row_of.get(&p.id) {
                Some(id) => k.update(&ctx, "HostedMailbox", *id, row, None).await,
                None => k.insert(&ctx, "HostedMailbox", row).await,
            }
        }
        .await;
        match done {
            Ok(_) => report[step.name()] = json!(report[step.name()].as_i64().unwrap_or(0) + 1),
            Err(e) => {
                tracing::warn!(%tenant, email = %p.email, step = step.name(), "hosted mailbox not in step: {e}");
                report["failed"].as_array_mut().into_iter().for_each(|f| f.push(json!({"email": p.email, "step": step.name(), "error": e.to_string()})));
            }
        }
    }
    // New people's accounts take part in the shared mailboxes too.
    if report["created"].as_i64().unwrap_or(0) > 0 {
        accounts = admin.accounts(k, tenant).await?;
    }
    groups::reconcile(k, &admin, &ctx, &domain, &domain_id, &people, &accounts, &mut report).await?;
    tracing::info!(%tenant, %report, "hosted mail reconciled");
    Ok(report)
}

/// The next maintenance round brings the workspace in step (a changed shared mailbox or list),
/// instead of waiting out the ten minutes.
// ponytail: the wait is per replica; one whose maintenance round runs elsewhere waits it out.
pub(crate) fn soon(tenant: Uuid) {
    if let Some(last) = LAST.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        last.remove(&tenant);
    }
}

/// When the mail server refuses a person's kept password (restored from a backup, changed by hand,
/// a sync cut short): forgets it and brings the mailboxes in step, which sets a new one.
pub(crate) async fn renew(k: &Kernel, tenant: Uuid, mailbox: Uuid) -> Result<()> {
    tracing::warn!(%tenant, %mailbox, "the mail server refused a kept password; setting a new one");
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    k.update(&ctx, "HostedMailbox", mailbox, obj(json!({"secret": null})), None).await?;
    reconcile(k, tenant).await.map(|_| ())
}

static LAST: Mutex<Option<HashMap<Uuid, Instant>>> = Mutex::new(None);

/// From maintenance: [`reconcile`] at most every ten minutes, for workspaces with hosted mail.
pub async fn reconcile_due(k: &Kernel, tenant: Uuid) -> Result<()> {
    if configured().is_none() || mail_domain(k, tenant).await?.is_none() {
        return Ok(());
    }
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let last = last.get_or_insert_with(HashMap::new);
        if last.get(&tenant).is_some_and(|at| at.elapsed() < EVERY) {
            return Ok(());
        }
        last.insert(tenant, Instant::now());
    }
    reconcile(k, tenant).await.map(|_| ())
}

/// Communication Settings' "Sync Mailboxes"; a changed Mail Domain is taken up at the next round.
pub struct SettingsHook;

#[async_trait]
impl DocHook for SettingsHook {
    async fn after_save(&self, hc: &mut HookCtx<'_>, _doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        soon(hc.ctx.tenant);
        Ok(())
    }
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, _doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        match name {
            "sync_mail" => reconcile(hc.kernel, hc.ctx.tenant).await.map(Some),
            _ => Ok(None),
        }
    }
}

/// Hosted mailboxes change only through the reconcile.
pub struct MailboxHook;

const KEPT_BY_FERRUM: &str = "hosted mailboxes follow the people: change the person or the Mail Domain instead";

#[async_trait]
impl DocHook for MailboxHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, _doc: &mut Doc) -> Result<()> {
        if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden(KEPT_BY_FERRUM.into())) }
    }
    async fn before_delete(&self, hc: &mut HookCtx<'_>, _doc: &Doc) -> Result<()> {
        if hc.ctx.is_system { Ok(()) } else { Err(Error::Forbidden(KEPT_BY_FERRUM.into())) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(email: &str, active: bool) -> Person {
        Person { id: Uuid::now_v7(), email: email.into(), full_name: "Ann".into(), active }
    }

    #[test]
    fn mailboxes_follow_people_and_the_domain() {
        let people = [
            person("new@acme.com", true),
            person("steady@acme.com", true),
            person("gone@acme.com", false),
            person("moved@other.org", true),
            person("back@acme.com", true),
            person("guest@other.org", true),
            person("still@acme.com", false),
            person("lost@acme.com", true),
            person("renamed@acme.com", true),
            person("forgotten@acme.com", true),
        ];
        let [new, steady, gone, moved, back, _guest, still, lost, renamed, forgotten] = &people;
        let accounts: BTreeMap<Uuid, String> =
            [steady, gone, moved, back, still, lost, renamed, forgotten].iter().map(|p| (p.id, format!("a-{}", p.local()))).collect();
        let kept: HashMap<Uuid, Kept> = [(steady, "Active"), (gone, "Active"), (moved, "Active"), (back, "Locked"), (still, "Locked")]
            .into_iter()
            .map(|(p, status)| (p.id, Kept { email: p.email.clone(), status: status.into(), secret: status == "Active" }))
            .chain([
                (renamed.id, Kept { email: "old.name@acme.com".into(), status: "Active".into(), secret: true }),
                (forgotten.id, Kept { email: forgotten.email.clone(), status: "Active".into(), secret: false }),
            ])
            .collect();
        let update = |p: &Person, password| Step::Update { person: p.id, account: format!("a-{}", p.local()), password };
        assert_eq!(
            plan(&people, "ACME.com", &accounts, &kept),
            [
                Step::Create(new.id),
                Step::Lock(gone.id, "a-gone".into()),
                Step::Lock(moved.id, "a-moved".into()),
                update(back, true),
                update(lost, true),
                update(renamed, false),
                update(forgotten, true),
            ],
            "the guest and the people already in step need nothing; a password Ferrum does not keep is replaced"
        );
        assert!(new_secret().len() == 32 && new_secret() != new_secret());
    }
}
