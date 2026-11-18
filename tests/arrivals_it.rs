//! New hosted mail notifies once, against a real PostgreSQL (`FERRUM_COMMS_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test`; the database is reset first) and a
//! stand-in for the mail server's JMAP. The first look notifies about nothing old; then two
//! maintenance rounds at once see the same new message, and the cursor's compare-and-set lets only
//! one of them store the notification; a later round finds nothing new.

mod common;

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, HookRegistry, Kernel, KernelSettings};
use ferrum_meta::Catalog;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

const PASSWORD: &str = "Correct-Horse-9";

/// The mail server as the step sees it: the Email state is `s1` until mail `arrived`, then `s2`
/// with one new unread Inbox message. Each answer waits a little, so two rounds overlap.
struct Jmap {
    /// The server's state is `s{stage}`; each stage brings the messages MSGS lists for it.
    stage: AtomicUsize,
    requests: AtomicUsize,
}

const MSGS: &[(&str, usize)] = &[("m1", 2), ("m2", 3), ("m3", 3), ("m4", 4), ("m5", 5), ("m6", 5), ("m7", 5)];

/// A message as `Email/get` gives it: (mailbox, from, to, subject, keywords, Message-ID, In-Reply-To).
fn message(id: &str) -> Value {
    let (boxes, from, to, subject, kw, mid, irt) = match id {
        "m1" => ("I", "ann@customer.example", "ann@acme.test", "Quote for March", json!({}), "q1@customer.example", json!(null)),
        "m2" => ("S", "ann@acme.test", "ann@customer.example", "Re: Quote for March", json!({"$seen": true}), "s1@acme.test", json!(["q1@customer.example"])),
        "m3" => ("I", "bo@customer.example", "ann@acme.test", "Hello", json!({}), "h1@customer.example", json!(null)),
        "m4" => ("I", "cy@customer.example", "ann@acme.test", "While private", json!({}), "p1@customer.example", json!(null)),
        "m5" => ("I", "dee@customer.example", "ann@acme.test", "After", json!({}), "a1@customer.example", json!(null)),
        "m6" => ("S", "ann@acme.test", "ed@customer.example", "A draft", json!({"$draft": true, "$seen": true}), "d1@acme.test", json!(null)),
        _ => ("J", "spam@bulk.example", "ann@acme.test", "Win", json!({"$junk": true}), "j1@bulk.example", json!(null)),
    };
    json!({"id": id, "threadId": format!("t-{id}"), "mailboxIds": {boxes: true}, "keywords": kw, "from": [{"name": "Ann Lee", "email": from}],
           "to": [{"email": to}], "cc": [{"email": "Boss@customer.example"}], "messageId": [mid], "inReplyTo": irt,
           "subject": subject, "receivedAt": "2026-11-12T08:00:00Z", "attachments": []})
}

fn answer(j: &Jmap, calls: &[Value]) -> Value {
    let stage = j.stage.load(Ordering::SeqCst);
    let now = format!("s{stage}");
    let mut out = Vec::new();
    let mut created: Vec<&str> = vec![];
    for c in calls {
        let (method, args, id) = (c[0].as_str().unwrap_or_default(), &c[1], &c[2]);
        let body = match method {
            "Mailbox/get" => {
                json!({"list": [{"id": "I", "role": "inbox", "name": "Inbox", "parentId": null, "totalEmails": 1}, {"id": "J", "role": "junk", "name": "Junk", "parentId": null, "totalEmails": 0},
                                {"id": "S", "role": "sent", "name": "Sent", "parentId": null, "totalEmails": 0}]})
            }
            "Email/get" if args.get("#ids").is_some() => json!({"list": created.iter().map(|i| message(i)).collect::<Vec<_>>()}),
            "Email/get" => json!({"state": now, "list": []}),
            "Email/changes" => {
                let since = args["sinceState"].as_str().unwrap_or_default();
                let from: usize = since.trim_start_matches('s').parse().unwrap_or(1);
                created = MSGS.iter().filter(|(_, s)| *s > from && *s <= stage).map(|(m, _)| *m).collect();
                json!({"oldState": since, "newState": now, "hasMoreChanges": false, "created": created, "updated": [], "destroyed": []})
            }
            "SieveScript/get" => json!({"list": []}),
            _ => return json!({"methodResponses": [["error", {"type": "unknownMethod"}, id]]}),
        };
        out.push(json!([method, body, id]));
    }
    json!({"methodResponses": out})
}

async fn serve(j: Arc<Jmap>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { return };
            let j = j.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head_end, length) = loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        break (i + 4, length);
                    }
                };
                while buf.len() < head_end + length {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                j.requests.fetch_add(1, Ordering::SeqCst);
                let request: Value = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let body = answer(&j, request["methodCalls"].as_array().map(Vec::as_slice).unwrap_or_default()).to_string();
                let res = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(res.as_bytes()).await;
            });
        }
    });
    url
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
fn new_mail_notifies_once_across_concurrent_rounds() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let jmap = Arc::new(Jmap { stage: AtomicUsize::new(1), requests: AtomicUsize::new(0) });
    let mail_url = serve(jmap.clone()).await;
    // SAFETY: set before anything reads the environment on other threads of this test binary.
    unsafe { std::env::set_var("FERRUM_MAIL_URL", &mail_url) };

    let url = std::env::var("FERRUM_COMMS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test".into());
    let db = Db::connect(DbConfig { url: url.clone(), max_connections: 12, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists vault cascade; drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    ferrum_kernel::vault::open(&db, opener(&url), false).await.expect("the vault");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_comms::packages().expect("app packages"));
    let mut hooks = HookRegistry::default();
    // As the server registers it: as itself, so that it takes its own vault handle.
    let mut comms = None;
    hooks.app("comms", &[], |h| {
        ferrum_app_comms::register(h);
        comms = Some(h.vault());
    });
    let comms = comms.expect("Comms' handle");
    let comms_packages: Vec<String> = ferrum_app_comms::packages().unwrap().iter().map(|p| p.name().to_string()).collect();
    hooks.own("comms", &comms_packages);
    let k = Kernel::boot(db, Catalog::from_packages(packages).expect("catalog"), hooks, KernelSettings::default(), None).await.expect("boot");
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
    let session = k.login("acme", "admin@acme.test", PASSWORD).await.expect("login");
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx");
    let ann = k.create_user(&admin, "ann@acme.test", "Ann Rao", Some(PASSWORD), &["Comms User".to_string()], false).await.expect("user");
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await.unwrap());
    common::prove(&k, &admin, "acme.test").await;
    k.insert(&sys, "CommsSettings", ferrum_app_comms_test_obj(json!({"mail_domain": "acme.test"}))).await.expect("settings");
    let mailbox = k
        .insert(
            &sys,
            "HostedMailbox",
            ferrum_app_comms_test_obj(json!({"email": "ann@acme.test", "user_id": ann.to_string(), "account_id": "a1", "status": "Active", "secret": "pw"})),
        )
        .await
        .expect("mailbox");
    let mailbox: Uuid = mailbox["id"].as_str().unwrap().parse().unwrap();
    // The mail server's administrator's password, as the operator (or the service mail) keeps it: bound to its host.
    let admin_secret = |hosts: &[&str]| {
        let (k, vault, hosts) = (k.clone(), comms.clone(), hosts.iter().map(|h| h.to_string()).collect::<Vec<_>>());
        async move {
            let rule = ferrum_kernel::vault::Rule { hosts, ..Default::default() };
            let value = ferrum_kernel::vault::New::Value(ferrum_kernel::vault::Zeroizing::new(b"admin-secret".to_vec()));
            vault.set(&k, ferrum_kernel::vault::Scope::Installation, "mail.admin_secret", value, rule).await.unwrap();
        }
    };
    admin_secret(&["127.0.0.1"]).await;

    // Read as the system (the tables have row-level security).
    let count = |sql: &'static str| {
        let k = k.clone();
        async move {
            let mut tx = k.db.system_tx().await.unwrap();
            sqlx::query_scalar::<_, i64>(sql).fetch_one(&mut *tx).await.unwrap()
        }
    };
    let state = || {
        let k = k.clone();
        async move {
            let mut tx = k.db.system_tx().await.unwrap();
            sqlx::query_scalar::<_, Option<String>>("select email_state from comms_mail_cursor").fetch_optional(&mut *tx).await.unwrap().flatten()
        }
    };

    // The first look: where the mailbox is, and nothing old notifies.
    ferrum_app_comms::maintenance(&k, tenant).await.expect("first round");
    assert_eq!(state().await.as_deref(), Some("s1"));
    assert_eq!(count("select count(*) from notification where kind = 'comms.newmail'").await, 0);

    // Mail arrives; two rounds at once (two replicas) both see it: one notification.
    jmap.stage.store(2, Ordering::SeqCst);
    let before = jmap.requests.load(Ordering::SeqCst);
    let (a, b) = tokio::join!(ferrum_app_comms::maintenance(&k, tenant), ferrum_app_comms::maintenance(&k, tenant));
    a.expect("round a");
    b.expect("round b");
    assert!(jmap.requests.load(Ordering::SeqCst) - before >= 2, "both rounds asked the mail server");
    assert_eq!(state().await.as_deref(), Some("s2"));
    assert_eq!(count("select count(*) from notification where kind = 'comms.newmail'").await, 1, "notified once");
    assert_eq!(count("select count(*) from comms_mail_notice").await, 1, "one notice for it, in the same transaction");
    let mut tx = k.db.system_tx().await.unwrap();
    let (title, body, entity): (String, Option<String>, Option<String>) =
        sqlx::query_as("select title, body, entity from notification where kind = 'comms.newmail'").fetch_one(&mut *tx).await.unwrap();
    assert_eq!((title.as_str(), body.as_deref(), entity.as_deref()), ("New message from Ann Lee", Some("Ann Lee: Quote for March"), Some("MailMessage")));
    let (who, email): (Uuid, Option<String>) = sqlx::query_as("select user_id, email_id from comms_mail_notice").fetch_one(&mut *tx).await.unwrap();
    drop(tx);
    assert_eq!((who, email.as_deref()), (ann, Some("m1")));

    // Nothing new: nothing more.
    ferrum_app_comms::maintenance(&k, tenant).await.expect("later round");
    assert_eq!(count("select count(*) from notification where kind = 'comms.newmail'").await, 1);
    let mut tx = k.db.system_tx().await.unwrap();
    let failures: i32 = sqlx::query_scalar("select failures from comms_mail_cursor where mailbox_id = $1").bind(mailbox).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(failures, 0);
    drop(tx);

    // ───────────── what apps may file: nothing until the owner says so, never a private mailbox ─────────────
    let events = || {
        let k = k.clone();
        async move {
            let mut tx = k.db.system_tx().await.unwrap();
            sqlx::query_as::<_, (String, Option<Uuid>, Value)>("select topic, record_id, payload from outbox where topic like 'MailMessage.%' order by id")
                .fetch_all(&mut *tx)
                .await
                .unwrap()
        }
    };
    assert!(events().await.is_empty(), "by default no mail is told to apps: m1 arrived and nothing was raised");
    let site = |ctx: Ctx, method: &str, path: &str, body: Value| {
        let k = k.clone();
        let (method, path) = (method.to_string(), path.to_string());
        async move {
            let req = ferrum_kernel::SiteRequest {
                tenant,
                user: Some(ctx),
                method,
                path,
                query: Default::default(),
                headers: Default::default(),
                body: body.to_string().into_bytes(),
                client_ip: "127.0.0.1".into(),
            };
            k.hooks.site("comms").unwrap().handle(&k, req).await
        }
    };
    let me = k.load_ctx(tenant, ann, None, "it".into()).await.unwrap();
    let off = site(me.clone(), "GET", "mail/filing", Value::Null).await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&off.body).unwrap(), json!({"apps_may_file": false, "private": false, "filed": false}));
    // Only a manager marks a mailbox private; the owner chooses for their own.
    assert!(site(me.clone(), "PUT", "mail/filing/private", json!({"email": "ann@acme.test", "private": true})).await.is_err());
    site(me.clone(), "PUT", "mail/filing", json!({"apps_may_file": true})).await.unwrap();

    // Mail sent and received from then on is raised once each, whichever replica sees it, and no more.
    jmap.stage.store(3, Ordering::SeqCst);
    let (a, b) = tokio::join!(ferrum_app_comms::maintenance(&k, tenant), ferrum_app_comms::maintenance(&k, tenant));
    a.expect("round a");
    b.expect("round b");
    let found = events().await;
    assert_eq!(
        found.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        ["MailMessage.sent", "MailMessage.received"],
        "the sent one and the received one, once: {found:?}"
    );
    let sent = &found[0].2;
    assert_eq!(
        (sent["email"].clone(), sent["thread"].clone(), sent["message_id"].clone(), sent["in_reply_to"].clone(), sent["from"].clone(), sent["to"].clone()),
        (json!("m2"), json!("t-m2"), json!("s1@acme.test"), json!(["q1@customer.example"]), json!("ann@acme.test"), json!(["ann@customer.example"]))
    );
    assert_eq!((sent["mailbox"].clone(), sent["mailbox_address"].clone(), sent["owner"].clone()), (json!(mailbox), json!("ann@acme.test"), json!(ann)));
    let got = &found[1].2;
    assert_eq!(
        (got["from"].clone(), got["cc"].clone(), got["subject"].clone()),
        (json!("bo@customer.example"), json!(["boss@customer.example"]), json!("Hello"))
    );
    let keys: Vec<&str> = got.as_object().unwrap().keys().map(String::as_str).collect();
    assert!(keys.iter().all(|k| !["body", "text", "html", "content", "attachments", "preview"].contains(k)), "never what the message says: {keys:?}");
    assert_ne!(found[0].1, found[1].1);

    // A mailbox the workspace marks private is not told, whatever its owner chose.
    let admin_site = site(admin.clone(), "PUT", "mail/filing/private", json!({"email": "Ann@acme.test", "private": true})).await.unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&admin_site.body).unwrap(), json!({"email": "ann@acme.test", "private": true}));
    assert_eq!(serde_json::from_slice::<Value>(&site(me.clone(), "GET", "mail/filing", Value::Null).await.unwrap().body).unwrap()["filed"], json!(false));
    jmap.stage.store(4, Ordering::SeqCst);
    ferrum_app_comms::maintenance(&k, tenant).await.expect("round while private");
    assert_eq!(events().await.len(), 2, "m4 arrived while private: nothing raised");
    // Unmarked, it goes on from there: not what came while it was private, and not drafts or junk.
    site(admin.clone(), "PUT", "mail/filing/private", json!({"email": "ann@acme.test", "private": false})).await.unwrap();
    jmap.stage.store(5, Ordering::SeqCst);
    ferrum_app_comms::maintenance(&k, tenant).await.expect("round after");
    let found = events().await;
    assert_eq!(found.len(), 3, "m5 only: {found:?}");
    assert_eq!((found[2].0.as_str(), found[2].2["email"].clone()), ("MailMessage.received", json!("m5")));
    // The owner turns it off again: nothing more.
    site(me.clone(), "PUT", "mail/filing", json!({"apps_may_file": false})).await.unwrap();

    // ───────────── people's passwords go only to the mail server the vault knows ─────────────
    // What the server resolved: the mail server's address (from the settings table).
    let resolved = |url: &str| ferrum_kernel::env::set([("FERRUM_MAIL_URL".to_string(), Some(url.to_string()))].into());
    // Whether a round of upkeep sent the mailbox's password to the mail server.
    let sent = || {
        let (k, jmap) = (k.clone(), jmap.clone());
        async move {
            let before = jmap.requests.load(Ordering::SeqCst);
            ferrum_app_comms::maintenance(&k, tenant).await.expect("a round");
            jmap.requests.load(Ordering::SeqCst) > before
        }
    };
    // The same host on another port: the same server.
    let other_port = serve(jmap.clone()).await;
    resolved(&other_port);
    assert!(sent().await, "the same host, another port");
    // A stored address changed to another host: no password goes there, and the person is told why.
    let elsewhere = other_port.replace("127.0.0.1", "localhost");
    resolved(&elsewhere);
    assert!(!sent().await, "nothing sent to another host");
    let told = format!("{:?}", site(me.clone(), "GET", "mail", Value::Null).await.map(|r| r.status));
    assert!(told.contains("may not be sent to localhost"), "{told}");
    // The operator names that host in the rule (the mail server moved there): passwords go there.
    admin_secret(&["127.0.0.1", "localhost"]).await;
    assert!(sent().await, "the vault's rule names this host");
    // No administrator's password in the vault: no mail server it knows, none goes anywhere.
    comms.remove(&k, ferrum_kernel::vault::Scope::Installation, "mail.admin_secret").await.unwrap();
    assert!(!sent().await, "nothing sent without the vault's mail server");
    ferrum_kernel::env::set(Default::default());
}

fn ferrum_app_comms_test_obj(v: Value) -> ferrum_kernel::Doc {
    v.as_object().cloned().unwrap()
}
