//! Comms' handle on the vault (Ferrum docs/operations.md, "The vault"). A room's guest link carries a random key, which
//! the room keeps sealed under Comms' own key in the workspace (`comms_meeting.guest_key`, as the vault writes it,
//! `fv1.{version}.…`), so that whoever reads the meetings, or a dump of them, does not get the link; it opens only for
//! that room, in that workspace. Until 0.21 the key was kept as it is: such a key is still honoured (never in a sandbox,
//! whose links are its own), and the release after this one seals what is left in place. A sealed value always holds a
//! dot and a key never does, so the build before this one reads a sealed value as a key nobody can present.

use ferrum_kernel::vault::{Scope, Vault, Zeroizing};
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
