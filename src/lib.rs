//! Messaging, mail and calendar: email accounts (SMTP/IMAP), threaded communications on any record, templates, newsletters, team chat and calendars with ICS.
//!
//! Hooks are registered per entity, so a tenant without the `comms` package never runs them; the
//! mail sender is an outbox event sink and the endpoints a `Site` (see packages/comms/README.md).

mod account;
mod calendar;
mod chat;
mod groups;
mod hosted;
pub mod ics;
pub mod inbound;
mod mail;
mod meet;
mod newsletter;
pub mod recur;
mod reports;
mod site;
mod template;
mod util;
mod webmail;

pub use account::{Account, Security, Server};
pub use inbound::{ImapConnector, Mailbox, MailboxConnector};

use ferrum_domain::reports::ReportSource;
use ferrum_kernel::{Error, HookRegistry, Kernel, Result};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// Time one maintenance round may spend per tenant retrying mail, polling mailboxes and sending
/// newsletters (each mail or mailbox started before the budget runs out is finished).
const RETRY_BUDGET: Duration = Duration::from_secs(20);
const POLL_BUDGET: Duration = Duration::from_secs(40);
const SEND_BUDGET: Duration = Duration::from_secs(30);

/// Registers this package's document hooks, its mail sender and its endpoints.
pub fn register(hooks: &mut HookRegistry) {
    hooks
        .register("EmailAccount", Arc::new(account::AccountHook))
        .register("Communication", Arc::new(mail::CommunicationHook))
        .register("EmailTemplate", Arc::new(template::TemplateHook))
        .register("Newsletter", Arc::new(newsletter::NewsletterHook))
        .register("ChatChannel", Arc::new(chat::ChannelHook))
        .register("ChatMessage", Arc::new(chat::MessageHook))
        .register("CalendarEvent", Arc::new(calendar::EventHook))
        .register("CommsSettings", Arc::new(hosted::SettingsHook))
        .register("HostedMailbox", Arc::new(hosted::MailboxHook))
        .register("SharedMailbox", Arc::new(groups::SharedMailboxHook))
        .register("EmailGroup", Arc::new(groups::EmailGroupHook))
        .register("EmailGroupMember", Arc::new(groups::GroupMemberHook))
        .add_event_sink(Arc::new(mail::MailSink))
        .add_site("comms", Arc::new(site::CommsSite));
}

/// This package's reports.
pub fn reports() -> Vec<Arc<dyn ReportSource>> {
    vec![Arc::new(reports::CommsReports)]
}

/// Periodic upkeep: every minute, on one replica at a time (advisory lock); must be idempotent and cheap.
pub async fn maintenance(k: &Kernel) -> Result<()> {
    maintenance_with(k, &ImapConnector).await
}

/// [`maintenance`] reading mailboxes through `mailboxes` (tests pass a fake mailbox). Per tenant:
/// retry due mail, poll due IMAP accounts, send newsletter batches, announce reminders, keep hosted
/// mailboxes in step, purge.
/// A failing step is logged and does not stop the others; the first error is returned.
pub async fn maintenance_with(k: &Kernel, mailboxes: &dyn MailboxConnector) -> Result<()> {
    let mut tx = k.db.system_tx().await?;
    let tenants: Vec<Uuid> = sqlx::query_scalar("select id from tenant where status = 'active' order by id").fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut first_error: Option<Error> = None;
    for tenant in tenants {
        match k.registry.schema(tenant).await {
            Ok(schema) if schema.packages.iter().any(|p| p == "comms") => {}
            Ok(_) => continue,
            Err(e) => {
                first_error.get_or_insert(e);
                continue;
            }
        }
        let steps = [
            ("mail retries", mail::retry_due(k, tenant, RETRY_BUDGET).await),
            ("mail polling", inbound::poll_due(k, tenant, mailboxes, POLL_BUDGET).await),
            ("newsletters", newsletter::run(k, tenant, SEND_BUDGET).await),
            ("reminders", calendar::fire_reminders(k, tenant).await),
            ("hosted mail", hosted::reconcile_due(k, tenant).await.map(|_| 0)),
            ("purge", purge(k, tenant).await),
        ];
        for (step, outcome) in steps {
            if let Err(e) = outcome {
                tracing::warn!(%tenant, step, "comms maintenance failed: {e}");
                first_error.get_or_insert(e);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Old reminder bookkeeping, and meeting rooms nobody joined for 90 days.
async fn purge(k: &Kernel, tenant: Uuid) -> Result<usize> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let mut n = 0;
    for sql in [
        "delete from comms_reminder_log where tenant_id = $1 and fired_at < now() - interval '60 days'",
        "delete from comms_meeting where tenant_id = $1 and coalesce(used_at, created_at) < now() - interval '90 days'",
    ] {
        n += sqlx::query(sql).bind(tenant).execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    Ok(n as usize)
}

include!(concat!(env!("OUT_DIR"), "/packages.rs"));

/// This app's manifest (`app.yaml`).
pub const MANIFEST: &str = include_str!("../app.yaml");

/// This app's metadata packages, embedded at build time.
pub fn packages() -> std::result::Result<Vec<ferrum_meta::Package>, ferrum_meta::MetaError> {
    ferrum_meta::catalog::load_embedded(EMBEDDED)
}

#[cfg(test)]
mod tests {
    #[test]
    fn packages_are_valid() {
        let mut all = ferrum_domain::packages().expect("platform packages");
        all.extend(super::packages().expect("app packages"));
        let catalog = ferrum_meta::Catalog::from_packages(all).unwrap_or_else(|e| panic!("{e}"));
        let schema = ferrum_meta::effective::build(&catalog, &["comms".to_string()], &[], 1).unwrap_or_else(|e| panic!("{e}"));
        assert!(schema.warnings.is_empty(), "{:?}", schema.warnings);
        assert!(schema.entity("CalendarFeed").is_some_and(|e| e.secret_fields().count() == 1));
        assert!(super::MANIFEST.contains("packages: [comms]"));
    }
}
