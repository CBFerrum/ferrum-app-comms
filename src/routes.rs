//! Apps that take inbound mail. An app registers an address (`support@acme.test`) or a pattern
//! (`ticket-*@acme.test`) on one of the workspace's domains with a [`Handler`] it has added at startup
//! ([`add_handler`]); mail that arrives for it, through an account's IMAP polling or inbound webhook, is
//! handed to the app once, in the transaction that stores the message, behind a savepoint: a handler
//! that fails undoes its own work only, and the message is stored and logged (`route_error`) all the same.
//!
//! * `support@acme.test` is also `support+anything@acme.test`; what follows the `+` is the message's
//!   `token` (an app puts a per-record token there). `ticket-*@acme.test` takes what the `*` matched as
//!   the token. One `*` at most, no `+` in a registration.
//! * The message is matched on its To, its Cc and the recipient the server delivered it to (so a Bcc is
//!   found too). It goes to each app with a registration that matches, once.
//! * No two apps take the same address: a registration that overlaps another app's is refused, and so is
//!   one on an address a person's mailbox or a shared mailbox owns.
//! * The message is recorded as taken (`routed_to`), and by default stays in the mailbox it was addressed
//!   to; a registration with `keep_in_mailbox: false` leaves it out of what people list (`hidden_from_inbox`)
//!   once its app has taken it. A message whose handler failed stays where people see it.
//! * An account's `append_to` does not also make a record of a message an app took.
//!
//! Mail kept on the hosted mail server itself is not routed here: it is not stored as a Communication.
//! Point the mail server's forwarding for the address at the account's inbound webhook.

use async_trait::async_trait;
use ferrum_kernel::{Ctx, Error, Kernel, Result, Tx};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, RwLock};
use uuid::Uuid;

/// A message handed to an app, without anything it did not carry.
#[derive(Debug, Clone, Default)]
pub struct Received {
    /// Mail's record of the message (a `Communication`).
    pub communication: Uuid,
    /// Without angle brackets.
    pub message_id: Option<String>,
    pub in_reply_to: Vec<String>,
    pub references: Vec<String>,
    pub from_name: Option<String>,
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub text: String,
    /// Stored files: `[{id, file_name, content_type, size}]`.
    pub attachments: Vec<Value>,
    /// What [`crate::inbound::received_headers`] kept, names in lower case.
    pub headers: BTreeMap<String, String>,
    /// The record Mail threaded the message onto (a reply to mail an app sent): its entity and id.
    pub reference: Option<(String, Uuid)>,
    /// The registration that took it, as registered.
    pub address: String,
    /// The address on the message the registration matched, lower case, with its `+tag`.
    pub recipient: String,
    /// What follows the `+`, or what the `*` matched.
    pub token: Option<String>,
}

/// What an app does with a message addressed to its registration. It runs inside Mail's transaction as the
/// system; whatever it writes stands only if it returns `Ok`.
#[async_trait]
pub trait Handler: Send + Sync {
    async fn receive(&self, k: &Kernel, ctx: &Ctx, tx: &mut Tx, mail: &Received) -> Result<()>;
}

static HANDLERS: LazyLock<RwLock<HashMap<String, Arc<dyn Handler>>>> = LazyLock::new(Default::default);

/// Adds the handler of `app` (its id), once at startup. A second call replaces the first.
pub fn add_handler(app: &str, handler: Arc<dyn Handler>) {
    HANDLERS.write().unwrap_or_else(|e| e.into_inner()).insert(app.to_string(), handler);
}

fn handler(app: &str) -> Option<Arc<dyn Handler>> {
    HANDLERS.read().unwrap_or_else(|e| e.into_inner()).get(app).cloned()
}

/// What an app registers.
#[derive(Debug, Clone)]
pub struct Registration<'a> {
    pub app: &'a str,
    /// `local@domain` on one of the workspace's domains; the local part may hold one `*`.
    pub address: &'a str,
    /// Whether the message also stays in the mailbox it was addressed to (the default for a registration
    /// is `true`).
    pub keep_in_mailbox: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub id: Uuid,
    pub app: String,
    pub address: String,
    pub keep_in_mailbox: bool,
}

/// `local@domain` in lower case when it is a usable registration.
fn parse(address: &str) -> Result<(String, String)> {
    let a = address.trim().to_ascii_lowercase();
    let (local, domain) = a.split_once('@').ok_or_else(|| Error::invalid(format!("'{address}' is not an address")))?;
    let local_ok = !local.is_empty()
        && local.len() <= 64
        && local.matches('*').count() <= 1
        && local.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'*'));
    let domain_ok = domain.contains('.') && domain.len() <= 253 && domain.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'));
    if !local_ok || !domain_ok {
        return Err(Error::invalid(format!("'{address}' cannot be registered: letters, digits, '.', '_' and '-' before the @, at most one '*', and a domain")));
    }
    Ok((local.to_string(), domain.to_string()))
}

/// What `local` (of a registration) takes of an address's local part: `Some(token)` when it matches. The
/// part after a `+` is the token of a plain registration; a `*` takes what it matched.
fn local_token(registered: &str, local: &str) -> Option<Option<String>> {
    match registered.split_once('*') {
        None => {
            let (base, tag) = match local.split_once('+') {
                Some((b, t)) => (b, Some(t.to_string()).filter(|t| !t.is_empty())),
                None => (local, None),
            };
            (base == registered).then_some(tag)
        }
        Some((pre, suf)) => {
            let middle = local.strip_prefix(pre)?.strip_suffix(suf)?;
            (local.len() >= pre.len() + suf.len() && !middle.is_empty()).then(|| Some(middle.to_string()))
        }
    }
}

/// The token an address gives to `registered` (`local@domain`), when it is for it.
pub fn matches(registered: &str, address: &str) -> Option<Option<String>> {
    let (rl, rd) = registered.split_once('@')?;
    let (al, ad) = address.trim().to_ascii_lowercase().rsplit_once('@').map(|(l, d)| (l.to_string(), d.to_string()))?;
    (rd == ad).then(|| local_token(rl, &al)).flatten()
}

/// Whether two registrations could take the same address (same domain, and local parts that some address fits both).
fn overlap(a: &str, b: &str) -> bool {
    let (Some((al, ad)), Some((bl, bd))) = (a.split_once('@'), b.split_once('@')) else { return false };
    if ad != bd {
        return false;
    }
    match (al.split_once('*'), bl.split_once('*')) {
        (None, None) => al == bl,
        (Some(_), None) => local_token(al, bl).is_some(),
        (None, Some(_)) => local_token(bl, al).is_some(),
        (Some((ap, asf)), Some((bp, bsf))) => (ap.starts_with(bp) || bp.starts_with(ap)) && (asf.ends_with(bsf) || bsf.ends_with(asf)),
    }
}

/// The domains addresses may be registered on: the workspace's mail domain and those of its outgoing email accounts.
pub async fn domains(tx: &mut Tx, tenant: Uuid) -> Result<Vec<String>> {
    let mut out: Vec<String> = sqlx::query_scalar(
        "select lower(split_part(email_address, '@', 2)) from e_email_account where tenant_id = $1 and enable_outgoing and email_address like '%@%'",
    )
    .bind(tenant)
    .fetch_all(&mut **tx)
    .await?;
    let hosted: Option<Option<String>> =
        sqlx::query_scalar("select mail_domain from e_comms_settings where tenant_id = $1 limit 1").bind(tenant).fetch_optional(&mut **tx).await?;
    out.extend(hosted.flatten().map(|d| d.trim().trim_start_matches('@').to_ascii_lowercase()).filter(|d| !d.is_empty()));
    out.sort();
    out.dedup();
    Ok(out)
}

/// The addresses people own: hosted mailboxes and shared mailboxes (the latter on the mail domain).
async fn owned(tx: &mut Tx, tenant: Uuid) -> Result<Vec<String>> {
    let mut out: Vec<String> = sqlx::query_scalar("select lower(email) from e_hosted_mailbox where tenant_id = $1").bind(tenant).fetch_all(&mut **tx).await?;
    let domain: Option<Option<String>> =
        sqlx::query_scalar("select mail_domain from e_comms_settings where tenant_id = $1 limit 1").bind(tenant).fetch_optional(&mut **tx).await?;
    if let Some(d) = domain.flatten().map(|d| d.trim().trim_start_matches('@').to_ascii_lowercase()).filter(|d| !d.is_empty()) {
        let shared: Vec<String> =
            sqlx::query_scalar("select lower(address) from e_shared_mailbox where tenant_id = $1").bind(tenant).fetch_all(&mut **tx).await?;
        out.extend(shared.into_iter().map(|a| format!("{a}@{d}")));
    }
    Ok(out)
}

/// Registers `reg.address` for `reg.app` in the caller's transaction; registering the same address again
/// changes `keep_in_mailbox`. Refused (`Invalid`) when the address is malformed or not on one of the workspace's
/// domains, `Conflict` when another app or a person's mailbox has it.
pub async fn register(tx: &mut Tx, tenant: Uuid, reg: &Registration<'_>) -> Result<Uuid> {
    let (local, domain) = parse(reg.address)?;
    let pattern = format!("{local}@{domain}");
    if reg.app.trim().is_empty() || reg.app.len() > 64 {
        return Err(Error::invalid("an app id of at most 64 characters"));
    }
    // One registration at a time per workspace, so two apps cannot both pass the overlap check.
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))").bind(format!("comms-routes|{tenant}")).execute(&mut **tx).await?;
    if !domains(tx, tenant).await?.contains(&domain) {
        return Err(Error::invalid(format!("{domain} is not one of the workspace's mail domains (its mail domain, or an outgoing email account's)")));
    }
    for other in sqlx::query_as::<_, (String, String)>("select app, pattern from comms_mail_route where tenant_id = $1 and app <> $2")
        .bind(tenant)
        .bind(reg.app)
        .fetch_all(&mut **tx)
        .await?
    {
        if overlap(&pattern, &other.1) {
            return Err(Error::Conflict(format!("{pattern} overlaps {}, which {} has registered", other.1, other.0)));
        }
    }
    for mine in owned(tx, tenant).await? {
        if matches(&pattern, &mine).is_some() {
            return Err(Error::Conflict(format!("{pattern} takes {mine}, which belongs to a mailbox people use")));
        }
    }
    let id: Uuid = sqlx::query_scalar(
        "insert into comms_mail_route (tenant_id, id, app, pattern, keep_in_mailbox) values ($1, $2, $3, $4, $5) \
         on conflict (tenant_id, pattern) do update set keep_in_mailbox = excluded.keep_in_mailbox returning id",
    )
    .bind(tenant)
    .bind(Uuid::now_v7())
    .bind(reg.app)
    .bind(&pattern)
    .bind(reg.keep_in_mailbox)
    .fetch_one(&mut **tx)
    .await?;
    Ok(id)
}

/// Takes `address` back from `app`; whether it was registered.
pub async fn unregister(tx: &mut Tx, tenant: Uuid, app: &str, address: &str) -> Result<bool> {
    let (local, domain) = parse(address)?;
    let n = sqlx::query("delete from comms_mail_route where tenant_id = $1 and app = $2 and pattern = $3")
        .bind(tenant)
        .bind(app)
        .bind(format!("{local}@{domain}"))
        .execute(&mut **tx)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// The workspace's registrations, or one app's.
pub async fn registered(tx: &mut Tx, tenant: Uuid, app: Option<&str>) -> Result<Vec<Route>> {
    let rows: Vec<(Uuid, String, String, bool)> = sqlx::query_as(
        "select id, app, pattern, keep_in_mailbox from comms_mail_route where tenant_id = $1 and ($2::text is null or app = $2) order by pattern",
    )
    .bind(tenant)
    .bind(app)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(id, app, address, keep_in_mailbox)| Route { id, app, address, keep_in_mailbox }).collect())
}

/// A registration a message is for, with what it matched.
#[derive(Debug, Clone)]
pub(crate) struct Taken {
    pub route: Route,
    pub recipient: String,
    pub token: Option<String>,
}

/// The registrations a message is addressed to: by To, Cc and the headers that name the recipient it was delivered
/// to, one per app (the first by address).
pub(crate) async fn matching(tx: &mut Tx, tenant: Uuid, mail: &crate::inbound::ParsedMail) -> Result<Vec<Taken>> {
    let routes = registered(tx, tenant, None).await?;
    if routes.is_empty() {
        return Ok(vec![]);
    }
    let mut candidates: Vec<String> = mail.to.iter().chain(&mail.cc).flat_map(|a| crate::util::mailbox_addresses(a)).collect();
    for h in ["delivered-to", "x-original-to", "envelope-to", "x-envelope-to"] {
        candidates.extend(mail.headers.get(h).map(|v| crate::util::mailbox_addresses(v)).unwrap_or_default());
    }
    let mut out: Vec<Taken> = Vec::new();
    for route in routes {
        if out.iter().any(|t| t.route.app == route.app) {
            continue;
        }
        if let Some((recipient, token)) = candidates.iter().find_map(|c| matches(&route.address, c).map(|t| (c.clone(), t))) {
            out.push(Taken { route, recipient, token });
        }
    }
    Ok(out)
}

/// Hands the stored message `comm` to each app that took it and records who did. A handler that fails, or is
/// not there, leaves the message as it was stored, with the reason in `route_error`.
pub(crate) async fn deliver(
    k: &Kernel,
    ctx: &Ctx,
    tx: &mut Tx,
    comm: Uuid,
    mail: &crate::inbound::ParsedMail,
    text: &str,
    attachments: &[Value],
    reference: Option<(String, Uuid)>,
    taken: &[Taken],
) -> Result<()> {
    let (mut apps, mut errors, mut keep) = (Vec::new(), Vec::new(), false);
    for t in taken {
        let received = Received {
            communication: comm,
            message_id: mail.message_id.clone(),
            in_reply_to: mail.in_reply_to.clone(),
            references: mail.references.clone(),
            from_name: mail.from.as_ref().and_then(|f| f.0.clone()),
            from: mail.from.as_ref().map(|f| f.1.clone()).unwrap_or_default(),
            to: mail.to.clone(),
            cc: mail.cc.clone(),
            subject: mail.subject.clone(),
            text: text.to_string(),
            attachments: attachments.to_vec(),
            headers: mail.headers.clone(),
            reference: reference.clone(),
            address: t.route.address.clone(),
            recipient: t.recipient.clone(),
            token: t.token.clone(),
        };
        sqlx::query("savepoint mail_route").execute(&mut **tx).await?;
        let outcome = match handler(&t.route.app) {
            Some(h) => h.receive(k, ctx, tx, &received).await,
            None => Err(Error::Unavailable(format!("{} is not installed here", t.route.app))),
        };
        match outcome {
            Ok(()) => {
                sqlx::query("release savepoint mail_route").execute(&mut **tx).await?;
                apps.push(t.route.app.clone());
                keep |= t.route.keep_in_mailbox;
            }
            Err(e) => {
                sqlx::query("rollback to savepoint mail_route").execute(&mut **tx).await?;
                tracing::warn!(tenant = %ctx.tenant, app = %t.route.app, communication = %comm, "an app did not take inbound mail: {e}");
                errors.push(format!("{}: {e}", t.route.app));
            }
        }
    }
    if apps.is_empty() && errors.is_empty() {
        return Ok(());
    }
    let mut values = ferrum_kernel::Doc::new();
    values.insert("routed_to".into(), if apps.is_empty() { Value::Null } else { json!(apps.join(", ")) });
    values.insert("route_error".into(), if errors.is_empty() { Value::Null } else { json!(crate::util::cut(&errors.join("; "), 2000)) });
    values.insert("hidden_from_inbox".into(), json!(!apps.is_empty() && !keep && errors.is_empty()));
    k.set_values_tx(ctx, tx, "Communication", comm, values).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_takes_its_plus_tag_and_a_star_takes_what_it_matched() {
        assert_eq!(matches("support@acme.test", "Support@Acme.test"), Some(None));
        assert_eq!(matches("support@acme.test", "support+k3j9@acme.test"), Some(Some("k3j9".into())));
        assert_eq!(matches("support@acme.test", "support2@acme.test"), None);
        assert_eq!(matches("support@acme.test", "support@other.test"), None);
        assert_eq!(matches("ticket-*@acme.test", "ticket-0042-x7@acme.test"), Some(Some("0042-x7".into())));
        assert_eq!(matches("ticket-*@acme.test", "ticket-@acme.test"), None);
        assert_eq!(matches("*-desk@acme.test", "it-desk@acme.test"), Some(Some("it".into())));
    }

    #[test]
    fn registrations_that_could_take_the_same_address_overlap() {
        assert!(overlap("support@a.test", "support@a.test"));
        assert!(!overlap("support@a.test", "support@b.test"));
        assert!(overlap("ticket-*@a.test", "ticket-12@a.test"));
        assert!(overlap("ticket-*@a.test", "ticket-1*@a.test"));
        assert!(overlap("t*@a.test", "*x@a.test"));
        assert!(!overlap("ticket-*@a.test", "order-*@a.test"));
        assert!(!overlap("a*b@x.test", "c*d@x.test"));
    }

    #[test]
    fn only_plain_addresses_register() {
        assert!(parse("Support@Acme.test").is_ok());
        for bad in ["support", "a+b@x.test", "a*b*c@x.test", "a b@x.test", "@x.test", "a@localhost", "a@x.test\nbcc: y@z.test"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }
}
