//! Comms' handle on the vault (Ferrum docs/operations.md, "The vault"). A room's guest link carries a random key, which
//! the room keeps sealed under Comms' own key in the workspace (`comms_meeting.guest_key`, as the vault writes it,
//! `fv1.{version}.…`), so that whoever reads the meetings, or a dump of them, does not get the link; it opens only for
//! that room, in that workspace. Until 0.21 the key was kept as it is: such a key is still honoured (never in a sandbox,
//! whose links are its own), and the release after this one seals what is left in place. A sealed value always holds a
//! dot and a key never does, so the build before this one reads a sealed value as a key nobody can present.

use ferrum_kernel::companion::Rendering;
use ferrum_kernel::vault::{Carry, Described, New, Rule, Scope, Vault, Zeroizing};
use ferrum_kernel::{Error, Kernel, Result, Tx};
use std::sync::RwLock;
use uuid::Uuid;

/// Comms' handle on the vault, from its registration.
static VAULT: RwLock<Option<Vault>> = RwLock::new(None);

/// Keeps the handle the registration gave Comms.
// ponytail: the last registration's handle serves the whole process (`ferrum start` sets the server up twice and serves
// with the second); keep it in what is registered if one process ever serves two kernels at once.
pub(crate) fn remember(v: Vault) {
    *VAULT.write().unwrap_or_else(|e| e.into_inner()) = Some(v);
}

fn handle() -> Result<Vault> {
    VAULT.read().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| Error::Unavailable("Comms was registered without its vault handle".into()))
}

/// The value of one of Comms' own secret fields (an account's passwords and inbound token, a mailbox's password, a
/// calendar's or a feed's address, its signing key), read in `tx` with its handle: none when it is not set. Another
/// app's field is refused, set or not; a closed vault refuses, and says why.
pub(crate) async fn field(k: &Kernel, tx: &mut Tx, tenant: Uuid, entity: &str, record: Uuid, field: &str) -> Result<Option<Zeroizing<String>>> {
    handle()?.field(k, tx, tenant, entity, record, field).await
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
    handle()?.seal(k, Scope::Workspace(tenant), &context(room), key.as_bytes()).await.map_err(unavailable)
}

/// The guest key a room keeps (`kept`): opened when sealed; as it is when a build before 0.21 kept it so, except in a
/// sandbox. None when it opens nothing here (another room's, another workspace's, changed).
pub(crate) async fn guest_key(k: &Kernel, tenant: Uuid, room: Uuid, kept: &str) -> Result<Option<String>> {
    if !kept.contains('.') {
        return Ok(k.outward(tenant).await.is_ok().then(|| kept.to_string()));
    }
    match handle()?.open(k, Scope::Workspace(tenant), &context(room), kept).await {
        Ok(key) => Ok(String::from_utf8(key.to_vec()).ok()),
        Err(Error::Invalid(_)) => Ok(None),
        Err(e) => Err(unavailable(e)),
    }
}

// ───────────────────────────── the operator's secrets ─────────────────────────────
//
// LiveKit's API key and secret and the mail server administrator's password live in the installation's scope of Comms'
// vault: `meet.key` (a name, revealed: it goes in each token), `meet.secret` (the vault signs tokens with it) and
// `mail.admin_secret` (the vault puts it on requests to the mail server). Each copied from the environment is bound to the
// hosts of the addresses it serves (its rule's `hosts`), so a changed address does not take it elsewhere. The environment's
// variable, while it is set, still wins (through this release) and is kept in the vault once, bound to the hosts of the
// addresses then: only where the vault holds none, under the secret's own lock, so that replicas doing it together, or a
// render making it at that moment, write it once.
//
// The services `meet` and `mail` (meet.rs, hosted.rs) write `meet.secret` and `mail.admin_secret` into the files LiveKit
// and the mail server read as they start; a render makes each where the vault holds none, or keeps the one there
// ([`made_or_kept`]), and from then on it is the service's: revealed to its render, rotated by the operator through it.

/// LiveKit's API key.
pub(crate) const MEET_KEY: Operator = Operator { name: "meet.key", var: "FERRUM_MEET_KEY", reveal: true };
/// LiveKit's API secret.
pub(crate) const MEET_SECRET: Operator = Operator { name: "meet.secret", var: "FERRUM_MEET_SECRET", reveal: false };
/// The mail server administrator's password.
pub(crate) const MAIL_ADMIN: Operator = Operator { name: "mail.admin_secret", var: "FERRUM_MAIL_ADMIN_SECRET", reveal: false };

/// One of the operator's secrets: its name in the vault, the variable that gave it until now, whether Comms reads it.
#[derive(Clone, Copy)]
pub(crate) struct Operator {
    pub(crate) name: &'static str,
    pub(crate) var: &'static str,
    reveal: bool,
}

/// Which secrets this process has seen kept in the vault already.
static ADOPTED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());

impl Operator {
    /// The environment's value, while it sets one.
    pub(crate) fn in_environment(self) -> Option<Zeroizing<String>> {
        ferrum_kernel::env::var(self.var).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).map(Zeroizing::new)
    }

    /// The environment's value, kept in the vault once for `hosts` (the hosts of the addresses it serves now); a failure
    /// to keep it is logged, and the environment's is used all the same.
    pub(crate) async fn environment(self, k: &Kernel, hosts: &[String]) -> Option<Zeroizing<String>> {
        let value = self.in_environment()?;
        if let Err(e) = self.adopt(k, &value, hosts).await {
            tracing::warn!(error = %e, secret = self.name, "Comms could not keep the environment's secret in its vault; it uses the environment's");
        }
        Some(value)
    }

    async fn adopt(self, k: &Kernel, value: &str, hosts: &[String]) -> Result<bool> {
        if ADOPTED.lock().unwrap_or_else(|e| e.into_inner()).contains(&self.name) || hosts.is_empty() {
            return Ok(false);
        }
        let rule = Rule { reveal: self.reveal, hosts: hosts.to_vec(), ..Default::default() };
        let value = New::Value(Zeroizing::new(value.as_bytes().to_vec()));
        let adopted = handle()?.adopt(k, Scope::Installation, self.name, value, rule, "environment").await?;
        ADOPTED.lock().unwrap_or_else(|e| e.into_inner()).push(self.name);
        Ok(adopted)
    }

    /// What the vault holds of it (never its value); none when it holds none.
    pub(crate) async fn describe(self, k: &Kernel) -> Result<Option<Described>> {
        handle()?.describe(k, Scope::Installation, self.name).await.map_err(operator_unavailable)
    }

    /// The hosts the vault's copy may serve; none when the vault holds none.
    pub(crate) async fn hosts(self, k: &Kernel) -> Result<Option<Vec<String>>> {
        Ok(self.describe(k).await?.map(|d| d.rule.hosts))
    }

    /// The vault's value, where its rule lets Comms read it; none when the vault holds none.
    pub(crate) async fn reveal(self, k: &Kernel) -> Result<Option<Zeroizing<String>>> {
        match handle()?.reveal(k, Scope::Installation, self.name).await {
            Ok(v) => Ok(String::from_utf8(v.to_vec()).ok().map(Zeroizing::new)),
            Err(Error::NotFound(_)) => Ok(None),
            Err(e) => Err(operator_unavailable(e)),
        }
    }

    /// `message` signed with the vault's copy (HMAC-SHA256): its version `version`, one still kept, or the current one.
    pub(crate) async fn sign_at(self, k: &Kernel, message: &[u8], version: Option<i32>) -> Result<Vec<u8>> {
        handle()?.sign_at(k, Scope::Installation, self.name, message, version).await.map(|(_, s)| s).map_err(operator_unavailable)
    }
}

/// For a render: makes `name` under `rule` where the vault holds none (`hosts`, asked only then, are the hosts it is bound
/// to), or keeps the one there that is no service's yet (what Comms 0.22 copied from the environment, or a person set:
/// the value the program already runs with) under `rule` and the hosts it had, from then on the service's to rotate. One
/// a render made or kept before is left as it is.
pub(crate) async fn made_or_kept(r: &Rendering<'_>, name: &str, rule: Rule, hosts: impl FnOnce() -> Result<Vec<String>>) -> Result<()> {
    match r.vault().describe(r.kernel(), Scope::Installation, name).await? {
        None => r.made(name, Rule { hosts: hosts()?, ..rule }).await,
        Some(d) if d.managed_by.is_none() => r.keep(name, Rule { hosts: d.rule.hosts, ..rule }).await,
        Some(_) => Ok(()),
    }
}

/// Comms' handle, to carry a secret on a request with.
pub(crate) fn vault() -> Result<Vault> {
    handle()
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
