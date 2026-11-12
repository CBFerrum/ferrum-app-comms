//! New hosted mail notifies once, against a real PostgreSQL (`FERRUM_COMMS_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test`; the database is reset first) and a
//! stand-in for the mail server's JMAP. The first look notifies about nothing old; then two
//! maintenance rounds at once see the same new message, and the cursor's compare-and-set lets only
//! one of them store the notification; a later round finds nothing new.

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, HookRegistry, Kernel, KernelSettings};
use ferrum_meta::Catalog;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

const PASSWORD: &str = "Correct-Horse-9";

/// The mail server as the step sees it: the Email state is `s1` until mail `arrived`, then `s2`
/// with one new unread Inbox message. Each answer waits a little, so two rounds overlap.
struct Jmap {
    arrived: AtomicBool,
    requests: AtomicUsize,
}

fn answer(j: &Jmap, calls: &[Value]) -> Value {
    let now = if j.arrived.load(Ordering::SeqCst) { "s2" } else { "s1" };
    let mut out = Vec::new();
    let mut created: Vec<&str> = vec![];
    for c in calls {
        let (method, args, id) = (c[0].as_str().unwrap_or_default(), &c[1], &c[2]);
        let body = match method {
            "Mailbox/get" => {
                json!({"list": [{"id": "I", "role": "inbox", "name": "Inbox", "parentId": null, "totalEmails": 1}, {"id": "J", "role": "junk", "name": "Junk", "parentId": null, "totalEmails": 0}]})
            }
            "Email/get" if args.get("#ids").is_some() => json!({"list": created.iter().map(|i| json!({
                "id": i, "threadId": "t1", "mailboxIds": {"I": true}, "keywords": {}, "from": [{"name": "Ann Lee", "email": "ann@customer.example"}],
                "subject": "Quote for March", "receivedAt": "2026-11-12T08:00:00Z", "attachments": []})).collect::<Vec<_>>()}),
            "Email/get" => json!({"state": now, "list": []}),
            "Email/changes" => {
                let since = args["sinceState"].as_str().unwrap_or_default();
                if since == "s1" && now == "s2" {
                    created = vec!["m1"];
                }
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

#[test]
fn new_mail_notifies_once_across_concurrent_rounds() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let jmap = Arc::new(Jmap { arrived: AtomicBool::new(false), requests: AtomicUsize::new(0) });
    let mail_url = serve(jmap.clone()).await;
    // SAFETY: set before anything reads the environment on other threads of this test binary.
    unsafe { std::env::set_var("FERRUM_MAIL_URL", &mail_url) };

    let url = std::env::var("FERRUM_COMMS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 12, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_comms::packages().expect("app packages"));
    let mut hooks = HookRegistry::default();
    ferrum_app_comms::register(&mut hooks);
    let settings = KernelSettings { secret_key: Some(ferrum_kernel::secret::SecretKey::new([7u8; 32])), ..Default::default() };
    let k = Kernel::boot(db, Catalog::from_packages(packages).expect("catalog"), hooks, settings, None).await.expect("boot");
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
    ferrum_app_comms::maintenance(&k).await.expect("first round");
    assert_eq!(state().await.as_deref(), Some("s1"));
    assert_eq!(count("select count(*) from notification where kind = 'comms.newmail'").await, 0);

    // Mail arrives; two rounds at once (two replicas) both see it: one notification.
    jmap.arrived.store(true, Ordering::SeqCst);
    let before = jmap.requests.load(Ordering::SeqCst);
    let (a, b) = tokio::join!(ferrum_app_comms::maintenance(&k), ferrum_app_comms::maintenance(&k));
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
    ferrum_app_comms::maintenance(&k).await.expect("later round");
    assert_eq!(count("select count(*) from notification where kind = 'comms.newmail'").await, 1);
    let mut tx = k.db.system_tx().await.unwrap();
    let failures: i32 = sqlx::query_scalar("select failures from comms_mail_cursor where mailbox_id = $1").bind(mailbox).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(failures, 0);
}

fn ferrum_app_comms_test_obj(v: Value) -> ferrum_kernel::Doc {
    v.as_object().cloned().unwrap()
}
