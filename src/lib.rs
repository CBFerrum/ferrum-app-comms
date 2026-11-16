//! Messaging, mail and calendar: email accounts (SMTP/IMAP), threaded communications on any record, templates, team chat and calendars with ICS.
//!
//! Hooks are registered per entity, so a tenant without the `comms` package never runs them; the
//! mail sender is an outbox event sink and the endpoints a `Site` (see packages/comms/README.md).

mod account;
mod arrivals;
mod calendar;
mod calendars;
mod chat;
mod dav;
mod dns;
mod groups;
mod hosted;
mod hours;
pub mod ics;
pub mod inbound;
mod itip;
mod keys;
mod mail;
mod mailadmin;
pub(crate) mod meet;
pub mod meetings;
pub mod outbound;
mod proposals;
pub mod recur;
mod reports;
mod rooms;
pub mod routes;
mod site;
pub mod subscribe;
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

/// Time one maintenance round may spend per tenant retrying mail and polling mailboxes (each mail
/// or mailbox started before the budget runs out is finished).
const RETRY_BUDGET: Duration = Duration::from_secs(20);
const POLL_BUDGET: Duration = Duration::from_secs(40);
/// New hosted mail (`arrivals.rs`): looked at first, so a notification waits at most about a round.
const ARRIVALS_BUDGET: Duration = Duration::from_secs(20);
/// Calendars subscribed to by their address (`subscribe.rs`): each due one fetched while this lasts.
const SUBSCRIBE_BUDGET: Duration = Duration::from_secs(30);

/// Registers this package's document hooks, its mail sender and its endpoints. Call it inside the platform's
/// registration of the app, `hooks.app("comms", …)`: Comms takes its own vault handle there (`keys.rs`).
pub fn register(hooks: &mut HookRegistry) {
    let site: Arc<dyn ferrum_kernel::Site> = Arc::new(site::CommsSite);
    keys::remember(&site, hooks.vault());
    hooks
        .register("EmailAccount", Arc::new(account::AccountHook))
        .register("Communication", Arc::new(mail::CommunicationHook))
        .register("EmailTemplate", Arc::new(template::TemplateHook))
        .register("ChatChannel", Arc::new(chat::ChannelHook))
        .register("ChatMessage", Arc::new(chat::MessageHook))
        .register("CalendarEvent", Arc::new(calendar::EventHook))
        .register("CommsSettings", Arc::new(hosted::SettingsHook))
        .register("HostedMailbox", Arc::new(hosted::MailboxHook))
        .register("SharedMailbox", Arc::new(groups::SharedMailboxHook))
        .register("EmailGroup", Arc::new(groups::EmailGroupHook))
        .register("EmailGroupMember", Arc::new(groups::GroupMemberHook))
        .add_event_sink(Arc::new(mail::MailSink))
        .add_site("comms", site);
    hooks.add_personal_held(Arc::new(meet::Transcripts));
    hooks.add_personal_held(Arc::new(meetings::Attendance));
    // The programs beside the server whose files Comms renders as they start (`ferrum task render service:<name>`).
    hooks.add_companion("meet", Arc::new(meet::Service));
    hooks.add_companion("mail", Arc::new(hosted::Service));
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
/// look at new hosted mail (notify, file, wake snoozed mail, apply calendar answers), retry due mail, poll due IMAP accounts, announce reminders, keep hosted
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
            ("new mail", arrivals::run(k, tenant, ARRIVALS_BUDGET).await),
            ("mail retries", mail::retry_due(k, tenant, RETRY_BUDGET).await),
            ("mail polling", inbound::poll_due(k, tenant, mailboxes, POLL_BUDGET).await),
            ("reminders", calendar::fire_reminders(k, tenant).await),
            ("calendar subscriptions", subscribe::run(k, tenant, SUBSCRIBE_BUDGET).await),
            ("meeting attendance", meetings::upkeep(k, tenant).await),
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

/// Old reminder bookkeeping, what old new-mail notifications opened, proposals for deleted events, and meeting rooms nobody joined for 90 days.
async fn purge(k: &Kernel, tenant: Uuid) -> Result<usize> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let mut n = 0;
    for sql in [
        "delete from comms_reminder_log where tenant_id = $1 and fired_at < now() - interval '60 days'",
        "delete from comms_mail_notice where tenant_id = $1 and created_at < now() - interval '60 days'",
        "delete from comms_event_proposal p where tenant_id = $1 and not exists (select 1 from e_calendar_event e where e.tenant_id = p.tenant_id and e.id = p.event_id)",
        "delete from comms_meeting where tenant_id = $1 and coalesce(used_at, created_at) < now() - interval '90 days' and (source_entity is null or coalesce(ends_at, created_at) < now() - interval '90 days')",
    ] {
        n += sqlx::query(sql).bind(tenant).execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    Ok(n as usize)
}

/// Applies a calendar message found in `me`'s mailbox, sent by `from` (what happens when it arrives,
/// `itip.rs`): the outcome's word. For tests, which have no mail server.
#[doc(hidden)]
pub async fn apply_calendar_mail(k: &Kernel, tenant: Uuid, me: &str, from: &str, text: &str) -> Result<&'static str> {
    itip::apply(k, tenant, me, from, text).await.map(|a| a.word())
}

/// Signs in to the mail server's administration as hosted mail does (the administrator's password from the environment,
/// else carried by the vault): the administration's account there. For tests, which run a stand-in for the mail server.
#[doc(hidden)]
pub async fn mail_admin_account(k: &Kernel) -> Result<String> {
    hosted::admin_account(k).await
}

include!(concat!(env!("OUT_DIR"), "/packages.rs"));
include!(concat!(env!("OUT_DIR"), "/ui.rs"));

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
        all.extend(ferrum_app_erp::packages().expect("ERP's packages"));
        all.extend(super::packages().expect("app packages"));
        let catalog = ferrum_meta::Catalog::from_packages(all).unwrap_or_else(|e| panic!("{e}"));
        let schema = ferrum_meta::effective::build(&catalog, &["comms".to_string()], &[], 1).unwrap_or_else(|e| panic!("{e}"));
        assert!(schema.warnings.is_empty(), "{:?}", schema.warnings);
        assert!(schema.entity("CalendarFeed").is_some_and(|e| e.secret_fields().count() == 1));
        assert!(super::MANIFEST.contains("packages: [comms]"));
    }

    #[test]
    fn the_interface_is_a_release_the_platform_takes() {
        let m = ferrum_apps::AppManifest::parse(super::MANIFEST).expect("app.yaml");
        let routes: Vec<String> = m.routes().into_iter().map(|(r, _)| r).collect();
        assert_eq!(routes, ["mail", "chat", "calendar", "meet"]);
        assert_eq!(m.public_paths(), ["calendar/rsvp", "meet/guest"]);
        let files = super::UI.iter().map(|(p, b)| (p.to_string(), b.to_vec())).collect();
        let ui = ferrum_apps::ui::prepare("comms", files).expect("ui/dist is an interface release");
        assert!(super::UI.iter().any(|(p, _)| *p == "index.html") && !super::UI.iter().any(|(p, _)| p.starts_with('.')), "{}", ui.digest);
    }

    /// Comms declares the settings the platform's registry moves to it (`app: comms`), each read at each use; the secrets
    /// themselves are no settings.
    #[test]
    fn its_settings_are_declared() {
        let m = ferrum_apps::AppManifest::parse(super::MANIFEST).expect("app.yaml");
        let s: Vec<_> = m.operator_settings.iter().map(|s| (s.env.as_str(), s.applies.as_str(), s.sends.as_deref())).collect();
        // No address is given a secret from the environment: Comms' secrets are its vault's alone, each bound to its hosts.
        assert_eq!(
            s,
            [
                ("FERRUM_MEET_URL", "live", None),
                ("FERRUM_MEET_API_URL", "live", None),
                ("FERRUM_MEET_RECORDINGS", "live", None),
                ("FERRUM_MEET_NODE_IP", "live", None),
                ("FERRUM_MEET_EXTERNAL_IP", "live", None),
                ("FERRUM_MAIL_URL", "live", None),
                ("FERRUM_MAIL_ADMIN", "live", None),
                ("FERRUM_MAIL_HOST", "live", None),
            ]
        );
        let defaults: Vec<_> = m.operator_settings.iter().filter(|s| !s.default.is_empty()).map(|s| (s.key.as_str(), s.default.as_str())).collect();
        assert_eq!(defaults, [("meet_recordings", "false"), ("meet_external_ip", "true")]);
        assert_eq!(super::keys::host("wss://Meet.Example.com:7880/rtc").as_deref(), Some("meet.example.com"));
        assert_eq!(super::keys::host("http://admin@[::1]:8080").as_deref(), Some("::1"));
    }
}
