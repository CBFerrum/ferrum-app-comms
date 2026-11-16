//! What Comms takes from the platform, against a real PostgreSQL (`FERRUM_COMMS_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test`; reset first).
//!
//! * Its addresses, with no public address of its own: the links people follow go through the operator's link host (a
//!   page of the interface, to `s`), and the addresses services call (the inbound address, a calendar feed) start at the
//!   hooks host. With an address of its own, nothing changes; with none at all, there is none.
//! * Its calendar reads over CalDAV, in a workspace that records reads of calendar events: each event opened, and each
//!   listing, is on the audit trail as the platform's own reads are, and a read that cannot be recorded is refused.

use async_trait::async_trait;
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::zones::{Credential, Entry, Placed, Zones};
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, Mailer, SiteRequest, SiteResponse};
use ferrum_meta::Catalog;
use serde_json::{Map, Value, json};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const PASSWORD: &str = "Correct-Horse-9";

/// The server's own mailer: keeps what it would send (to, subject, body).
#[derive(Clone, Default)]
struct Mails(Arc<Mutex<Vec<(String, String, String)>>>);

#[async_trait]
impl Mailer for Mails {
    async fn send(&self, to: &str, subject: &str, html: &str) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().push((to.into(), subject.into(), html.into()));
        Ok(())
    }
}

fn url() -> String {
    std::env::var("FERRUM_COMMS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test".into())
}

async fn kernel(settings: KernelSettings, mails: Mails) -> Arc<Kernel> {
    let db = Db::connect(DbConfig { url: url(), max_connections: 8, ..Default::default() }).await.expect("connect");
    ferrum_kernel::vault::open(&db, opener(&url()), false).await.expect("the vault");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_comms::packages().expect("app packages"));
    let mut hooks = HookRegistry::default();
    // As the server registers it: as itself, so that it takes its own vault handle.
    hooks.app("comms", &[], ferrum_app_comms::register);
    let comms_packages: Vec<String> = ferrum_app_comms::packages().unwrap().iter().map(|p| p.name().to_string()).collect();
    hooks.own("comms", &comms_packages);
    let settings = KernelSettings { secret_key: Some(ferrum_kernel::secret::SecretKey::new([7u8; 32])), ..settings };
    Kernel::boot(db, Catalog::from_packages(packages).expect("catalog"), hooks, settings, Some(Arc::new(mails))).await.expect("boot")
}

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(v: &Value) -> Uuid {
    v["id"].as_str().unwrap().parse().unwrap()
}

fn request(tenant: Uuid, who: &Ctx, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> SiteRequest {
    let mut h = Map::new();
    h.insert("content-type".into(), json!("text/xml; charset=utf-8"));
    for (k, v) in headers {
        h.insert(k.to_string(), json!(v));
    }
    SiteRequest {
        tenant,
        user: Some(who.clone()),
        method: method.into(),
        path: path.into(),
        query: Map::new(),
        headers: h,
        body: body.as_bytes().to_vec(),
        client_ip: "127.0.0.1".into(),
    }
}

async fn call(k: &Kernel, req: SiteRequest) -> Result<SiteResponse, Error> {
    k.hooks.site("comms").expect("comms site").handle(k, req).await
}

/// The reads recorded so far: (action, details), oldest first.
async fn reads(k: &Kernel, tenant: Uuid) -> Vec<(String, Value)> {
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    let rows = sqlx::query_as("select action, diff from audit_event where tenant_id = $1 and category = 'access' order by id")
        .bind(tenant)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rows
}

/// What opens the test's vault: the database password of `url`, with Argon2id kept cheap for tests.
fn opener(url: &str) -> ferrum_kernel::vault::Opener {
    ferrum_kernel::vault::Opener {
        database_url: url.to_string(),
        file: "/nonexistent/root.key".into(),
        kdf: ferrum_kernel::vault::Kdf { m_kib: 64, t: 1, p: 1 },
        ..Default::default()
    }
}

#[test]
fn platform_names_and_recorded_reads() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let db = Db::connect(DbConfig { url: url(), max_connections: 2, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists vault cascade; drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    db.pool.close().await;
    let named = KernelSettings {
        public_url: Some("https://erp.acme.test".into()),
        link_host: Some("go.acme.test".into()),
        hooks_url: Some("https://hooks.acme.test".into()),
        ..Default::default()
    };
    let k = kernel(named, Mails::default()).await;
    let tenant = k
        .create_tenant(NewTenant {
            slug: "acme".into(),
            name: "Acme Ltd".into(),
            admin_email: "admin@acme.test".into(),
            admin_password: PASSWORD.into(),
            admin_name: None,
            packages: vec!["core".into(), "comms".into()],
            settings: None,
        })
        .await
        .expect("tenant");
    let session = k.login("acme", "admin@acme.test", PASSWORD).await.unwrap();
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.unwrap();
    let mgr_id = k.create_user(&admin, "mgr@acme.test", "Meera Manager", Some(PASSWORD), &["Comms Manager".into(), "Comms User".into()], false).await.unwrap();
    let alice_id = k.create_user(&admin, "alice@acme.test", "Alice Rao", Some(PASSWORD), &["Comms User".into()], false).await.unwrap();
    let mgr = k.load_ctx(tenant, mgr_id, None, "it".into()).await.unwrap();
    let alice = k.load_ctx(tenant, alice_id, None, "it".into()).await.unwrap();

    // ───── Comms has no address of its own: the platform's ─────
    // Services call the inbound address and a calendar feed: the hooks host, which takes their posts.
    let account =
        k.insert(&mgr, "EmailAccount", obj(json!({"account_name": "Sales", "email_address": "sales@acme.test", "enable_outgoing": false}))).await.unwrap();
    let account = uid(&Value::Object(account));
    let hook = k.run_action(&mgr, "EmailAccount", account, "rotate_inbound_token", json!({})).await.unwrap();
    let token = hook["token"].as_str().unwrap();
    assert_eq!(hook["url"], json!(format!("https://hooks.acme.test/api/site/acme/comms/inbound/{token}")));
    let feed = call(&k, request(tenant, &alice, "POST", "/calendar/feed", &[], "")).await.unwrap();
    let feed: Value = serde_json::from_slice(&feed.body).unwrap();
    assert_eq!(feed["url"], json!(format!("https://hooks.acme.test/api/site/acme/comms/calendar/{}.ics", feed["token"].as_str().unwrap())));
    // A guest answers an invitation on a page of the interface: through the link host, to the workspace's main host.
    let soon = chrono::Utc::now() + chrono::Duration::days(1);
    let iso = |t: chrono::DateTime<chrono::Utc>| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let event = k
        .insert(
            &alice,
            "CalendarEvent",
            obj(json!({"subject": "Plan review", "starts_at": iso(soon), "ends_at": iso(soon + chrono::Duration::minutes(30)), "attendees": [{"email": "pat@partner.test"}]})),
        )
        .await
        .unwrap();
    let event = uid(&Value::Object(event));
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    let invitation: String = sqlx::query_scalar("select content from e_communication where tenant_id = $1 and recipients = 'pat@partner.test'")
        .bind(tenant)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(invitation.contains("https://go.acme.test/go/acme/s/calendar/rsvp/acme/r."), "{invitation}");
    // A meeting's pages are pages of the interface too.
    // SAFETY: the one test in this process.
    unsafe {
        std::env::set_var("FERRUM_MEET_URL", "wss://meet.acme.test/");
        std::env::set_var("FERRUM_MEET_KEY", "APIacme");
        std::env::set_var("FERRUM_MEET_SECRET", "a-secret-only-livekit-and-ferrum-know");
    }
    use ferrum_app_comms::meetings::{self as m, MeetingError, NewMeeting};
    let start = chrono::Utc::now() + chrono::Duration::minutes(5);
    let new = NewMeeting {
        entity: "Booking",
        record: Uuid::now_v7(),
        title: "Haircut",
        starts_at: start,
        ends_at: start + chrono::Duration::hours(1),
        host: alice_id,
    };
    let meeting = m::create(&k, tenant, new).await.unwrap();
    assert_eq!(m::member_link(&k, tenant, meeting.id).await.unwrap(), format!("https://go.acme.test/go/acme/s/meet/room/{}", meeting.id));
    let guest = m::guest_link(&k, tenant, meeting.id, "Pat", "pat@partner.test").await.unwrap();
    assert!(guest.url.starts_with("https://go.acme.test/go/acme/s/meet/guest/acme/m."), "{}", guest.url);

    // ───── With an address of its own, nothing changes ─────
    let settings = uid(&Value::Object(k.list(&mgr, "CommsSettings", &Default::default()).await.unwrap().rows[0].clone()));
    k.update(&mgr, "CommsSettings", settings, obj(json!({"public_url": "https://comms.acme.test/"})), None).await.unwrap();
    let hook = k.run_action(&mgr, "EmailAccount", account, "rotate_inbound_token", json!({})).await.unwrap();
    assert_eq!(hook["url"], json!(format!("https://comms.acme.test/api/site/acme/comms/inbound/{}", hook["token"].as_str().unwrap())));
    assert!(m::guest_link(&k, tenant, meeting.id, "Pat", "pat@partner.test").await.unwrap().url.starts_with("https://comms.acme.test/meet/guest/acme/m."));
    k.update(&mgr, "CommsSettings", settings, obj(json!({"public_url": null})), None).await.unwrap();

    // ───── No address at all (development): none, as before ─────
    let bare = kernel(KernelSettings::default(), Mails::default()).await;
    let hook = bare.run_action(&mgr, "EmailAccount", account, "rotate_inbound_token", json!({})).await.unwrap();
    assert_eq!((hook["url"].clone(), hook["path"].as_str().is_some()), (Value::Null, true));
    assert!(matches!(m::guest_link(&bare, tenant, meeting.id, "Pat", "pat@partner.test").await, Err(MeetingError::NoPublicAddress)));

    // ───── Calendar reads over CalDAV, recorded where the workspace marks calendar events ─────
    let mark = |level: &str| obj(json!({"record_reads": {"CalendarEvent": level}}));
    k.update_tenant_settings(&admin, &mark("open")).await.expect("marked");
    // A calendar app signs in with an app password, as the server's DAV address does it.
    let entry = Arc::new(Entry { zones: Arc::new(Zones::default()), placed: Placed::Nowhere, address: "127.0.0.1".into(), credential: Credential::Dav });
    let app = || {
        let (k, entry) = (k.clone(), entry.clone());
        async move { k.request_ctx(tenant, alice_id, None, Uuid::now_v7().to_string(), &entry).await.unwrap() }
    };
    let home = format!("/dav/u/{alice_id}/calendars/default");
    let item = format!("{home}/{event}.ics");
    let opened =
        |reads: &[(String, Value)]| reads.iter().filter(|(a, d)| a == "open" && d["entity"] == json!("CalendarEvent") && d["record"] == json!(event)).count();
    let listed = |reads: &[(String, Value)]| reads.iter().filter(|(a, d)| a == "list" && d["entity"] == json!("CalendarEvent")).count();
    let before = reads(&k, tenant).await;
    let got = call(&k, request(tenant, &app().await, "GET", &item, &[], "")).await.unwrap();
    assert!(got.status == 200 && String::from_utf8_lossy(&got.body).contains("Plan review"));
    let after = reads(&k, tenant).await;
    assert_eq!(opened(&after), opened(&before) + 1, "one event opened by a calendar app is recorded");
    let it = after.iter().rev().find(|(a, _)| a == "open").unwrap();
    assert_eq!(it.1["credential"], json!("dav"), "as what it was read with: {}", it.1);
    let propfind = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>"#;
    call(&k, request(tenant, &app().await, "PROPFIND", &item, &[("depth", "0")], propfind)).await.unwrap();
    assert_eq!(opened(&reads(&k, tenant).await), opened(&before) + 2, "and one looked at by name");
    call(&k, request(tenant, &app().await, "PROPFIND", &home, &[("depth", "1")], propfind)).await.unwrap();
    assert_eq!(listed(&reads(&k, tenant).await), 0, "a workspace that records opened events only: listings are not");
    k.update_tenant_settings(&admin, &mark("all")).await.expect("marked");
    call(&k, request(tenant, &app().await, "PROPFIND", &home, &[("depth", "1")], propfind)).await.unwrap();
    let now = reads(&k, tenant).await;
    assert_eq!(listed(&now), 1, "a calendar listed");
    assert_eq!(now.last().unwrap().1["rows"], json!(1));
    let query = r#"<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop>
        <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20000101T000000Z" end="21000101T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#;
    call(&k, request(tenant, &app().await, "REPORT", &home, &[("depth", "1")], query)).await.unwrap();
    let now = reads(&k, tenant).await;
    assert_eq!(listed(&now), 2, "a query");
    assert_eq!(
        now.last().unwrap().1["query"]["filters"],
        json!([{"field": "ends_at", "op": "gt"}, {"field": "starts_at", "op": "lt"}]),
        "narrowed by when, not the times"
    );
    let multiget = format!(
        r#"<?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/api/dav/comms/u/{alice_id}/calendars/default/{event}.ics</d:href></c:calendar-multiget>"#
    );
    call(&k, request(tenant, &app().await, "REPORT", &home, &[("depth", "1")], &multiget)).await.unwrap();
    assert_eq!(opened(&reads(&k, tenant).await), opened(&before) + 3, "an event fetched by name in a report");
    let sync = |token: &str| {
        format!(
            r#"<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>{token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>"#
        )
    };
    let first = call(&k, request(tenant, &app().await, "REPORT", &home, &[], &sync(""))).await.unwrap();
    assert_eq!(listed(&reads(&k, tenant).await), 3, "a sync that lists the calendar");
    let body = String::from_utf8_lossy(&first.body).into_owned();
    let token = body.split("<D:sync-token>").nth(1).and_then(|t| t.split("</D:sync-token>").next()).unwrap().to_string();
    let count = reads(&k, tenant).await.len();
    call(&k, request(tenant, &app().await, "REPORT", &home, &[], &sync(&token))).await.unwrap();
    call(
        &k,
        request(
            tenant,
            &app().await,
            "PROPFIND",
            &format!("/dav/u/{alice_id}/calendars"),
            &[("depth", "1")],
            r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>"#,
        ),
    )
    .await
    .unwrap();
    assert_eq!(reads(&k, tenant).await.len(), count, "nothing new to say, and a calendar's tag, show no event: nothing recorded");
    // A read that cannot be recorded is not given.
    sqlx::raw_sql(
        "create function it_no_access() returns trigger language plpgsql as $$ begin raise exception 'no access events'; end $$; \
         create trigger it_no_access before insert on audit_event for each row when (new.category = 'access') execute function it_no_access()",
    )
    .execute(&k.db.pool)
    .await
    .unwrap();
    assert!(call(&k, request(tenant, &app().await, "GET", &item, &[], "")).await.is_err(), "refused, and nothing of the event goes out");
    assert!(call(&k, request(tenant, &app().await, "PROPFIND", &home, &[("depth", "1")], propfind)).await.is_err());
    sqlx::raw_sql("drop trigger it_no_access on audit_event; drop function it_no_access()").execute(&k.db.pool).await.unwrap();
    // Unmarked, nothing is recorded and nothing is asked.
    k.update_tenant_settings(&admin, &obj(json!({"record_reads": null}))).await.expect("unmarked");
    let count = reads(&k, tenant).await.len();
    call(&k, request(tenant, &app().await, "GET", &item, &[], "")).await.unwrap();
    assert_eq!(reads(&k, tenant).await.len(), count);
}
