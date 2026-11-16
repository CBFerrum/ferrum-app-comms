//! Comms' handle on the vault (Ferrum docs/operations.md, "The vault"). A room's guest link carries a random key, which
//! the room keeps sealed under Comms' own key in the workspace (`comms_meeting.guest_key`, as the vault writes it,
//! `fv1.{version}.…`), so that whoever reads the meetings, or a dump of them, does not get the link; it opens only for
//! that room, in that workspace.

use ferrum_kernel::companion::Rendering;
use ferrum_kernel::vault::{Carry, Described, Rule, Scope, Vault, Zeroizing};
use ferrum_kernel::{Error, Kernel, Result, Site, Tx};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Each registration's handle, by the site it registered: one process may hold kernels of several registries (a test's
/// replicas, `ferrum start`'s two set-ups), and each kernel accepts only the handle its own registry gave.
static HANDLES: Mutex<Vec<(usize, Vault)>> = Mutex::new(Vec::new());

fn address(site: &Arc<dyn Site>) -> usize {
    Arc::as_ptr(site) as *const () as usize
}

/// Keeps the handle Comms' registration was given, beside the site it registered with it.
pub(crate) fn remember(site: &Arc<dyn Site>, v: Vault) {
    HANDLES.lock().unwrap_or_else(|e| e.into_inner()).push((address(site), v));
}

/// Comms' handle on the vault, as `k`'s registry gave it.
fn handle(k: &Kernel) -> Result<Vault> {
    let missing = || Error::Unavailable("Comms was registered without its vault handle: register it as the server does, hooks.app(\"comms\", …)".into());
    let at = address(k.hooks.site("comms").ok_or_else(missing)?);
    let held = HANDLES.lock().unwrap_or_else(|e| e.into_inner());
    held.iter().rev().find(|(a, _)| *a == at).map(|(_, v)| v.clone()).ok_or_else(missing)
}

/// The value of one of Comms' own secret fields (an account's passwords and inbound token, a mailbox's password, a
/// calendar's or a feed's address, its signing key), read in `tx` with its handle: none when it is not set. Another
/// app's field is refused, set or not; a closed vault refuses, and says why.
pub(crate) async fn field(k: &Kernel, tx: &mut Tx, tenant: Uuid, entity: &str, record: Uuid, field: &str) -> Result<Option<Zeroizing<String>>> {
    handle(k)?.field(k, tx, tenant, entity, record, field).await
}

/// What a person or a caller is told when the vault cannot be used; why goes to the log.
fn unavailable(e: Error) -> Error {
    match e {
        Error::Unavailable(why) | Error::Retryable(why) => {
            // The start's log and the doctor say why the vault is closed; this is the same reason, for each use.
            tracing::debug!("Comms' keys: {why}");
            Error::Unavailable("Comms cannot make or open guest links right now: its keys are unavailable".into())
        }
        e => e,
    }
}

/// What a room's guest key is sealed for: that room's.
fn context(room: Uuid) -> String {
    format!("comms_meeting.guest_key/{room}")
}

/// A room's guest key as the room keeps it: sealed.
pub(crate) async fn seal_guest_key(k: &Kernel, tenant: Uuid, room: Uuid, key: &str) -> Result<String> {
    handle(k).map_err(unavailable)?.seal(k, Scope::Workspace(tenant), &context(room), key.as_bytes()).await.map_err(unavailable)
}

/// The guest key a room keeps sealed (`kept`), opened: none when it opens nothing here (another room's, another
/// workspace's, changed, not sealed).
pub(crate) async fn guest_key(k: &Kernel, tenant: Uuid, room: Uuid, kept: &str) -> Result<Option<String>> {
    match handle(k).map_err(unavailable)?.open(k, Scope::Workspace(tenant), &context(room), kept).await {
        Ok(key) => Ok(String::from_utf8(key.to_vec()).ok()),
        Err(Error::Invalid(_)) => Ok(None),
        Err(e) => Err(unavailable(e)),
    }
}

// ───────────────────────────── the operator's secrets ─────────────────────────────
//
// LiveKit's API key and secret and the mail server administrator's password live in the installation's scope of Comms'
// vault, and nowhere else: `meet.key` (a name, revealed: it goes in each token), `meet.secret` (the vault signs tokens with
// it) and `mail.admin_secret` (the vault puts it on requests to the mail server). The operator sets one with
// `PUT /api/operator/secrets/comms/<name>`, its rule's `hosts` naming the server it serves, so a changed address does not
// take it elsewhere.
//
// The services `meet` and `mail` (meet.rs, hosted.rs) write `meet.secret` and `mail.admin_secret` into the files LiveKit
// and the mail server read as they start; a render makes each where the vault holds none, or keeps the one the operator
// set before it ([`made_or_kept`]), and from then on it is the service's: revealed to its render, rotated by the operator
// through it.

/// LiveKit's API key.
pub(crate) const MEET_KEY: Operator = Operator { name: "meet.key" };
/// LiveKit's API secret.
pub(crate) const MEET_SECRET: Operator = Operator { name: "meet.secret" };
/// The mail server administrator's password.
pub(crate) const MAIL_ADMIN: Operator = Operator { name: "mail.admin_secret" };

/// One of the operator's secrets: its name in Comms' vault.
#[derive(Clone, Copy)]
pub(crate) struct Operator {
    pub(crate) name: &'static str,
}

impl Operator {
    /// What the vault holds of it (never its value); none when it holds none.
    pub(crate) async fn describe(self, k: &Kernel) -> Result<Option<Described>> {
        handle(k).map_err(operator_unavailable)?.describe(k, Scope::Installation, self.name).await.map_err(operator_unavailable)
    }

    /// The hosts the vault's copy may serve; none when the vault holds none.
    pub(crate) async fn hosts(self, k: &Kernel) -> Result<Option<Vec<String>>> {
        Ok(self.describe(k).await?.map(|d| d.rule.hosts))
    }

    /// The vault's value, where its rule lets Comms read it; none when the vault holds none.
    pub(crate) async fn reveal(self, k: &Kernel) -> Result<Option<Zeroizing<String>>> {
        match handle(k).map_err(operator_unavailable)?.reveal(k, Scope::Installation, self.name).await {
            Ok(v) => Ok(String::from_utf8(v.to_vec()).ok().map(Zeroizing::new)),
            Err(Error::NotFound(_)) => Ok(None),
            Err(e) => Err(operator_unavailable(e)),
        }
    }

    /// `message` signed with the vault's copy (HMAC-SHA256): its version `version`, one still kept, or the current one.
    pub(crate) async fn sign_at(self, k: &Kernel, message: &[u8], version: Option<i32>) -> Result<Vec<u8>> {
        handle(k)
            .map_err(operator_unavailable)?
            .sign_at(k, Scope::Installation, self.name, message, version)
            .await
            .map(|(_, s)| s)
            .map_err(operator_unavailable)
    }
}

/// For a render: makes `name` under `rule` where the vault holds none (`hosts`, asked only then, are the hosts it is bound
/// to), or keeps the one there that is no service's yet (the operator set it before the first render: the value the
/// program already runs with) under `rule` and the hosts it had, from then on the service's to rotate. One a render made
/// or kept before is left as it is.
pub(crate) async fn made_or_kept(r: &Rendering<'_>, name: &str, rule: Rule, hosts: impl FnOnce() -> Result<Vec<String>>) -> Result<()> {
    match r.vault().describe(r.kernel(), Scope::Installation, name).await? {
        None => r.made(name, Rule { hosts: hosts()?, ..rule }).await,
        Some(d) if d.managed_by.is_none() => r.keep(name, Rule { hosts: d.rule.hosts, ..rule }).await,
        Some(_) => Ok(()),
    }
}

/// Comms' handle, to carry a secret on a request with.
pub(crate) fn vault(k: &Kernel) -> Result<Vault> {
    handle(k).map_err(operator_unavailable)
}

/// Whether `hosts` (a secret's rule) names `host`, as the vault decides it for a request.
pub(crate) fn names(hosts: &[String], host: &str) -> bool {
    ferrum_kernel::vault::carried(hosts, host, &Carry::Bearer, "-").is_ok()
}

/// The host of an address (`wss://meet.example.com:7880/x` → `meet.example.com`), in lower case.
pub(crate) fn host(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://")?.1;
    let at = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    let h = match at.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => at.split(':').next()?,
    };
    (!h.is_empty()).then(|| h.to_ascii_lowercase())
}

/// What a person is told when the vault cannot be used for the operator's secrets; why goes to the log.
pub(crate) fn operator_unavailable(e: Error) -> Error {
    match e {
        Error::Unavailable(why) | Error::Retryable(why) => {
            tracing::debug!("Comms' vault: {why}");
            Error::Unavailable("Comms cannot reach the operator's secrets right now: the vault is unavailable".into())
        }
        e => e,
    }
}
