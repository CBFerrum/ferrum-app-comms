//! End-to-end communications test against a real PostgreSQL (`FERRUM_COMMS_TEST_DATABASE_URL`,
//! default `postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test`). The database is reset first.
//!
//! A sales team mails a customer from its record through a real (in-process) SMTP server, gets
//! the reply through the inbound webhook and a fake IMAP mailbox, survives SMTP outages, sends a
//! newsletter within an hourly limit, chats in private, direct and public channels, and plans a
//! recurring meeting with a colleague and an outside guest — with the refusal paths along the way.

use async_trait::async_trait;
use base64::Engine as _;
use ferrum_app_comms::{Account, Mailbox, MailboxConnector};
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, Mailer, SiteRequest, SiteResponse};
use ferrum_meta::Catalog;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use uuid::Uuid;

const PASSWORD: &str = "Correct-Horse-9";

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(v: &Value) -> Uuid {
    v["id"].as_str().unwrap_or_else(|| panic!("no id in {v}")).parse().unwrap()
}

/// A refusal of the expected kind.
fn refused<T: std::fmt::Debug>(r: Result<T, Error>, kind: &str) {
    let ok = matches!(
        (&r, kind),
        (Err(Error::NotFound(_)), "not found")
            | (Err(Error::Forbidden(_)), "forbidden")
            | (Err(Error::Invalid(_) | Error::Validation(_)), "invalid")
            | (Err(Error::Conflict(_)), "conflict")
    );
    assert!(ok, "expected {kind}, got {r:?}");
}

// ───────────────────────────── an SMTP server that records what it receives ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    #[default]
    Accept,
    /// 451 on MAIL FROM.
    Transient,
    /// 550 on RCPT TO.
    Permanent,
}

#[derive(Clone, Debug)]
struct Received {
    to: Vec<String>,
    data: String,
}

#[derive(Default)]
struct SmtpState {
    mode: Mode,
    mails: Vec<Received>,
    logins: Vec<String>,
}

#[derive(Clone, Default)]
struct Smtp(Arc<Mutex<SmtpState>>);

impl Smtp {
    fn set_mode(&self, m: Mode) {
        self.0.lock().unwrap().mode = m;
    }
    fn mails(&self) -> Vec<Received> {
        self.0.lock().unwrap().mails.clone()
    }
    fn count(&self) -> usize {
        self.0.lock().unwrap().mails.len()
    }

    async fn start(&self) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = self.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let st = me.clone();
                tokio::spawn(async move {
                    let _ = st.session(sock).await;
                });
            }
        });
        port
    }

    async fn session(&self, sock: tokio::net::TcpStream) -> std::io::Result<()> {
        let (r, mut w) = sock.into_split();
        let mut r = BufReader::new(r);
        w.write_all(b"220 sink.test ESMTP\r\n").await?;
        let mut to = Vec::new();
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).await? == 0 {
                return Ok(());
            }
            let cmd = line.trim_end().to_string();
            let up = cmd.to_ascii_uppercase();
            let mode = self.0.lock().unwrap().mode;
            let reply: &[u8] = if up.starts_with("EHLO") || up.starts_with("HELO") {
                b"250-sink.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n"
            } else if let Some(b64) = cmd.strip_prefix("AUTH PLAIN ") {
                let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).unwrap_or_default();
                self.0.lock().unwrap().logins.push(String::from_utf8_lossy(&raw).replace('\0', "|"));
                b"235 2.7.0 Authentication successful\r\n"
            } else if up.starts_with("MAIL FROM") {
                if mode == Mode::Transient { b"451 4.3.0 Try again later\r\n" } else { b"250 OK\r\n" }
            } else if up.starts_with("RCPT TO") {
                if mode == Mode::Permanent {
                    b"550 5.1.1 No such user\r\n"
                } else {
                    to.push(cmd[8..].trim().trim_start_matches(':').trim().trim_matches(['<', '>']).to_string());
                    b"250 OK\r\n"
                }
            } else if up == "DATA" {
                w.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n").await?;
                let mut data = String::new();
                loop {
                    let mut l = String::new();
                    if r.read_line(&mut l).await? == 0 {
                        return Ok(());
                    }
                    if l == ".\r\n" {
                        break;
                    }
                    data.push_str(l.strip_prefix('.').filter(|_| l.starts_with("..")).unwrap_or(&l));
                }
                self.0.lock().unwrap().mails.push(Received { to: std::mem::take(&mut to), data });
                b"250 2.0.0 Queued\r\n"
            } else if up == "QUIT" {
                w.write_all(b"221 Bye\r\n").await?;
                return Ok(());
            } else if up == "RSET" {
                to.clear();
                b"250 OK\r\n"
            } else {
                b"250 OK\r\n"
            };
            w.write_all(reply).await?;
        }
    }
}

/// The server's own mailer (fallback when no account sends).
#[derive(Clone, Default)]
struct TestMailer(Arc<Mutex<Vec<(String, String)>>>);

#[async_trait]
impl Mailer for TestMailer {
    async fn send(&self, to: &str, subject: &str, _html: &str) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().push((to.to_string(), subject.to_string()));
        Ok(())
    }
}

// ───────────────────────────── a fake IMAP mailbox ─────────────────────────────

#[derive(Default)]
struct ImapState {
    validity: u32,
    messages: Vec<(u32, Vec<u8>)>,
    connects: usize,
    passwords: Vec<String>,
}

#[derive(Clone, Default)]
struct FakeImap(Arc<Mutex<ImapState>>);

struct FakeBox(Arc<Mutex<ImapState>>);

#[async_trait]
impl MailboxConnector for FakeImap {
    async fn connect(&self, account: &Account) -> ferrum_kernel::Result<Box<dyn Mailbox>> {
        let mut st = self.0.lock().unwrap();
        st.connects += 1;
        st.passwords.push(account.imap.as_ref().and_then(|s| s.password.clone()).unwrap_or_default());
        Ok(Box::new(FakeBox(self.0.clone())))
    }
}

#[async_trait]
impl Mailbox for FakeBox {
    async fn select(&mut self, folder: &str) -> ferrum_kernel::Result<u32> {
        assert_eq!(folder, "INBOX");
        Ok(self.0.lock().unwrap().validity)
    }
    async fn uids_after(&mut self, after: u32) -> ferrum_kernel::Result<Vec<u32>> {
        Ok(self.0.lock().unwrap().messages.iter().map(|m| m.0).filter(|u| *u > after).collect())
    }
    async fn fetch(&mut self, uid: u32, max: usize) -> ferrum_kernel::Result<Option<(Vec<u8>, bool)>> {
        let st = self.0.lock().unwrap();
        Ok(st.messages.iter().find(|m| m.0 == uid).map(|m| (m.1.clone(), m.1.len() > max)))
    }
    async fn logout(&mut self) {}
}

// ───────────────────────────── harness ─────────────────────────────

async fn fresh_kernel(mailer: TestMailer) -> Arc<Kernel> {
    let url = std::env::var("FERRUM_COMMS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 12, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    // Only this package and what it depends on: other packages' work in progress cannot break it.
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_comms::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_app_comms::register(&mut hooks);
    for source in ferrum_app_comms::reports() {
        ferrum_domain::reports::add_source(source);
    }
    let settings = KernelSettings { secret_key: Some(ferrum_kernel::secret::SecretKey::new([7u8; 32])), ..Default::default() };
    let k = Kernel::boot(db, catalog, hooks, settings, Some(Arc::new(mailer))).await.expect("boot");
    k.set_file_store(Arc::new(MemStore::default()));
    k
}

/// The platform's object storage, in memory.
#[derive(Default)]
struct MemStore(Mutex<HashMap<String, Vec<u8>>>);

#[async_trait]
impl ferrum_kernel::files::FileStore for MemStore {
    async fn put(&self, key: &str, data: &[u8]) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().insert(key.to_string(), data.to_vec());
        Ok(())
    }
    async fn get(&self, key: &str) -> ferrum_kernel::Result<Vec<u8>> {
        self.0.lock().unwrap().get(key).cloned().ok_or_else(|| Error::NotFound("object".into()))
    }
    async fn delete(&self, key: &str) -> ferrum_kernel::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

struct T {
    k: Arc<Kernel>,
    tenant: Uuid,
}

impl T {
    fn request(&self, ctx: Option<&Ctx>, method: &str, path: &str, query: &[(&str, &str)], body: Vec<u8>, ctype: &str) -> SiteRequest {
        let mut headers = Map::new();
        headers.insert("content-type".into(), json!(ctype));
        SiteRequest {
            tenant: self.tenant,
            user: ctx.cloned(),
            method: method.into(),
            path: path.into(),
            query: query.iter().map(|(k, v)| (k.to_string(), json!(v))).collect(),
            headers,
            body,
            client_ip: "127.0.0.1".into(),
        }
    }

    async fn raw(&self, req: SiteRequest) -> Result<SiteResponse, Error> {
        self.k.hooks.site("comms").expect("comms site").handle(&self.k, req).await
    }

    /// A JSON call to `/api/app/comms{path}` as `ctx` (or the public site without one).
    async fn call(&self, ctx: Option<&Ctx>, method: &str, path: &str, query: &[(&str, &str)], body: Value) -> Result<Value, Error> {
        let bytes = if body.is_null() { vec![] } else { body.to_string().into_bytes() };
        let r = self.raw(self.request(ctx, method, path, query, bytes, "application/json")).await?;
        assert!(r.status < 300, "{method} {path}: {}", String::from_utf8_lossy(&r.body));
        Ok(serde_json::from_slice(&r.body).unwrap_or(Value::Null))
    }

    async fn ok(&self, ctx: &Ctx, method: &str, path: &str, query: &[(&str, &str)], body: Value) -> Value {
        match self.call(Some(ctx), method, path, query, body).await {
            Ok(v) => v,
            Err(e) => panic!("{method} {path} as {}: {e:?}", ctx.email),
        }
    }

    async fn drain(&self) {
        while self.k.dispatch_outbox_once().await.expect("dispatch") > 0 {}
    }

    async fn scalar<O: Send + Unpin + for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>>(&self, sql: &str, id: Option<Uuid>) -> O {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let v: O = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
            .bind(self.tenant)
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
        tx.commit().await.unwrap();
        v
    }

    async fn exec(&self, sql: &str, id: Option<Uuid>) {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(sql.to_string())).bind(self.tenant).bind(id).execute(&mut *tx).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
        tx.commit().await.unwrap();
    }

    async fn secret(&self, entity: &str, id: Uuid, field: &str) -> Option<String> {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let v = self.k.secret(&mut tx, self.tenant, entity, id, field).await.unwrap();
        tx.commit().await.unwrap();
        v
    }

    async fn comm(&self, id: Uuid) -> Doc {
        let sys = Ctx::system(self.tenant, self.k.registry.schema(self.tenant).await.unwrap());
        self.k.get(&sys, "Communication", id, false).await.unwrap()
    }

    async fn notifications(&self, user: &Ctx, like: &str) -> i64 {
        let mut tx = self.k.db.tenant_tx(self.tenant).await.unwrap();
        let n: i64 = sqlx::query_scalar("select count(*) from notification where tenant_id = $1 and user_id = $2 and title like $3")
            .bind(self.tenant)
            .bind(user.user)
            .bind(like)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        n
    }

    async fn maintenance(&self, imap: &FakeImap) {
        ferrum_app_comms::maintenance_with(&self.k, imap).await.expect("maintenance");
    }
}

/// A top-level header of a raw message, unfolded.
fn header(data: &str, name: &str) -> Option<String> {
    let head = data.split("\r\n\r\n").next().unwrap_or_default().replace("\r\n ", " ").replace("\r\n\t", " ");
    head.split("\r\n").find_map(|l| l.strip_prefix(&format!("{name}: ")).map(str::to_string))
}

fn parse(data: &str) -> ferrum_app_comms::inbound::ParsedMail {
    ferrum_app_comms::inbound::parse_mime(data.as_bytes()).expect("a parsable mail")
}

#[test]
fn comms_end_to_end() {
    // Same runtime shape as the server: unoptimized async hook chains need more than 2 MiB.
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn scenario() {
    let fallback = TestMailer::default();
    let k = fresh_kernel(fallback.clone()).await;
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
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("admin ctx");
    let mut users = HashMap::new();
    for (email, name, roles) in [
        ("mgr@acme.test", "Meera Manager", vec!["Comms Manager", "Comms User"]),
        ("alice@acme.test", "Alice Rao", vec!["Comms User", "Sales User"]),
        ("bob@acme.test", "Bob Shah", vec!["Comms User", "Sales User"]),
        ("carol@acme.test", "Carol Diaz", vec!["Comms User"]),
        ("dave@acme.test", "Dave Outsider", vec!["Sales User"]),
    ] {
        let roles: Vec<String> = roles.into_iter().map(String::from).collect();
        let id = k.create_user(&admin, email, name, Some(PASSWORD), &roles, false).await.expect("user");
        users.insert(email.split('@').next().unwrap().to_string(), k.load_ctx(tenant, id, None, "it".into()).await.unwrap());
    }
    let (mgr, alice, bob, carol, dave) = (&users["mgr"], &users["alice"], &users["bob"], &users["carol"], &users["dave"]);
    let t = T { k: k.clone(), tenant };
    let smtp = Smtp::default();
    let port = smtp.start().await;
    let imap = FakeImap::default();
    imap.0.lock().unwrap().validity = 7;

    // ───────────── settings and an account whose passwords are write-only ─────────────
    k.insert(mgr, "CommsSettings", obj(json!({"public_url": "https://erp.acme.test/", "newsletter_hourly_limit": 2, "max_send_attempts": 3}))).await.unwrap();
    let account = k
        .insert(
            mgr,
            "EmailAccount",
            obj(json!({
                "account_name": "Sales", "email_address": "sales@acme.test", "display_name": "Acme Sales", "default_outgoing": true,
                "smtp_host": "127.0.0.1", "smtp_port": port, "smtp_security": "None", "smtp_username": "sales@acme.test", "smtp_password": " s3cret pass ",
                "enable_incoming": true, "imap_host": "imap.acme.test", "imap_username": "sales", "imap_password": "imap-pass",
                "append_to": "Customer", "append_to_mapping": {"customer_name": "sender_name", "email": "sender"},
                "signature": "<p>-- <br>Acme Sales</p>",
            })),
        )
        .await
        .expect("account");
    let account_id = uid(&Value::Object(account.clone()));
    assert_eq!((account["smtp_password"].clone(), account["imap_password"].clone()), (json!(true), json!(true)), "secrets read as set, never as values");
    assert_eq!(t.secret("EmailAccount", account_id, "smtp_password").await.as_deref(), Some(" s3cret pass "), "kept exactly as typed");
    let leaks: i64 = t
        .scalar("select (select count(*) from audit_event where tenant_id = $1 and diff::text like '%s3cret%') + (select count(*) from outbox where tenant_id = $1 and payload::text like '%s3cret%') + (select count(*) from e_email_account where tenant_id = $1 and to_jsonb(e_email_account)::text like '%s3cret%' and id = $2) + (select count(*) from record_secret where tenant_id = $1 and sealed like '%s3cret%')", Some(account_id))
        .await;
    assert_eq!(leaks, 0, "the password never reaches the record, the audit trail or the outbox");
    let reread = k.get(mgr, "EmailAccount", account_id, false).await.unwrap();
    assert_eq!(reread["smtp_password"], json!(true));
    refused(k.insert(alice, "EmailAccount", obj(json!({"account_name": "Mine", "email_address": "me@acme.test", "smtp_host": "x.test"}))).await, "forbidden");
    refused(
        k.insert(
            mgr,
            "EmailAccount",
            obj(json!({"account_name": "Second", "email_address": "two@acme.test", "smtp_host": "smtp.acme.test", "default_outgoing": true})),
        )
        .await,
        "invalid",
    );
    refused(
        k.insert(mgr, "EmailAccount", obj(json!({"account_name": "Bad", "email_address": "bad@acme.test", "smtp_host": "https://smtp.acme.test"}))).await,
        "invalid",
    );
    refused(k.insert(mgr, "EmailAccount", obj(json!({"account_name": "Bad2", "email_address": "bad2@acme.test", "smtp_host": "s.test", "append_to": "Customer", "append_to_mapping": {"nope": "subject"}}))).await, "invalid");
    // Saving without a password (or with the `true` read back) keeps the stored one.
    k.update(mgr, "EmailAccount", account_id, obj(json!({"display_name": "Acme Sales Team", "smtp_password": true})), None).await.unwrap();
    assert_eq!(t.secret("EmailAccount", account_id, "smtp_password").await.as_deref(), Some(" s3cret pass "));
    refused(k.update(mgr, "EmailAccount", account_id, obj(json!({"imap_password": null})), None).await, "invalid");

    // ───────────── templates: escaped values, missing fields render empty ─────────────
    k.insert(
        mgr,
        "EmailTemplate",
        obj(json!({"template_name": "Quote follow-up", "reference_entity": "Customer", "subject": "Quote for {{ doc.customer_name }}",
                   "body": "<p>Dear {{ doc.customer_name }},</p><p>[{{ doc.nonexistent }}{{ doc.missing.deeper }}]</p><p>Regards, {{ user.full_name }}</p>"})),
    )
    .await
    .unwrap();
    refused(k.insert(mgr, "EmailTemplate", obj(json!({"template_name": "Broken", "subject": "x", "body": "{% for %}"}))).await, "invalid");
    let customer = k.insert(alice, "Customer", obj(json!({"customer_name": "Globex <b>&</b> Co", "email": "buyer@globex.test"}))).await.unwrap();
    let cust = uid(&Value::Object(customer.clone()));
    let preview =
        t.ok(alice, "POST", "/templates/preview", &[], json!({"template": "Quote follow-up", "reference_entity": "Customer", "reference_id": cust})).await;
    assert_eq!(preview["subject"], json!("Quote for Globex <b>&</b> Co"));
    let html = preview["html"].as_str().unwrap();
    assert!(html.contains("Dear Globex &lt;b&gt;&amp;&lt;&#x2f;b&gt; Co,"), "{html}");
    assert!(html.contains("<p>[]</p>") && html.contains("Regards, Alice Rao"), "{html}");
    refused(
        t.call(Some(carol), "POST", "/templates/preview", &[], json!({"template": "Quote follow-up", "reference_entity": "Customer", "reference_id": cust}))
            .await,
        "forbidden",
    );

    // ───────────── sending from a record: exactly once, even when the event comes again ─────────────
    // Files come from the platform's uploads (/api/files), here attached to the customer.
    let blob = uid(&k.store_file(alice, Some(("Customer", cust)), "quote.pdf", "application/pdf", b"%PDF-1.4 quote").await.unwrap());
    let carols = uid(&k.store_file(carol, None, "private.txt", "text/plain", b"carol's").await.unwrap());
    let sent = t
        .ok(
            alice,
            "POST",
            "/send",
            &[],
            json!({"template": "Quote follow-up", "to": "Buyer <buyer@globex.test>", "cc": ["boss@globex.test"],
                                              "reference_entity": "Customer", "reference_id": cust, "attachments": [{"id": blob}]}),
        )
        .await;
    assert_eq!(sent["status"], json!("Queued"));
    assert_eq!(sent["email_account"], json!(account_id.to_string()));
    let first = uid(&sent);
    let message_id = sent["message_id"].as_str().unwrap().to_string();
    assert!(message_id.ends_with("@acme.test"));
    t.drain().await;
    assert_eq!(smtp.count(), 1);
    let mail = &smtp.mails()[0];
    assert_eq!(mail.to, vec!["buyer@globex.test", "boss@globex.test"]);
    assert_eq!(header(&mail.data, "Message-ID"), Some(format!("<{message_id}>")));
    assert!(smtp.0.lock().unwrap().logins.iter().any(|l| l == "|sales@acme.test| s3cret pass "), "SMTP login with the stored password");
    let parsed = parse(&mail.data);
    assert_eq!(parsed.subject, "Quote for Globex <b>&</b> Co");
    assert_eq!(parsed.from.as_ref().map(|f| f.1.as_str()), Some("sales@acme.test"));
    assert!(
        parsed.html.as_deref().unwrap().contains("Dear Globex &lt;b&gt;&amp;&lt;&#x2f;b&gt; Co") && parsed.html.as_deref().unwrap().contains("Acme Sales</p>")
    );
    assert_eq!(parsed.attachments.iter().map(|a| a.file_name.as_str()).collect::<Vec<_>>(), vec!["quote.pdf"]);
    let doc = t.comm(first).await;
    assert_eq!((doc["status"].clone(), doc["attempts"].clone()), (json!("Sent"), json!(1)));
    assert!(doc["sent_at"].is_string());
    // The outbox redelivers the creation event: nothing is sent twice.
    t.exec(
        "update outbox set processed_at = null, available_at = now() where tenant_id = $1 and record_id = $2 and topic = 'Communication.created'",
        Some(first),
    )
    .await;
    t.drain().await;
    assert_eq!(smtp.count(), 1, "a redelivered event does not send again");
    assert_eq!(t.comm(first).await["attempts"], json!(1));
    // Who may send: only on records they can read, and only with the comms roles.
    refused(
        t.call(
            Some(carol),
            "POST",
            "/send",
            &[],
            json!({"to": "x@y.test", "subject": "Hi", "content": "Hi", "reference_entity": "Customer", "reference_id": cust}),
        )
        .await,
        "forbidden",
    );
    refused(
        k.insert(
            carol,
            "Communication",
            obj(json!({"recipients": "x@y.test", "subject": "Hi", "content": "Hi", "reference_entity": "Customer", "reference_id": cust.to_string()})),
        )
        .await,
        "invalid",
    );
    refused(t.call(Some(dave), "POST", "/send", &[], json!({"to": "x@y.test", "subject": "Hi", "content": "Hi"})).await, "forbidden");
    refused(t.call(Some(alice), "POST", "/send", &[], json!({"to": "not an address", "subject": "Hi", "content": "Hi"})).await, "invalid");
    refused(t.call(Some(bob), "POST", "/send", &[], json!({"to": "x@y.test", "content": "Hi", "attachments": [{"id": carols}]})).await, "invalid");
    assert!(k.get(alice, "Communication", first, false).await.is_ok(), "her own mail, through the generic API too");
    // Sent mail is a record of what happened.
    refused(k.update(mgr, "Communication", first, obj(json!({"subject": "Changed"})), None).await, "invalid");
    k.update(mgr, "Communication", first, obj(json!({"seen": true})), None).await.expect("seen may change");

    // ───────────── timelines and attachments follow access to the record ─────────────
    let timeline = t.ok(bob, "GET", "/communications", &[("reference_entity", "Customer"), ("reference_id", &cust.to_string())], Value::Null).await;
    assert_eq!(timeline["communications"].as_array().unwrap().len(), 1);
    assert!(timeline["communications"][0]["content_html"].as_str().unwrap().contains("Dear Globex"));
    refused(
        t.call(Some(carol), "GET", "/communications", &[("reference_entity", "Customer"), ("reference_id", &cust.to_string())], Value::Null).await,
        "forbidden",
    );
    refused(t.call(Some(carol), "GET", &format!("/communications/{first}"), &[], Value::Null).await, "not found");
    refused(t.raw(t.request(Some(carol), "GET", &format!("/attachments/{blob}"), &[], vec![], "")).await, "not found");
    let file = t.raw(t.request(Some(bob), "GET", &format!("/attachments/{blob}"), &[], vec![], "")).await.unwrap();
    assert_eq!(file.body, b"%PDF-1.4 quote");
    assert!(k.read_file(carol, blob).await.is_err(), "the platform's own checks agree");
    assert!(file.headers.iter().any(|(k, v)| k == "content-disposition" && v.contains("quote.pdf")));
    assert_eq!(t.ok(alice, "GET", "/communications", &[("mine", "1")], Value::Null).await["communications"].as_array().unwrap().len(), 1);
    let accounts = t.ok(bob, "GET", "/accounts", &[], Value::Null).await;
    assert_eq!(accounts["accounts"][0]["email_address"], json!("sales@acme.test"));
    assert!(accounts["accounts"][0].get("smtp_password").is_none());

    // ───────────── inbound replies thread onto the record; duplicates are ignored ─────────────
    let hook = k.run_action(mgr, "EmailAccount", account_id, "rotate_inbound_token", json!({})).await.unwrap();
    let token = hook["token"].as_str().unwrap().to_string();
    assert_eq!(hook["url"], json!(format!("https://erp.acme.test/api/site/acme/comms/inbound/{token}")));
    let reply = format!(
        "From: Buyer <buyer@globex.test>\r\nTo: sales@acme.test\r\nSubject: Re: Quote for Globex\r\nMessage-ID: <reply-1@globex.test>\r\n\
         In-Reply-To: <{message_id}>\r\nReferences: <{message_id}>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n\
         --b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLooks good, please proceed.\r\n--b\r\nContent-Type: text/csv; name=\"po.csv\"\r\n\
         Content-Disposition: attachment; filename=\"po.csv\"\r\n\r\nitem,qty\r\nwidget,10\r\n--b--\r\n"
    );
    let post = |body: String, token: String| t.raw(t.request(None, "POST", &format!("/inbound/{token}"), &[], body.into_bytes(), "message/rfc822"));
    let r = post(reply.clone(), token.clone()).await.unwrap();
    assert_eq!(r.status, 202);
    let created: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(created["status"], json!("created"));
    let received = t.comm(uid(&created)).await;
    assert_eq!((received["direction"].clone(), received["status"].clone()), (json!("Received"), json!("Received")));
    assert_eq!((received["reference_entity"].clone(), received["reference_id"].clone()), (json!("Customer"), json!(cust.to_string())));
    assert_eq!(received["thread_key"], json!(message_id));
    assert_eq!(received["attachments"].as_array().unwrap().len(), 1);
    let files: Vec<String> = k.attachments(alice, "Customer", cust).await.unwrap().iter().map(|f| f["file_name"].as_str().unwrap().to_string()).collect();
    assert_eq!(files, vec!["quote.pdf", "po.csv"], "mail attachments are the record's attachments");
    let po = uid(&received["attachments"][0]);
    assert_eq!(t.raw(t.request(Some(bob), "GET", &format!("/attachments/{po}"), &[], vec![], "")).await.unwrap().body, b"item,qty\r\nwidget,10");
    refused(t.raw(t.request(Some(carol), "GET", &format!("/attachments/{po}"), &[], vec![], "")).await, "not found");
    refused(k.get(alice, "Communication", uid(&created), false).await, "not found");
    assert_eq!(t.notifications(alice, "Reply from Buyer%").await, 1, "the sender hears about the reply");
    let again: Value = serde_json::from_slice(&post(reply.clone(), token.clone()).await.unwrap().body).unwrap();
    assert_eq!((again["status"].clone(), again["id"].clone()), (json!("duplicate"), created["id"].clone()));
    assert_eq!(
        t.scalar::<i64>("select count(*) from e_communication where tenant_id = $1 and message_id = 'reply-1@globex.test' and $2::uuid is null", None).await,
        1
    );
    refused(post(reply.clone(), "x".repeat(43)).await, "not found");
    // A new thread creates the "append to" record; an auto-reply does not.
    let fresh =
        "From: \"Jane Doe\" <new@initech.test>\r\nTo: sales@acme.test\r\nSubject: Pricing?\r\nMessage-ID: <q-1@initech.test>\r\n\r\nWhat do widgets cost?\r\n";
    let r: Value = serde_json::from_slice(&post(fresh.into(), token.clone()).await.unwrap().body).unwrap();
    let lead = t.comm(uid(&r)).await;
    assert_eq!(lead["reference_entity"], json!("Customer"));
    let jane = k.get(&admin, "Customer", lead["reference_id"].as_str().unwrap().parse().unwrap(), false).await.unwrap();
    assert_eq!((jane["customer_name"].clone(), jane["email"].clone()), (json!("Jane Doe"), json!("new@initech.test")));
    let ooo = "From: robot@initech.test\r\nTo: sales@acme.test\r\nSubject: Out of office\r\nAuto-Submitted: auto-replied\r\nMessage-ID: <ooo-1@initech.test>\r\n\r\nAway.\r\n";
    let r: Value = serde_json::from_slice(&post(ooo.into(), token.clone()).await.unwrap().body).unwrap();
    assert_eq!(t.comm(uid(&r)).await["reference_entity"], Value::Null);
    // Bob replies in the thread: threading headers point at the customer's message.
    let answer = t.ok(bob, "POST", "/send", &[], json!({"reply_to": created["id"], "to": "buyer@globex.test", "content": "<p>Proceeding.</p>"})).await;
    assert_eq!((answer["subject"].clone(), answer["thread_key"].clone()), (json!("Re: Quote for Globex"), json!(message_id)), "no Re: Re:");
    assert_eq!(answer["reference_id"], json!(cust.to_string()));
    t.drain().await;
    let threaded = smtp.mails().last().unwrap().data.clone();
    assert_eq!(header(&threaded, "In-Reply-To").as_deref(), Some("<reply-1@globex.test>"));
    assert_eq!(header(&threaded, "References"), Some(format!("<{message_id}> <reply-1@globex.test>")));
    refused(t.call(Some(carol), "POST", "/send", &[], json!({"reply_to": created["id"], "to": "buyer@globex.test", "content": "x"})).await, "invalid");

    // ───────────── SMTP outages retry with backoff, then fail; permanent errors fail at once ─────────────
    let mails_before = smtp.count();
    smtp.set_mode(Mode::Transient);
    let flaky = uid(&t.ok(alice, "POST", "/send", &[], json!({"to": "buyer@globex.test", "subject": "Follow-up", "content": "Any news?"})).await);
    t.drain().await;
    let d = t.comm(flaky).await;
    assert_eq!((d["status"].clone(), d["attempts"].clone()), (json!("Queued"), json!(1)));
    assert!(d["error"].as_str().unwrap().contains("451"), "{d:?}");
    t.maintenance(&imap).await;
    assert_eq!(t.comm(flaky).await["attempts"], json!(1), "not due yet: backoff");
    // While the server is failing, new mail is left to maintenance instead of blocking the outbox.
    let waiting = uid(&t.ok(alice, "POST", "/send", &[], json!({"to": "buyer@globex.test", "subject": "Second", "content": "x"})).await);
    t.drain().await;
    assert_eq!((t.comm(waiting).await["status"].clone(), t.comm(waiting).await["attempts"].clone()), (json!("Queued"), json!(0)));
    for expected in [2, 3] {
        t.exec("update e_communication set next_attempt_at = now() - interval '1 second' where tenant_id = $1 and id = $2", Some(flaky)).await;
        t.maintenance(&imap).await;
        assert_eq!(t.comm(flaky).await["attempts"], json!(expected));
    }
    assert_eq!(t.comm(flaky).await["status"], json!("Failed"), "after max_send_attempts");
    assert_eq!(t.notifications(alice, "Email not delivered: Follow-up").await, 1);
    assert_eq!(smtp.count(), mails_before);
    smtp.set_mode(Mode::Accept);
    refused(t.call(Some(bob), "POST", &format!("/communications/{flaky}/retry"), &[], Value::Null).await, "not found");
    assert_eq!(t.ok(alice, "POST", &format!("/communications/{flaky}/retry"), &[], Value::Null).await["status"], json!("Queued"));
    t.drain().await;
    assert_eq!(t.comm(flaky).await["status"], json!("Sent"));
    assert_eq!(smtp.count(), mails_before + 1);
    // Maintenance picks up mail the sink left behind.
    t.exec("update e_communication set created_at = now() - interval '5 minutes' where tenant_id = $1 and id = $2", Some(waiting)).await;
    t.maintenance(&imap).await;
    assert_eq!(t.comm(waiting).await["status"], json!("Sent"));
    assert_eq!(smtp.count(), mails_before + 2);
    smtp.set_mode(Mode::Permanent);
    let bounced = uid(&t.ok(alice, "POST", "/send", &[], json!({"to": "nobody@globex.test", "subject": "Hello", "content": "Hi"})).await);
    t.drain().await;
    let d = t.comm(bounced).await;
    assert_eq!((d["status"].clone(), d["attempts"].clone()), (json!("Failed"), json!(1)), "permanent errors are not retried");
    smtp.set_mode(Mode::Accept);
    // Without a default account the server's mailer delivers, once per recipient.
    k.update(mgr, "EmailAccount", account_id, obj(json!({"default_outgoing": false})), None).await.unwrap();
    let plain = uid(&t.ok(alice, "POST", "/send", &[], json!({"to": "a@globex.test", "cc": "b@globex.test", "subject": "Via server", "content": "x"})).await);
    t.drain().await;
    assert_eq!(t.comm(plain).await["status"], json!("Sent"));
    assert_eq!(fallback.0.lock().unwrap().iter().map(|m| m.0.as_str()).collect::<Vec<_>>(), vec!["a@globex.test", "b@globex.test"]);
    k.update(mgr, "EmailAccount", account_id, obj(json!({"default_outgoing": true})), None).await.unwrap();

    // ───────────── IMAP polling with a fake mailbox ─────────────
    let inline = |uid: u32, mid: &str, body: &str| {
        (uid, format!("From: Partner <p@partner.test>\r\nTo: sales@acme.test\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe_{uid}?=\r\nMessage-ID: <{mid}>\r\nMIME-Version: 1.0\r\n\
            Content-Type: multipart/alternative; boundary=\"a\"\r\n\r\n--a\r\nContent-Type: text/plain\r\n\r\n{body}\r\n--a\r\nContent-Type: text/html\r\n\r\n<p>{body}</p>\r\n--a--\r\n").into_bytes())
    };
    // The maintenance rounds above polled the empty mailbox once already (interval: 5 minutes).
    assert_eq!(imap.0.lock().unwrap().connects, 1);
    imap.0.lock().unwrap().messages = vec![inline(3, "m3@partner.test", "Hello three"), inline(5, "m5@partner.test", "Hello five")];
    let due = "update e_email_account set last_polled_at = now() - interval '1 hour' where tenant_id = $1 and id = $2";
    t.exec(due, Some(account_id)).await;
    t.maintenance(&imap).await;
    let polled = k.get(mgr, "EmailAccount", account_id, false).await.unwrap();
    assert_eq!((polled["last_uid"].clone(), polled["uid_validity"].clone(), polled["last_poll_error"].clone()), (json!(5), json!(7), Value::Null));
    assert_eq!(imap.0.lock().unwrap().passwords, vec!["imap-pass", "imap-pass"]);
    let m3: Value =
        t.scalar("select to_jsonb(c) from e_communication c where tenant_id = $1 and message_id = 'm3@partner.test' and $2::uuid is null", None).await;
    assert_eq!(m3["subject"], json!("Grüße 3"));
    assert_eq!(m3["text_content"].as_str().map(str::trim), Some("Hello three"));
    // Not due again until the poll interval passes.
    t.maintenance(&imap).await;
    assert_eq!(imap.0.lock().unwrap().connects, 2);
    imap.0.lock().unwrap().messages.push((6, reply.clone().into_bytes()));
    t.exec(due, Some(account_id)).await;
    t.maintenance(&imap).await;
    assert_eq!(k.get(mgr, "EmailAccount", account_id, false).await.unwrap()["last_uid"], json!(6), "the webhook's message came again: skipped");
    let count = "select count(*) from e_communication where tenant_id = $1 and direction = 'Received' and $2::uuid is null";
    let received_before: i64 = t.scalar(count, None).await;
    imap.0.lock().unwrap().validity = 8;
    t.exec(due, Some(account_id)).await;
    t.maintenance(&imap).await;
    assert_eq!(k.get(mgr, "EmailAccount", account_id, false).await.unwrap()["uid_validity"], json!(8));
    assert_eq!(t.scalar::<i64>(count, None).await, received_before, "a new UIDVALIDITY rereads the folder without duplicates");

    // ───────────── newsletters: hourly limit, unsubscribed members, signed unsubscribe links ─────────────
    let customers = uid(&Value::Object(k.insert(mgr, "EmailGroup", obj(json!({"group_name": "Customers"}))).await.unwrap()));
    let partners = uid(&Value::Object(k.insert(mgr, "EmailGroup", obj(json!({"group_name": "Partners"}))).await.unwrap()));
    for (g, email, unsubscribed) in [
        (customers, "a@x.test", false),
        (customers, "b@x.test", true),
        (customers, "C@x.test", false),
        (partners, "c@x.test", false),
        (partners, "d@x.test", false),
    ] {
        k.insert(mgr, "EmailGroupMember", obj(json!({"email_group": g, "email": email, "member_name": email.to_uppercase(), "unsubscribed": unsubscribed})))
            .await
            .unwrap();
    }
    refused(k.insert(mgr, "EmailGroupMember", obj(json!({"email_group": customers, "email": "a@x.test"}))).await, "conflict");
    let news = k
        .insert(
            mgr,
            "Newsletter",
            obj(json!({"subject": "News for {{ member.member_name }}", "content": "<p>Hello {{ member.member_name }}</p>",
                                               "email_groups": [{"email_group": customers}, {"email_group": partners}]})),
        )
        .await
        .unwrap();
    let news_id = uid(&Value::Object(news));
    k.run_action(mgr, "Newsletter", news_id, "schedule", json!({})).await.unwrap();
    refused(k.update(mgr, "Newsletter", news_id, obj(json!({"subject": "Changed"})), None).await, "invalid");
    let before = smtp.count();
    t.maintenance(&imap).await;
    let n = k.get(mgr, "Newsletter", news_id, false).await.unwrap();
    assert_eq!((n["status"].clone(), n["sent_count"].clone(), n["total_recipients"].clone()), (json!("Sending"), json!(2), json!(3)));
    assert_eq!(smtp.count(), before + 2, "the hourly limit of 2");
    t.maintenance(&imap).await;
    assert_eq!(smtp.count(), before + 2, "still within the same hour");
    k.update(
        mgr,
        "CommsSettings",
        uid(&Value::Object(k.list(mgr, "CommsSettings", &Default::default()).await.unwrap().rows[0].clone())),
        obj(json!({"newsletter_hourly_limit": 100})),
        None,
    )
    .await
    .unwrap();
    t.maintenance(&imap).await;
    t.maintenance(&imap).await;
    let n = k.get(mgr, "Newsletter", news_id, false).await.unwrap();
    assert_eq!((n["status"].clone(), n["sent_count"].clone(), n["failed_count"].clone()), (json!("Sent"), json!(3), json!(0)));
    let letters: Vec<Received> = smtp.mails()[before..].to_vec();
    let mut recipients: Vec<String> = letters.iter().flat_map(|m| m.to.clone()).collect();
    recipients.sort();
    assert_eq!(recipients, vec!["a@x.test", "c@x.test", "d@x.test"], "unsubscribed b@ never mailed, c@ once");
    let to_a = letters.iter().find(|m| m.to == ["a@x.test"]).unwrap();
    assert_eq!(parse(&to_a.data).subject, "News for A@X.TEST");
    assert_eq!(header(&to_a.data, "List-Unsubscribe-Post").as_deref(), Some("List-Unsubscribe=One-Click"));
    let link = header(&to_a.data, "List-Unsubscribe").unwrap().trim_matches(['<', '>']).to_string();
    assert!(link.starts_with("https://erp.acme.test/api/site/acme/comms/unsubscribe?"), "{link}");
    let query: Vec<(String, String)> =
        link.split_once('?').unwrap().1.split('&').map(|p| p.split_once('=').unwrap()).map(|(a, b)| (a.to_string(), b.replace("%40", "@"))).collect();
    let q = |k: &str| query.iter().find(|(a, _)| a == k).unwrap().1.clone();
    let (nq, eq, sq) = (q("n"), q("e"), q("s"));
    let page = |method: &str, e: &str, s: &str| {
        t.raw(t.request(None, method, "/unsubscribe", &[("n", &nq), ("e", e), ("s", s)], vec![], "application/x-www-form-urlencoded"))
    };
    let confirm = page("GET", &eq, &sq).await.unwrap();
    assert_eq!(confirm.status, 200);
    assert!(String::from_utf8_lossy(&confirm.body).contains("<form method=\"post\""));
    let mut forged = sq.clone().into_bytes();
    forged[3] = if forged[3] == b'0' { b'1' } else { b'0' };
    for (e, s) in [(eq.as_str(), String::from_utf8(forged).unwrap()), ("d@x.test", sq.clone()), (eq.as_str(), String::new())] {
        let r = page("POST", e, &s).await.unwrap();
        assert_eq!(r.status, 403, "tampered link refused");
    }
    assert_eq!(t.scalar::<i64>("select count(*) from e_email_group_member where tenant_id = $1 and unsubscribed and $2::uuid is null", None).await, 1);
    let done = page("POST", &eq, &sq).await.unwrap();
    assert_eq!(done.status, 200);
    assert!(String::from_utf8_lossy(&done.body).contains("a@x.test"));
    assert_eq!(t.scalar::<i64>("select count(*) from e_email_group_member where tenant_id = $1 and unsubscribed and $2::uuid is null", None).await, 2);

    // ───────────── chat: private channels stay invisible to non-members ─────────────
    let mut live = sqlx::postgres::PgListener::connect_with(&k.db.pool).await.unwrap();
    live.listen(ferrum_kernel::notify::LIVE_CHANNEL).await.unwrap();
    let deals =
        t.ok(alice, "POST", "/chat/channels", &[], json!({"name": "deals", "type": "Private", "topic": "Big ones", "members": ["bob@acme.test"]})).await;
    let deals_id = uid(&deals);
    assert_eq!(deals["role"], json!("Owner"));
    refused(t.call(Some(bob), "POST", "/chat/channels", &[], json!({"name": "deals"})).await, "conflict");
    refused(t.call(Some(alice), "POST", "/chat/channels", &[], json!({"name": "ghosts", "type": "Private", "members": ["nobody@acme.test"]})).await, "invalid");
    let general = uid(&t.ok(carol, "POST", "/chat/channels", &[], json!({"name": "general"})).await);
    let hello =
        t.ok(alice, "POST", &format!("/chat/channels/{deals_id}/messages"), &[], json!({"body": "Hi <@bob@acme.test>, check the **Globex** deal"})).await;
    let hello_id = uid(&hello);
    assert_eq!(hello["mentions"], json!(["bob@acme.test"]));
    let mut pushes = Vec::new();
    while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(300), live.recv()).await {
        pushes.push(serde_json::from_str::<Value>(n.payload()).unwrap());
    }
    let chat_push_to = |who: &Ctx| {
        pushes.iter().any(|p| p["user"] == json!(who.user) && p["push"]["kind"] == json!("chat") && p["push"]["data"]["message"] == json!(hello_id))
    };
    assert!(chat_push_to(bob) && chat_push_to(alice) && !chat_push_to(carol), "{pushes:?}");
    assert_eq!(t.notifications(bob, "Alice Rao mentioned you in #deals").await, 1);
    let carol_channels = t.ok(carol, "GET", "/chat/channels", &[("include", "public")], Value::Null).await;
    assert!(carol_channels["channels"].as_array().unwrap().iter().all(|c| c["id"] != json!(deals_id)));
    for (method, path, body) in [
        ("GET", format!("/chat/channels/{deals_id}"), Value::Null),
        ("GET", format!("/chat/channels/{deals_id}/messages"), Value::Null),
        ("POST", format!("/chat/channels/{deals_id}/messages"), json!({"body": "let me in"})),
        ("POST", format!("/chat/channels/{deals_id}/join"), Value::Null),
        ("POST", format!("/chat/channels/{deals_id}/read"), Value::Null),
        ("PATCH", format!("/chat/messages/{hello_id}"), json!({"body": "hacked"})),
        ("DELETE", format!("/chat/messages/{hello_id}"), Value::Null),
    ] {
        refused(t.call(Some(carol), method, &path, &[], body).await, "not found");
    }
    assert!(t.ok(carol, "GET", "/chat/search", &[("q", "Globex")], Value::Null).await["messages"].as_array().unwrap().is_empty());
    assert_eq!(t.ok(bob, "GET", "/chat/search", &[("q", "globex")], Value::Null).await["messages"].as_array().unwrap().len(), 1);
    refused(k.get(carol, "ChatMessage", hello_id, false).await, "forbidden");
    let unread = |v: &Value, id: Uuid| v["channels"].as_array().unwrap().iter().find(|c| c["id"] == json!(id)).map(|c| c["unread"].clone());
    assert_eq!(unread(&t.ok(bob, "GET", "/chat/channels", &[], Value::Null).await, deals_id), Some(json!(1)));
    t.ok(bob, "POST", &format!("/chat/channels/{deals_id}/read"), &[], Value::Null).await;
    assert_eq!(unread(&t.ok(bob, "GET", "/chat/channels", &[], Value::Null).await, deals_id), Some(json!(0)));
    // Direct conversations are unique per pair.
    let d1 = uid(&t.ok(alice, "POST", "/chat/direct", &[], json!({"user": "bob@acme.test"})).await);
    let d2 = t.ok(bob, "POST", "/chat/direct", &[], json!({"user": "ALICE@acme.test"})).await;
    assert_eq!(uid(&d2), d1);
    assert_eq!(d2["title"], json!("Alice Rao"));
    refused(t.call(Some(alice), "POST", "/chat/direct", &[], json!({"user": "alice@acme.test"})).await, "invalid");
    t.ok(alice, "POST", &format!("/chat/channels/{d1}/messages"), &[], json!({"body": "psst"})).await;
    refused(t.call(Some(carol), "GET", &format!("/chat/channels/{d1}/messages"), &[], Value::Null).await, "not found");
    // Only the sender edits; the sender, a channel owner or a chat admin deletes.
    let bobs = uid(&t.ok(bob, "POST", &format!("/chat/channels/{deals_id}/messages"), &[], json!({"body": "On it", "parent": hello_id})).await);
    refused(t.call(Some(alice), "PATCH", &format!("/chat/messages/{bobs}"), &[], json!({"body": "Edited by alice"})).await, "forbidden");
    let edited = t.ok(bob, "PATCH", &format!("/chat/messages/{bobs}"), &[], json!({"body": "On it now"})).await;
    assert!(edited["edited_at"].is_string());
    let thread = t.ok(alice, "GET", &format!("/chat/channels/{deals_id}/messages"), &[("thread", &hello_id.to_string())], Value::Null).await;
    assert_eq!(thread["messages"][0]["body"], json!("On it now"));
    let top = t.ok(alice, "GET", &format!("/chat/channels/{deals_id}/messages"), &[], Value::Null).await;
    assert_eq!((top["messages"].as_array().unwrap().len(), top["messages"][0]["reply_count"].clone()), (1, json!(1)));
    t.ok(alice, "DELETE", &format!("/chat/messages/{bobs}"), &[], Value::Null).await;
    let thread = t.ok(bob, "GET", &format!("/chat/channels/{deals_id}/messages"), &[("thread", &hello_id.to_string())], Value::Null).await;
    assert_eq!((thread["messages"][0]["deleted"].clone(), thread["messages"][0]["body"].clone()), (json!(true), json!("")));
    refused(t.call(Some(bob), "DELETE", &format!("/chat/messages/{hello_id}"), &[], Value::Null).await, "forbidden");
    // Files in chat follow channel membership, and go with a deleted message.
    let plan = uid(&k.store_file(alice, None, "plan.png", "image/png", b"PNG plan").await.unwrap());
    let with_file = t.ok(alice, "POST", &format!("/chat/channels/{deals_id}/messages"), &[], json!({"body": "the plan", "attachments": [{"id": plan}]})).await;
    assert_eq!(with_file["attachments"][0]["file_name"], json!("plan.png"));
    let fetch = |who: &Ctx| t.raw(t.request(Some(who), "GET", &format!("/attachments/{plan}"), &[], vec![], ""));
    assert_eq!(fetch(bob).await.unwrap().body, b"PNG plan");
    refused(fetch(carol).await, "not found");
    refused(k.read_file(bob, plan).await, "forbidden");
    refused(
        t.call(Some(bob), "POST", &format!("/chat/channels/{deals_id}/messages"), &[], json!({"body": "again", "attachments": [{"id": plan}]})).await,
        "invalid",
    );
    t.ok(alice, "DELETE", &format!("/chat/messages/{}", uid(&with_file)), &[], Value::Null).await;
    refused(fetch(bob).await, "not found");
    refused(t.call(Some(alice), "POST", &format!("/chat/channels/{deals_id}/messages"), &[], json!({"body": "x".repeat(4097)})).await, "invalid");
    // Public channels: readable by all chat users, posting after joining; pages by cursor.
    for i in 0..3 {
        t.ok(carol, "POST", &format!("/chat/channels/{general}/messages"), &[], json!({"body": format!("note {i}")})).await;
    }
    let page1 = t.ok(bob, "GET", &format!("/chat/channels/{general}/messages"), &[("limit", "2")], Value::Null).await;
    assert_eq!(page1["messages"][0]["body"], json!("note 2"));
    let cursor = page1["next_cursor"].as_str().unwrap().to_string();
    let page2 = t.ok(bob, "GET", &format!("/chat/channels/{general}/messages"), &[("limit", "2"), ("cursor", &cursor)], Value::Null).await;
    assert_eq!(
        (page2["messages"].as_array().unwrap().len(), page2["messages"][0]["body"].clone(), page2["next_cursor"].clone()),
        (1, json!("note 0"), Value::Null)
    );
    refused(t.call(Some(bob), "POST", &format!("/chat/channels/{general}/messages"), &[], json!({"body": "hi"})).await, "forbidden");
    t.ok(bob, "POST", &format!("/chat/channels/{general}/join"), &[], Value::Null).await;
    t.ok(bob, "POST", &format!("/chat/channels/{general}/messages"), &[], json!({"body": "hi all"})).await;
    refused(t.call(Some(dave), "GET", "/chat/channels", &[], Value::Null).await, "forbidden");

    // ───────────── calendar: invitations, privacy, RSVP, free/busy, reminders once, feeds ─────────────
    let soon = chrono::Utc::now() + chrono::Duration::minutes(10);
    let iso = |t: chrono::DateTime<chrono::Utc>| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mails_before = smtp.count();
    let event = k
        .insert(
            alice,
            "CalendarEvent",
            obj(json!({"subject": "Partner sync; Q4, plans", "starts_at": iso(soon), "ends_at": iso(soon + chrono::Duration::minutes(30)),
                        "timezone": "Asia/Kolkata", "recurrence": "freq=weekly;count=4", "location": "Room 4",
                        "attendees": [{"email": "bob@acme.test"}, {"email": "guest@partner.test", "attendee_name": "Guest, External"}],
                        "reminders": [{"minutes_before": 15}]})),
        )
        .await
        .expect("event");
    let event_id = uid(&Value::Object(event.clone()));
    assert_eq!((event["owner"].clone(), event["recurrence"].clone()), (json!("alice@acme.test"), json!("FREQ=WEEKLY;COUNT=4")));
    assert_eq!(event["attendees"][0]["attendee_name"], json!("Bob Shah"));
    assert_eq!(t.notifications(bob, "Invitation: Partner sync%").await, 1);
    t.drain().await;
    assert_eq!(smtp.count(), mails_before + 1, "only the outside guest is mailed");
    let invite = smtp.mails().last().unwrap().clone();
    assert_eq!(invite.to, vec!["guest@partner.test"]);
    assert!(invite.data.contains("text/calendar; charset=utf-8; method=REQUEST"));
    let invitation = parse(&invite.data);
    let ics_part = invitation.attachments.iter().find(|a| a.file_name == "invite.ics").expect("invite.ics");
    let ics = ferrum_app_comms::ics::parse(std::str::from_utf8(&ics_part.data).unwrap()).unwrap();
    assert_eq!(ics.method.as_deref(), Some("REQUEST"));
    assert_eq!(ics.events[0].summary, "Partner sync; Q4, plans");
    assert_eq!(ics.events[0].rrule.as_deref(), Some("FREQ=WEEKLY;COUNT=4"));
    refused(
        k.insert(alice, "CalendarEvent", obj(json!({"subject": "Bad", "starts_at": iso(soon), "ends_at": iso(soon), "recurrence": "FREQ=HOURLY"}))).await,
        "invalid",
    );
    refused(
        k.insert(alice, "CalendarEvent", obj(json!({"subject": "Bad", "starts_at": iso(soon), "ends_at": iso(soon - chrono::Duration::hours(1))}))).await,
        "invalid",
    );
    let window = [("from", iso(soon - chrono::Duration::days(1))), ("to", iso(soon + chrono::Duration::days(30)))];
    let window: Vec<(&str, &str)> = window.iter().map(|(a, b)| (*a, b.as_str())).collect();
    let bobs_calendar = t.ok(bob, "GET", "/calendar/events", &window, Value::Null).await;
    assert_eq!(bobs_calendar["occurrences"].as_array().unwrap().len(), 4, "a weekly COUNT=4 series");
    assert_eq!(bobs_calendar["occurrences"][1]["my_response"], json!("Needs Action"));
    assert!(t.ok(carol, "GET", "/calendar/events", &window, Value::Null).await["occurrences"].as_array().unwrap().is_empty(), "private event");
    refused(k.get(carol, "CalendarEvent", event_id, false).await, "not found");
    assert!(k.get(bob, "CalendarEvent", event_id, false).await.is_ok(), "attendees may read it");
    refused(k.update(bob, "CalendarEvent", event_id, obj(json!({"subject": "Mine now"})), None).await, "forbidden");
    refused(k.delete(bob, "CalendarEvent", event_id, None).await, "forbidden");
    let busy = t
        .ok(
            carol,
            "POST",
            "/calendar/freebusy",
            &[],
            json!({"users": ["alice@acme.test", "bob@acme.test", "carol@acme.test"], "from": window[0].1, "to": window[1].1}),
        )
        .await;
    assert_eq!(busy["busy"]["alice@acme.test"].as_array().unwrap().len(), 4);
    assert_eq!(busy["busy"]["bob@acme.test"].as_array().unwrap().len(), 4);
    assert!(busy["busy"]["carol@acme.test"].as_array().unwrap().is_empty());
    assert!(busy["busy"]["alice@acme.test"][0].get("subject").is_none(), "no details in free/busy");
    assert_eq!(t.ok(bob, "POST", &format!("/calendar/events/{event_id}/rsvp"), &[], json!({"response": "Accepted"})).await["response"], json!("Accepted"));
    assert_eq!(t.notifications(alice, "Bob Shah accepted: Partner sync%").await, 1);
    refused(t.call(Some(carol), "POST", &format!("/calendar/events/{event_id}/rsvp"), &[], json!({"response": "Accepted"})).await, "not found");
    let mails_after_rsvp = smtp.count();
    t.drain().await;
    assert_eq!(smtp.count(), mails_after_rsvp, "an RSVP sends no new invitations");
    // The first occurrence starts in 10 minutes and has a 15-minute reminder: it fires, once.
    t.maintenance(&imap).await;
    assert_eq!((t.notifications(alice, "Reminder: Partner sync%").await, t.notifications(bob, "Reminder: Partner sync%").await), (1, 1));
    t.maintenance(&imap).await;
    assert_eq!((t.notifications(alice, "Reminder: Partner sync%").await, t.notifications(bob, "Reminder: Partner sync%").await), (1, 1), "reminders fire once");
    // A public event shows on everyone's calendar.
    let town_hall = k.insert(mgr, "CalendarEvent", obj(json!({"subject": "Town hall", "starts_at": iso(soon + chrono::Duration::days(2)), "ends_at": iso(soon + chrono::Duration::days(2) + chrono::Duration::hours(1)), "visibility": "Public"})))
        .await
        .unwrap();
    let town_hall = uid(&Value::Object(town_hall));
    assert_eq!(t.ok(carol, "GET", "/calendar/events", &window, Value::Null).await["occurrences"].as_array().unwrap().len(), 1);
    // A personal ICS feed by secret URL; rotating it retires the old one.
    let feed = t.ok(alice, "POST", "/calendar/feed", &[], Value::Null).await;
    let token = feed["token"].as_str().unwrap().to_string();
    assert_eq!(feed["url"], json!(format!("https://erp.acme.test/api/site/acme/comms/calendar/{token}.ics")));
    let get_feed = |token: String| t.raw(t.request(None, "GET", &format!("/calendar/{token}.ics"), &[], vec![], ""));
    let ics_feed = get_feed(token.clone()).await.unwrap();
    assert_eq!(ics_feed.content_type, "text/calendar; charset=utf-8");
    let text = String::from_utf8(ics_feed.body).unwrap();
    assert!(text.contains("SUMMARY:Partner sync\\; Q4\\, plans\r\n") && text.contains("RRULE:FREQ=WEEKLY;COUNT=4\r\n") && text.contains("TRIGGER:-PT15M"));
    assert!(text.split("\r\n").all(|l| l.len() <= 75));
    assert!(!text.contains("Town hall"), "the feed is my calendar, not the public ones");
    let rotated = t.ok(alice, "POST", "/calendar/feed", &[], Value::Null).await["token"].as_str().unwrap().to_string();
    refused(get_feed(token).await, "not found");
    assert_eq!(get_feed(rotated).await.unwrap().status, 200);
    refused(get_feed("x".repeat(43)).await, "not found");
    // Import: created once, updated on the next import of the same UIDs.
    let file = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ext-1@example.com\r\nSUMMARY:Dentist\r\nDTSTART;TZID=Europe/Berlin:20261120T100000\r\nDTEND;TZID=Europe/Berlin:20261120T110000\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:ext-2@example.com\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let import = |body: &str| t.raw(t.request(Some(carol), "POST", "/calendar/import", &[], body.as_bytes().to_vec(), "text/calendar"));
    let r: Value = serde_json::from_slice(&import(file).await.unwrap().body).unwrap();
    assert_eq!((r["created"].clone(), r["updated"].clone()), (json!(2), json!(0)), "{r}");
    let r: Value = serde_json::from_slice(&import(file).await.unwrap().body).unwrap();
    assert_eq!((r["created"].clone(), r["updated"].clone()), (json!(0), json!(2)), "{r}");
    let dentist: String = t.scalar("select to_char(starts_at at time zone 'UTC', 'HH24:MI') from e_calendar_event where tenant_id = $1 and ical_uid = 'ext-1@example.com' and $2::uuid is null", None).await;
    assert_eq!(dentist, "09:00", "10:00 in Berlin in November is 09:00 UTC");

    // ───────────── meetings: who may join the call of a channel, an event or a room ─────────────
    let join = |who: &Ctx, kind: &str, id: Uuid| {
        let (t, who, path) = (&t, who.clone(), format!("/meet/{kind}/{id}/token"));
        async move { t.call(Some(&who), "POST", &path, &[], Value::Null).await }
    };
    assert_eq!(t.ok(carol, "GET", "/meet", &[], Value::Null).await, json!({"available": false}));
    refused(join(alice, "channel", deals_id).await, "invalid");
    // SAFETY: this test is the only one in its process.
    unsafe {
        std::env::set_var("FERRUM_MEET_URL", "wss://meet.acme.test/");
        std::env::set_var("FERRUM_MEET_KEY", "APIacme");
        std::env::set_var("FERRUM_MEET_SECRET", "a-secret-only-livekit-and-ferrum-know");
    }
    assert_eq!(t.ok(carol, "GET", "/meet", &[], Value::Null).await, json!({"available": true}));
    let pass = join(bob, "channel", deals_id).await.unwrap();
    assert_eq!((pass["url"].clone(), pass["title"].clone()), (json!("wss://meet.acme.test"), json!("#deals")));
    let claims = |pass: &Value| -> Value {
        let body = pass["token"].as_str().unwrap().split('.').nth(1).unwrap();
        serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).unwrap()).unwrap()
    };
    let room_of = |kind: &str, id: Uuid| json!(format!("{}-{kind}-{}", t.tenant.simple(), id.simple()));
    assert_eq!((claims(&pass)["video"]["room"].clone(), claims(&pass)["name"].clone()), (room_of("channel", deals_id), json!("Bob Shah")));
    assert_ne!(claims(&pass)["sub"], claims(&join(bob, "channel", deals_id).await.unwrap())["sub"], "each joining is its own participant");
    refused(join(carol, "channel", deals_id).await, "not found");
    assert_eq!(join(carol, "channel", general).await.unwrap()["title"], json!("#general"), "a public channel's call is open to all");
    assert_eq!(join(alice, "channel", d1).await.unwrap()["title"], json!("Bob Shah"), "a direct call is named after the other person");
    let bobs = join(bob, "event", event_id).await.unwrap();
    assert_eq!((bobs["title"].clone(), claims(&bobs)["video"]["room"].clone()), (json!("Partner sync; Q4, plans"), room_of("event", event_id)));
    refused(join(carol, "event", event_id).await, "not found");
    assert_eq!(join(carol, "event", town_hall).await.unwrap()["title"], json!("Town hall"), "a public event's call is open to all");
    let room = t.ok(alice, "POST", "/meet/rooms", &[], json!({"title": "  Quick chat  "})).await;
    assert_eq!(room["title"], json!("Quick chat"));
    assert_eq!(join(carol, "room", uid(&room)).await.unwrap()["title"], json!("Quick chat"), "a room admits anyone in the workspace with its link");
    assert_eq!(t.ok(alice, "POST", "/meet/rooms", &[], json!({})).await["title"], json!("Meeting"));
    refused(join(carol, "room", Uuid::new_v4()).await, "not found");
    refused(join(carol, "space", uid(&room)).await, "not found");
    refused(t.call(Some(dave), "POST", "/meet/rooms", &[], json!({})).await, "forbidden");

    // Guests. An outside guest of an event with a meeting here gets their own link in the invitation.
    let soon_iso = |d: i64| (chrono::Utc::now() + chrono::Duration::days(d)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let review = uid(&Value::Object(
        k.insert(
            alice,
            "CalendarEvent",
            obj(json!({"subject": "Supplier review", "starts_at": soon_iso(1), "ends_at": soon_iso(1),
                    "attendees": [{"email": "pat@partner.test", "attendee_name": "Pat Lee"}, {"email": "bob@acme.test"}]})),
        )
        .await
        .unwrap(),
    ));
    // A link the web app made before Comms had pages of its own (`/app/meet/…`) still leads here.
    k.update(alice, "CalendarEvent", review, obj(json!({"meeting_link": format!("https://erp.acme.test/app/meet/event/{review}")})), None).await.unwrap();
    t.drain().await;
    let invitation: String = t
        .scalar("select content from e_communication where tenant_id = $1 and reference_id = $2::text and recipients like '%pat@partner.test%' order by created_at desc limit 1", Some(review))
        .await;
    let link = regex::Regex::new(r"https://erp\.acme\.test/meet/guest/acme/(e\.[A-Za-z0-9._-]+)").unwrap();
    let pats = link.captures(&invitation).unwrap_or_else(|| panic!("a guest link in {invitation}"))[1].to_string();
    let guest = |body: Value| t.call(None, "POST", "/meet/guest", &[], body);
    let pass = guest(json!({"token": pats})).await.unwrap();
    assert_eq!((pass["title"].clone(), claims(&pass)["name"].clone()), (json!("Supplier review"), json!("Pat Lee (guest)")));
    assert_eq!(claims(&pass)["video"]["room"], room_of("event", review), "the guest joins the colleagues' meeting");
    let mut forged = pats.clone();
    forged.replace_range(forged.len() - 1.., if pats.ends_with('0') { "1" } else { "0" });
    refused(guest(json!({"token": forged})).await, "not found");
    let parts: Vec<&str> = pats.split('.').collect();
    let eve = format!("e.{}.{}.{}", parts[1], base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("eve@partner.test"), parts[3]);
    refused(guest(json!({"token": eve})).await, "not found");
    // Removing the guest from the event stops their link.
    k.update(alice, "CalendarEvent", review, obj(json!({"attendees": [{"email": "bob@acme.test"}]})), None).await.unwrap();
    refused(guest(json!({"token": pats})).await, "not found");

    // A room's guest link: anyone with it, by the name they type; a new link retires the old one.
    let shared = uid(&t.ok(alice, "POST", "/meet/rooms", &[], json!({"title": "Vendor demo"})).await);
    assert_eq!(join(carol, "room", shared).await.unwrap()["guest_path"], Value::Null);
    let path = t.ok(alice, "POST", &format!("/meet/room/{shared}/guest-link"), &[], Value::Null).await["guest_path"].as_str().unwrap().to_string();
    assert!(path.starts_with(&format!("/meet/guest/acme/r.{}.", shared.simple())), "{path}");
    assert_eq!(join(carol, "room", shared).await.unwrap()["guest_path"], json!(path), "people in the room can share it");
    let room_link = path.rsplit('/').next().unwrap().to_string();
    refused(guest(json!({"token": room_link})).await, "invalid");
    let sam = guest(json!({"token": room_link, "name": "  Sam  "})).await.unwrap();
    assert_eq!((sam["title"].clone(), claims(&sam)["name"].clone()), (json!("Vendor demo"), json!("Sam (guest)")));
    assert!(claims(&sam)["sub"].as_str().unwrap().starts_with("guest."));
    let renewed = t.ok(alice, "POST", &format!("/meet/room/{shared}/guest-link"), &[], Value::Null).await["guest_path"].as_str().unwrap().to_string();
    assert_ne!(renewed, path);
    refused(guest(json!({"token": room_link, "name": "Sam"})).await, "not found");
    assert_eq!(t.ok(alice, "DELETE", &format!("/meet/room/{shared}/guest-link"), &[], Value::Null).await["guest_path"], Value::Null);
    refused(guest(json!({"token": renewed.rsplit('/').next().unwrap(), "name": "Sam"})).await, "not found");
    refused(guest(json!({"token": "x.y"})).await, "not found");
    t.drain().await;

    // Cancelling tells the guest (iCalendar CANCEL) and the colleague.
    let cancel_before = smtp.count();
    k.update(alice, "CalendarEvent", event_id, obj(json!({"status": "Cancelled"})), None).await.unwrap();
    t.drain().await;
    assert_eq!(smtp.count(), cancel_before + 1);
    assert!(smtp.mails().last().unwrap().data.contains("method=CANCEL"));
    assert_eq!(t.notifications(bob, "Cancelled: Partner sync%").await, 1);
    refused(join(bob, "event", event_id).await, "invalid");
    // SAFETY: as above.
    unsafe {
        for var in ["FERRUM_MEET_URL", "FERRUM_MEET_KEY", "FERRUM_MEET_SECRET"] {
            std::env::remove_var(var);
        }
    }

    // ───────────── reports ─────────────
    let report = |ctx: &Ctx, name: &str| {
        let ctx = ctx.clone();
        let k = k.clone();
        let name = name.to_string();
        async move { ferrum_domain::reports::run(&k, &ctx, &name, &HashMap::new()).await }
    };
    let activity = report(mgr, "email_activity").await.unwrap();
    let totals = &activity["totals"];
    // Sent: the quote, Bob's reply, the retried follow-up, the one left to maintenance, the
    // server-mailer one, the invitation and its cancellation, and Pat's invitation, its update with
    // her meeting link and her cancellation; received: the reply, Jane, the auto-reply and two
    // polled mails; failed: the bounce.
    assert_eq!((totals["sent"].clone(), totals["received"].clone(), totals["failed"].clone()), (json!(10), json!(5), json!(1)), "{activity}");
    let letters = report(mgr, "newsletter_performance").await.unwrap();
    assert_eq!(
        (letters["rows"][0]["sent"].clone(), letters["rows"][0]["unsubscribed"].clone(), letters["rows"][0]["unsubscribe_rate"].clone()),
        (json!(3), json!(1), json!("33.33"))
    );
    let chats = report(&admin, "chat_activity").await.unwrap();
    assert!(chats["rows"].as_array().unwrap().iter().any(|r| r["channel"] == json!("#general") && r["messages"] == json!(4)), "{chats}");
    refused(report(alice, "chat_activity").await, "forbidden");

    // Nothing is left in the outbox that failed.
    let dead: i64 = t.scalar("select count(*) from outbox where tenant_id = $1 and (dead or last_error is not null) and $2::uuid is null", None).await;
    assert_eq!(dead, 0);

    calendar_apps(&t, &users).await;
    hosted_mail(&t, &admin, &users, &imap).await;
}

/// A calendar and contacts app's session (CalDAV and CardDAV under `/dav`): discovery, an event
/// created, changed, answered and deleted from apps, a moved occurrence, reports, address books.
async fn calendar_apps(t: &T, users: &HashMap<String, Ctx>) {
    let (alice, bob, dave) = (&users["alice"], &users["bob"], &users["dave"]);
    let call = |who: &Ctx, method: &str, path: &str, headers: &[(&str, &str)], body: &str| {
        let mut req = t.request(Some(who), method, &format!("/dav/{}", path.trim_start_matches('/')), &[], body.as_bytes().to_vec(), "text/xml; charset=utf-8");
        for (k, v) in headers {
            req.headers.insert(k.to_string(), json!(v));
        }
        t.raw(req)
    };
    let text = |r: &SiteResponse| String::from_utf8_lossy(&r.body).into_owned();
    let header = |r: &SiteResponse, name: &str| r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let (a, b) = (format!("u/{}", alice.user), format!("u/{}", bob.user));
    let propfind = |props: &str| {
        format!(
            r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>{props}</d:prop></d:propfind>"#
        )
    };

    // Discovery: who I am, where my calendar and address books are.
    let root = call(alice, "PROPFIND", "/", &[("depth", "0")], &propfind("<d:current-user-principal/>")).await.unwrap();
    assert_eq!(root.status, 207);
    assert!(text(&root).contains(&format!("<D:current-user-principal><D:href>/api/dav/comms/{a}/</D:href>")), "{}", text(&root));
    let me = text(
        &call(
            alice,
            "PROPFIND",
            &a,
            &[("depth", "0")],
            &propfind("<c:calendar-home-set/><card:addressbook-home-set/><d:displayname/><x:nothing xmlns:x=\"urn:x\"/>"),
        )
        .await
        .unwrap(),
    );
    for part in [
        format!("<C:calendar-home-set><D:href>/api/dav/comms/{a}/calendars/</D:href>"),
        format!("<CR:addressbook-home-set><D:href>/api/dav/comms/{a}/addressbooks/</D:href>"),
        "<D:displayname>Alice Rao</D:displayname>".into(),
        "<nothing xmlns=\"urn:x\"/></D:prop><D:status>HTTP/1.1 404 Not Found".into(),
    ] {
        assert!(me.contains(&part), "{part} in {me}");
    }
    let home = text(
        &call(
            alice,
            "PROPFIND",
            &format!("{a}/calendars"),
            &[("depth", "1")],
            &propfind("<d:resourcetype/><cs:getctag/><c:supported-calendar-component-set/>"),
        )
        .await
        .unwrap(),
    );
    assert!(
        home.contains(&format!("/api/dav/comms/{a}/calendars/default/")) && home.contains("<C:calendar/>") && home.contains("<C:comp name=\"VEVENT\"/>"),
        "{home}"
    );
    refused(call(alice, "PROPFIND", &format!("{b}/calendars/default"), &[], "").await, "not found");
    refused(call(dave, "PROPFIND", "/", &[], "").await, "forbidden");
    let options = call(alice, "OPTIONS", &a, &[], "").await.unwrap();
    assert!(header(&options, "dav").is_some_and(|d| d.contains("calendar-access") && d.contains("addressbook")));

    // An event from Alice's phone: guests, an alert, public.
    let day = (chrono::Utc::now() + chrono::Duration::days(3)).format("%Y%m%d").to_string();
    let event = |summary: &str, bob_answer: &str| {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:ABC-1\r\nDTSTART;TZID=Asia/Kolkata:{day}T100000\r\n\
             DTEND;TZID=Asia/Kolkata:{day}T110000\r\nSUMMARY:{summary}\r\nCLASS:PUBLIC\r\nORGANIZER:mailto:alice@acme.test\r\n\
             ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@acme.test\r\nATTENDEE;CN=Bob Shah;PARTSTAT={bob_answer}:mailto:bob@acme.test\r\n\
             ATTENDEE;CN=Pat:mailto:pat@partner.test\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        )
    };
    let path = format!("{a}/calendars/default/ABC-1.ics");
    let created = call(alice, "PUT", &path, &[("if-none-match", "*")], &event("Plan review", "NEEDS-ACTION")).await.unwrap();
    assert_eq!(created.status, 201, "{}", text(&created));
    assert_eq!(header(&created, "etag"), None, "Ferrum keeps its own form of the event: apps read it back");
    let stored: Value = t
        .scalar(
            "select jsonb_build_object('owner', e.owner, 'subject', e.subject, 'visibility', e.visibility, 'starts_at', to_char(e.starts_at at time zone 'UTC', 'HH24:MI'), \
             'attendees', (select jsonb_agg(jsonb_build_array(a.email, a.response) order by a.idx) from e_calendar_event__attendees a where a.parent_id = e.id), \
             'reminders', (select jsonb_agg(r.minutes_before) from e_calendar_event__reminders r where r.parent_id = e.id)) \
             from e_calendar_event e where e.tenant_id = $1 and e.ical_uid = 'ABC-1' and $2::uuid is null",
            None,
        )
        .await;
    assert_eq!(
        stored,
        json!({"owner": "alice@acme.test", "subject": "Plan review", "visibility": "Public", "starts_at": "04:30",
               "attendees": [["bob@acme.test", "Needs Action"], ["pat@partner.test", "Needs Action"]], "reminders": [10]})
    );
    assert_eq!(call(alice, "PUT", &path, &[("if-none-match", "*")], &event("Again", "NEEDS-ACTION")).await.unwrap().status, 412);

    // Listing and reading it back: the same ETag both ways.
    let listing = text(&call(alice, "PROPFIND", &format!("{a}/calendars/default"), &[("depth", "1")], &propfind("<d:getetag/><cs:getctag/>")).await.unwrap());
    let got = call(alice, "GET", &path, &[], "").await.unwrap();
    let etag = header(&got, "etag").expect("an ETag");
    assert!(listing.contains(&format!("<D:href>/api/dav/comms/{a}/calendars/default/ABC-1.ics</D:href>")), "{listing}");
    assert!(listing.contains(&format!("<D:getetag>{}</D:getetag>", etag.replace('"', "&quot;"))), "{listing}");
    let ics = text(&got);
    for l in ["UID:ABC-1", "SUMMARY:Plan review", "ATTENDEE;CN=Bob Shah;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION", "TRIGGER:-PT10M", "CLASS:PUBLIC"] {
        assert!(ics.contains(l), "{l} in {ics}");
    }
    assert_eq!(header(&call(alice, "GET", &path, &[], "").await.unwrap(), "etag"), Some(etag.clone()), "the same event reads the same");

    // Bob accepts from his app; the organizer is told, and her next change keeps his answer.
    let bobs = format!("{b}/calendars/default/ABC-1.ics");
    assert_eq!(call(bob, "PUT", &bobs, &[], &event("Bob cannot rename it", "ACCEPTED")).await.unwrap().status, 204);
    assert_eq!(t.notifications(alice, "Bob Shah accepted: Plan review%").await, 1);
    assert_eq!(call(alice, "PUT", &path, &[("if-match", "\"stale\"")], &event("Plan review 2", "NEEDS-ACTION")).await.unwrap().status, 412);
    let etag = header(&call(alice, "GET", &path, &[], "").await.unwrap(), "etag").unwrap();
    assert_eq!(call(alice, "PUT", &path, &[("if-match", &etag)], &event("Plan review 2", "NEEDS-ACTION")).await.unwrap().status, 204);
    let after: Value = t
        .scalar(
            "select jsonb_build_array(e.subject, (select a.response from e_calendar_event__attendees a where a.parent_id = e.id and a.email = 'bob@acme.test')) \
             from e_calendar_event e where e.tenant_id = $1 and e.ical_uid = 'ABC-1' and $2::uuid is null",
            None,
        )
        .await;
    assert_eq!(after, json!(["Plan review 2", "Accepted"]), "only the organizer renames; a guest's answer is theirs");

    // A weekly series with one occurrence moved: the occurrence becomes an event of its own, once.
    let weekly = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:WEEK-1\r\nDTSTART:{day}T090000Z\r\nDTEND:{day}T093000Z\r\nSUMMARY:Sync\r\n\
         RRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:WEEK-1\r\nRECURRENCE-ID:{next}T090000Z\r\nDTSTART:{next}T110000Z\r\n\
         DTEND:{next}T113000Z\r\nSUMMARY:Sync (moved)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        next = (chrono::Utc::now() + chrono::Duration::days(10)).format("%Y%m%d")
    );
    for _ in 0..2 {
        assert!(call(alice, "PUT", &format!("{a}/calendars/default/WEEK-1.ics"), &[], &weekly).await.unwrap().status < 300);
    }
    let moved: Vec<String> = t
        .scalar("select array_agg(subject || ' ' || to_char(starts_at at time zone 'UTC', 'HH24:MI')) from e_calendar_event where tenant_id = $1 and ical_uid like 'WEEK-1-%' and $2::uuid is null", None)
        .await;
    assert_eq!(moved, vec!["Sync (moved) 11:00".to_string()]);
    let series = text(&call(alice, "GET", &format!("{a}/calendars/default/WEEK-1.ics"), &[], "").await.unwrap());
    assert!(series.contains("RRULE:FREQ=WEEKLY;COUNT=3") && series.contains("EXDATE:"), "{series}");

    // Reports: a multiget (with a name that is not there) and a query for a past range.
    let multiget = format!(
        r#"<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>
           <d:href>/api/dav/comms/{a}/calendars/default/ABC-1.ics</d:href><d:href>/api/dav/comms/{a}/calendars/default/missing.ics</d:href></c:calendar-multiget>"#
    );
    let report = text(&call(alice, "REPORT", &format!("{a}/calendars/default"), &[("depth", "1")], &multiget).await.unwrap());
    assert!(report.contains("SUMMARY:Plan review 2") && report.contains("missing.ics</D:href><D:status>HTTP/1.1 404 Not Found"), "{report}");
    let past = r#"<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20200101T000000Z" end="20200201T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#;
    let query = text(&call(alice, "REPORT", &format!("{a}/calendars/default"), &[("depth", "1")], past).await.unwrap());
    assert!(query.contains("WEEK-1.ics") && !query.contains("ABC-1.ics"), "a repeating event may fall in any range; a single one only in its own: {query}");
    let sync = r#"<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:prop><d:getetag/></d:prop></d:sync-collection>"#;
    assert_eq!(call(alice, "REPORT", &format!("{a}/calendars/default"), &[], sync).await.unwrap().status, 403);

    // What Ferrum cannot keep is refused, not changed.
    let odd = |rule: &str, start: &str| {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ODD\r\nDTSTART{start}\r\nSUMMARY:Odd\r\n{rule}END:VEVENT\r\nEND:VCALENDAR\r\n")
    };
    for body in [odd("RRULE:FREQ=MINUTELY\r\n", &format!(":{day}T090000Z")), odd("", &format!(";TZID=Mars/Olympus:{day}T090000"))] {
        let r = call(alice, "PUT", &format!("{a}/calendars/default/ODD.ics"), &[], &body).await.unwrap();
        assert!(r.status == 403 && text(&r).contains("valid-calendar-object-resource"), "{}", text(&r));
    }

    // Deleting: a guest declines; the organizer cancels.
    assert_eq!(call(bob, "DELETE", &bobs, &[], "").await.unwrap().status, 204);
    let bobs_list = text(&call(bob, "PROPFIND", &format!("{b}/calendars/default"), &[("depth", "1")], &propfind("<d:getetag/>")).await.unwrap());
    assert!(!bobs_list.contains("ABC-1.ics"), "a declined invitation leaves the calendar: {bobs_list}");
    let etag = header(&call(alice, "GET", &path, &[], "").await.unwrap(), "etag").unwrap();
    assert_eq!(call(alice, "DELETE", &path, &[("if-match", &etag)], "").await.unwrap().status, 204);
    assert_eq!(t.scalar::<i64>("select count(*) from e_calendar_event where tenant_id = $1 and ical_uid = 'ABC-1' and $2::uuid is null", None).await, 0);
    refused(call(alice, "GET", &path, &[], "").await, "not found");

    // Address books: colleagues for everyone, CRM contacts only where CRM is installed.
    let books = text(&call(alice, "PROPFIND", &format!("{a}/addressbooks"), &[("depth", "1")], &propfind("<d:resourcetype/><d:displayname/>")).await.unwrap());
    assert!(books.contains("addressbooks/colleagues/") && books.contains("<CR:addressbook/>") && !books.contains("addressbooks/contacts/"), "{books}");
    refused(call(alice, "PROPFIND", &format!("{a}/addressbooks/contacts"), &[], "").await, "not found");
    let card_multiget = format!(
        r#"<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><d:href>/api/dav/comms/{a}/addressbooks/colleagues/{}.vcf</d:href></card:addressbook-multiget>"#,
        bob.user
    );
    let cards = text(&call(alice, "REPORT", &format!("{a}/addressbooks/colleagues"), &[], &card_multiget).await.unwrap());
    assert!(cards.contains("FN:Bob Shah") && cards.contains("EMAIL;TYPE=INTERNET,PREF:bob@acme.test") && cards.contains("N:Shah;Bob;;;"), "{cards}");
    let put_card = call(alice, "PUT", &format!("{a}/addressbooks/colleagues/{}.vcf", bob.user), &[], "BEGIN:VCARD\r\nEND:VCARD\r\n").await.unwrap();
    assert_eq!(put_card.status, 403, "address books are read-only");
    let patch = r#"<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><a:calendar-color>#FF0000FF</a:calendar-color></d:prop></d:set></d:propertyupdate>"#;
    let patched = text(&call(alice, "PROPPATCH", &format!("{a}/calendars/default"), &[], patch).await.unwrap());
    assert!(patched.contains("<A:calendar-color/></D:prop><D:status>HTTP/1.1 403 Forbidden"), "{patched}");
}

/// Hosted mailboxes on a real Stalwart (`FERRUM_MAIL_URL`, `FERRUM_MAIL_ADMIN`,
/// `FERRUM_MAIL_ADMIN_SECRET`; `tests/stalwart.sh` starts one): skipped without one.
async fn hosted_mail(t: &T, admin: &Ctx, users: &HashMap<String, Ctx>, imap: &FakeImap) {
    let Ok(url) = std::env::var("FERRUM_MAIL_URL") else {
        eprintln!("hosted mail skipped: no FERRUM_MAIL_URL (tests/stalwart.sh starts a mail server)");
        return;
    };
    let (k, mgr, bob, carol, dave) = (&t.k, &users["mgr"], &users["bob"], &users["carol"], &users["dave"]);
    let settings: Uuid = t.scalar("select id from e_comms_settings where tenant_id = $1 and $2::uuid is null", None).await;
    let sync = async || k.run_action(mgr, "CommsSettings", settings, "sync_mail", json!({})).await;
    let mailbox = async |user: &Ctx| -> Uuid { t.scalar("select id from e_hosted_mailbox where tenant_id = $1 and user_id = $2::text", Some(user.user)).await };
    let status =
        async |user: &Ctx| -> String { t.scalar("select status from e_hosted_mailbox where tenant_id = $1 and user_id = $2::text", Some(user.user)).await };
    let password = async |user: &Ctx| t.secret("HostedMailbox", mailbox(user).await, "secret").await;
    // Whether the address and password open the mailbox (a JMAP session).
    let opens = async |address: &str, password: &str| {
        let (client, session) = k.vetted_client(&format!("{url}/jmap/session"), true, Duration::from_secs(20), "it").await.unwrap();
        client.get(session).basic_auth(address, Some(password)).send().await.unwrap().status().is_success()
    };
    let in_step = json!({"domain": "acme.test", "created": 0, "updated": 0, "locked": 0, "shared": 0, "lists": 0, "failed": []});

    refused(sync().await, "invalid");
    k.update(mgr, "CommsSettings", settings, obj(json!({"mail_domain": "ACME.test"})), None).await.unwrap();
    let people: i64 =
        t.scalar("select count(*) from app_user where tenant_id = $1 and is_active and email like '%@acme.test' and $2::uuid is null", None).await;
    let made = sync().await.unwrap();
    assert_eq!((made["created"].clone(), made["failed"].clone()), (json!(people), json!([])), "{made}");
    let carol_password = password(carol).await.expect("a kept password");
    assert!(opens("carol@acme.test", &carol_password).await, "the kept password opens the mailbox");
    assert!(!opens("carol@acme.test", "Not-Her-Password-1").await);
    assert_eq!(sync().await.unwrap(), in_step);
    // Managers see mailboxes, not their passwords; nobody edits or deletes them by hand.
    assert_eq!(k.get(mgr, "HostedMailbox", mailbox(carol).await, false).await.unwrap()["secret"], json!(true));
    refused(k.update(admin, "HostedMailbox", mailbox(carol).await, obj(json!({"status": "Locked"})), None).await, "forbidden");
    refused(k.delete(admin, "HostedMailbox", mailbox(carol).await, None).await, "forbidden");

    // Deactivated: maintenance locks the mailbox (its mail stays).
    let bob_password = password(bob).await.unwrap();
    k.set_user_active(admin, bob.user, false).await.unwrap();
    t.maintenance(imap).await;
    assert_eq!((status(bob).await, password(bob).await), ("Locked".to_string(), None));
    assert!(!opens("bob@acme.test", &bob_password).await, "a deactivated person's password no longer opens it");
    // Back: maintenance waits ten minutes; "Sync Mailboxes" does not.
    k.set_user_active(admin, bob.user, true).await.unwrap();
    t.maintenance(imap).await;
    assert_eq!(status(bob).await, "Locked");
    assert_eq!(sync().await.unwrap()["updated"], json!(1));
    let renewed = password(bob).await.unwrap();
    assert!(renewed != bob_password && opens("bob@acme.test", &renewed).await);

    // A new address in the domain moves the mailbox; one outside it locks the mailbox.
    t.exec("update app_user set email = 'caroline@acme.test' where tenant_id = $1 and id = $2", Some(carol.user)).await;
    t.exec("update app_user set email = 'dave@elsewhere.test' where tenant_id = $1 and id = $2", Some(dave.user)).await;
    let moved = sync().await.unwrap();
    assert_eq!((moved["updated"].clone(), moved["locked"].clone(), moved["failed"].clone()), (json!(1), json!(1), json!([])), "{moved}");
    // (Stalwart 1.0 still resolves the old name at sign-in for a while: the same account.)
    assert!(opens("caroline@acme.test", &carol_password).await, "the moved mailbox keeps its password");
    assert_eq!(status(dave).await, "Locked");
    assert_eq!(sync().await.unwrap(), in_step);

    // ───────────── webmail: each person's own mailbox, through Ferrum ─────────────
    let alice = &users["alice"];
    let primary = |s: &Value| s["primaryAccounts"]["urn:ietf:params:jmap:mail"].as_str().unwrap().to_string();
    let bob_session = t.ok(bob, "GET", "/mail", &[], Value::Null).await;
    assert_eq!(bob_session["username"], json!("bob@acme.test"));
    assert!(bob_session.get("apiUrl").is_none(), "the mail server's own URLs stay inside");
    let (bob_acc, carol_acc) = (primary(&bob_session), primary(&t.ok(carol, "GET", "/mail", &[], Value::Null).await));
    refused(t.call(Some(dave), "GET", "/mail", &[], Value::Null).await, "forbidden");
    let using = json!(["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission", "urn:stalwart:jmap"]);
    let jmap = async |who: &Ctx, calls: Value| t.ok(who, "POST", "/mail/jmap", &[], json!({"using": using, "methodCalls": calls})).await;
    // Only mail passes: no administration, even of one's own account.
    refused(
        t.call(Some(bob), "POST", "/mail/jmap", &[], json!({"using": using, "methodCalls": [["x:Account/get", {"accountId": bob_acc}, "0"]]})).await,
        "forbidden",
    );
    let roles = async |who: &Ctx, acc: &str| -> HashMap<String, String> {
        let r = jmap(who, json!([["Mailbox/get", {"accountId": acc, "properties": ["role"]}, "0"]])).await;
        r["methodResponses"][0][1]["list"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| Some((m["role"].as_str()?.to_string(), m["id"].as_str()?.to_string())))
            .collect()
    };
    // Caroline writes to Bob with an attachment uploaded through Ferrum.
    let up = t.raw(t.request(Some(carol), "POST", &format!("/mail/upload/{carol_acc}"), &[], b"quarterly numbers".to_vec(), "text/plain")).await.unwrap();
    assert_eq!(up.status, 201);
    let blob: Value = serde_json::from_slice(&up.body).unwrap();
    let send_mail =
        async |who: &Ctx, acc: &str, from: &str, to: &str, subject: &str, html: &str, attachments: Value| {
            let boxes = roles(who, acc).await;
            let ids = jmap(who, json!([["Identity/get", {"accountId": acc}, "0"]])).await;
            let identity = ids["methodResponses"][0][1]["list"][0]["id"].clone();
            let out = jmap(who, json!([
            ["Email/set", {"accountId": acc, "create": {"m": {
                "mailboxIds": {(boxes["drafts"].clone()): true}, "from": [{"email": from}], "to": [{"email": to}], "subject": subject,
                "bodyValues": {"h": {"value": html}}, "htmlBody": [{"partId": "h", "type": "text/html"}], "attachments": attachments}}}, "0"],
            ["EmailSubmission/set", {"accountId": acc, "create": {"s": {"emailId": "#m", "identityId": identity}},
                "onSuccessUpdateEmail": {"#s": {(format!("mailboxIds/{}", boxes["drafts"])): null, (format!("mailboxIds/{}", boxes["sent"])): true}}}, "1"],
        ]))
        .await;
            assert!(out["methodResponses"][1][1]["created"]["s"].is_object(), "{out}");
            out["methodResponses"][0][1]["created"]["m"]["id"].as_str().unwrap().to_string()
        };
    let html = r#"<p style="color: navy">Numbers attached.</p><script>alert(1)</script><img src="https://tracker.example/p.gif">"#;
    send_mail(
        carol,
        &carol_acc,
        "caroline@acme.test",
        "bob@acme.test",
        "Q3 numbers",
        html,
        json!([{"blobId": blob["blobId"], "type": "text/plain", "name": "numbers.txt"}]),
    )
    .await;
    let inbox = roles(bob, &bob_acc).await["inbox"].clone();
    let mut received = None;
    for _ in 0..60 {
        let r = jmap(bob, json!([["Email/query", {"accountId": bob_acc, "filter": {"inMailbox": inbox}}, "0"]])).await;
        if let Some(id) = r["methodResponses"][0][1]["ids"][0].as_str() {
            received = Some(id.to_string());
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let email = received.expect("Bob received Caroline's mail");
    let view = t.ok(bob, "GET", &format!("/mail/message/{bob_acc}/{email}"), &[], Value::Null).await;
    let shown = view["html"].as_str().unwrap();
    assert_eq!(view["subject"], json!("Q3 numbers"));
    assert!(shown.contains("Numbers attached") && shown.contains("navy") && !shown.contains("script") && !shown.contains("tracker.example"), "{shown}");
    assert_eq!(view["remote_images"], json!(1));
    let with_images = t.ok(bob, "GET", &format!("/mail/message/{bob_acc}/{email}"), &[("images", "1")], Value::Null).await;
    assert!(with_images["html"].as_str().unwrap().contains("tracker.example"));
    let attachment = &view["attachments"][0];
    assert_eq!(attachment["name"], json!("numbers.txt"));
    let blob_path = format!("/mail/blob/{bob_acc}/{}", attachment["blobId"].as_str().unwrap());
    let file = t.raw(t.request(Some(bob), "GET", &blob_path, &[("name", "numbers.txt"), ("type", "text/html")], vec![], "")).await.unwrap();
    assert_eq!(file.body, b"quarterly numbers");
    assert_eq!(file.content_type, "application/octet-stream", "never served as a type the browser runs");
    assert!(file.headers.iter().any(|(h, v)| h == "content-disposition" && v.starts_with("attachment")));
    refused(t.call(Some(carol), "GET", &format!("/mail/message/{bob_acc}/{email}"), &[], Value::Null).await, "not found");

    // Filed onto a customer: Bob's communication on its timeline; again is the same one.
    let customer: Uuid = t.scalar("select id from e_customer where tenant_id = $1 and $2::uuid is null order by created_at limit 1", None).await;
    let filing = json!({"account": bob_acc, "email": email, "entity": "Customer", "record": customer.to_string()});
    let filed = t.ok(bob, "POST", "/mail/file", &[], filing.clone()).await;
    let comm_id: Uuid = filed["communication"].as_str().unwrap().parse().unwrap();
    let comm = t.comm(comm_id).await;
    assert_eq!(
        (comm["direction"].clone(), comm["reference_entity"].clone(), comm["reference_id"].clone(), comm["subject"].clone(), comm["created_by"].clone()),
        (json!("Received"), json!("Customer"), json!(customer.to_string()), json!("Q3 numbers"), json!(bob.user.to_string()))
    );
    assert_eq!(comm["attachments"].as_array().map(Vec::len), Some(1));
    assert_eq!(t.ok(bob, "POST", "/mail/file", &[], filing).await, filed);
    let other = uid(&Value::Object(k.insert(alice, "Customer", obj(json!({"customer_name": "Initech"}))).await.unwrap()));
    refused(
        t.call(Some(bob), "POST", "/mail/file", &[], json!({"account": bob_acc, "email": email, "entity": "Customer", "record": other.to_string()})).await,
        "conflict",
    );
    // Only onto records one can read.
    let carol_sent = roles(carol, &carol_acc).await["sent"].clone();
    let copy = jmap(carol, json!([["Email/query", {"accountId": carol_acc, "filter": {"inMailbox": carol_sent}}, "0"]])).await;
    let copy = copy["methodResponses"][0][1]["ids"][0].as_str().unwrap().to_string();
    refused(
        t.call(Some(carol), "POST", "/mail/file", &[], json!({"account": carol_acc, "email": copy, "entity": "Customer", "record": customer.to_string()}))
            .await,
        "forbidden",
    );
    // Mail one sent is filed as Sent, and is never sent again.
    let reply = send_mail(bob, &bob_acc, "bob@acme.test", "caroline@acme.test", "Re: Q3 numbers", "<p>Thanks</p>", json!([])).await;
    let filed = t.ok(bob, "POST", "/mail/file", &[], json!({"account": bob_acc, "email": reply, "entity": "Customer", "record": customer.to_string()})).await;
    t.drain().await;
    let sent = t.comm(filed["communication"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!((sent["direction"].clone(), sent["status"].clone(), sent["attempts"].clone()), (json!("Sent"), json!("Sent"), Value::Null), "{sent:?}");

    // App passwords for mail programs, through the same door.
    let made = jmap(bob, json!([["x:AppPassword/set", {"accountId": bob_acc, "create": {"p": {"description": "Phone"}}}, "0"]])).await;
    let app_password = made["methodResponses"][0][1]["created"]["p"]["secret"].as_str().expect("a new app password").to_string();
    assert!(opens("bob@acme.test", &app_password).await);

    // A kept password the mail server no longer takes is replaced on the spot.
    let sys = Ctx::system(t.tenant, k.registry.schema(t.tenant).await.unwrap());
    k.update(&sys, "HostedMailbox", mailbox(alice).await, obj(json!({"secret": "Not-The-Password-1"})), None).await.unwrap();
    assert_eq!(t.ok(alice, "GET", "/mail", &[], Value::Null).await["username"], json!("alice@acme.test"));
    assert!(opens("alice@acme.test", &password(alice).await.unwrap()).await);

    // ───────────── a shared mailbox and a distribution list ─────────────
    refused(k.insert(mgr, "SharedMailbox", obj(json!({"address": "-sales"}))).await, "invalid");
    refused(k.insert(mgr, "SharedMailbox", obj(json!({"address": "sales", "members": [{"email": "nobody@acme.test"}]}))).await, "invalid");
    let sales = k
        .insert(
            mgr,
            "SharedMailbox",
            obj(json!({"address": " Sales@acme.test", "display_name": "Sales team", "members": [{"email": "bob@acme.test"}, {"email": "Caroline@acme.test"}]})),
        )
        .await
        .unwrap();
    assert_eq!(sales["address"], json!("sales"));
    let staff = uid(&Value::Object(k.insert(mgr, "EmailGroup", obj(json!({"group_name": "All staff", "mail_address": "All-Staff"}))).await.unwrap()));
    for (email, unsubscribed) in [("bob@acme.test", false), ("caroline@acme.test", false), ("mgr@acme.test", true)] {
        k.insert(mgr, "EmailGroupMember", obj(json!({"email_group": staff, "email": email, "unsubscribed": unsubscribed}))).await.unwrap();
    }
    let synced = sync().await.unwrap();
    assert_eq!(
        (synced["shared"].clone(), synced["lists"].clone(), synced["failed"].clone()),
        (json!(3), json!(1), json!([])),
        "the group, two members, the list: {synced}"
    );
    assert_eq!(sync().await.unwrap(), in_step);
    // Members see the shared mailbox as another account in their mail.
    let shared_account = async |who: &Ctx| -> Option<String> {
        let s = t.ok(who, "GET", "/mail", &[], Value::Null).await;
        s["accounts"].as_object().unwrap().iter().find(|(_, a)| a["isPersonal"] == json!(false)).map(|(id, _)| id.clone())
    };
    let sales_acc = shared_account(bob).await.expect("Bob sees sales@");
    assert_eq!(shared_account(carol).await.as_deref(), Some(sales_acc.as_str()));
    assert!(shared_account(alice).await.is_none());
    let arrived = async |who: &Ctx, acc: &str, subject: &str| {
        let inbox = roles(who, acc).await["inbox"].clone();
        for _ in 0..60 {
            let r = jmap(
                who,
                json!([["Email/query", {"accountId": acc, "filter": {"inMailbox": inbox}}, "0"],
                ["Email/get", {"accountId": acc, "#ids": {"resultOf": "0", "name": "Email/query", "path": "/ids"}, "properties": ["subject"]}, "1"]]),
            )
            .await;
            if r["methodResponses"][1][1]["list"].as_array().unwrap().iter().any(|m| m["subject"] == json!(subject)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        false
    };
    let alice_acc = primary(&t.ok(alice, "GET", "/mail", &[], Value::Null).await);
    send_mail(alice, &alice_acc, "alice@acme.test", "sales@acme.test", "Lead from the fair", "<p>Globex wants a demo.</p>", json!([])).await;
    assert!(arrived(bob, &sales_acc, "Lead from the fair").await, "mail to sales@ lands in the shared mailbox");
    send_mail(alice, &alice_acc, "alice@acme.test", "all-staff@acme.test", "Friday town hall", "<p>4pm</p>", json!([])).await;
    assert!(arrived(bob, &bob_acc, "Friday town hall").await, "the list passes mail on to its members");
    // Leaving the shared mailbox and clearing the list's address take effect at the next round.
    k.update(mgr, "SharedMailbox", uid(&Value::Object(sales)), obj(json!({"members": [{"email": "bob@acme.test"}]})), None).await.unwrap();
    k.update(mgr, "EmailGroup", staff, obj(json!({"mail_address": ""})), None).await.unwrap();
    let synced = sync().await.unwrap();
    assert_eq!((synced["shared"].clone(), synced["lists"].clone()), (json!(1), json!(1)), "{synced}");
    assert!(shared_account(carol).await.is_none());
    assert!(shared_account(bob).await.is_some());
}
