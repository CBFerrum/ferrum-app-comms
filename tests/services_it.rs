//! Comms' services, the meeting server's and the mail server's files (src/meet.rs, src/hosted.rs; Ferrum
//! docs/app-contract.md, "Declaring a service"), against a real PostgreSQL (`FERRUM_COMMS_TEST_DATABASE_URL`; reset first)
//! and LiveKit itself where it is installed (`FERRUM_TEST_LIVEKIT`, else `livekit-server` on the PATH).
//!
//! * `meet` on a new installation: `meet.secret` made by the first render, once though two replicas render at once;
//!   LiveKit started on the file written takes the tokens Comms signs for a person joining.
//! * `meet` where the operator set LiveKit's secret before the first render (`PUT /api/operator/secrets/comms/meet.secret`):
//!   the render keeps it; a rotation's overlap lets in the version before and the new one, and its end leaves the version
//!   before out.
//! * `mail`: `mail.admin_secret` made once and bound to the mail server's host, written alone into `admin-secret`, and
//!   what Comms signs in to the mail server with (a stand-in reads the file as Stalwart would: Stalwart is not here); one
//!   the operator set before the first render, kept; a rotation taken at the mail server's next start.
//! * Nothing set up: plain refusals, nothing made. A closed vault: nothing written. No secret in a log, an error, the
//!   vault's record or a table.

use ferrum_kernel::companion::{self, Rendered};
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::vault::{self, Kdf, Opener, Scope, Vault, Zeroizing};
use ferrum_kernel::{Ctx, Db, DbConfig, Error, HookRegistry, Kernel, KernelSettings, SiteRequest};
use ferrum_meta::Catalog;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn url() -> String {
    std::env::var("FERRUM_COMMS_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_comms_test".into())
}

/// What a replica opens the vault with: the address's password (none: nothing to make the first slot with).
fn opener(database_url: String) -> Opener {
    Opener { database_url, file: "/nonexistent/root.key".into(), kdf: Kdf { m_kib: 64, t: 1, p: 1 }, ..Default::default() }
}

/// A replica: its own pool, its vault opened, Comms registered as the server registers it; and Comms' handle.
async fn replica(database_url: String) -> (Arc<Kernel>, Vault) {
    let db = Db::connect(DbConfig { url: url(), max_connections: 8, ..Default::default() }).await.expect("connect");
    vault::open(&db, opener(database_url), false).await.expect("the vault");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_comms::packages().expect("app packages"));
    let mut hooks = HookRegistry::default();
    let mut comms = None;
    hooks.app("comms", &[], |h| {
        ferrum_app_comms::register(h);
        comms = Some(h.vault());
    });
    hooks.own("comms", &ferrum_app_comms::packages().unwrap().iter().map(|p| p.name().to_string()).collect::<Vec<_>>());
    let settings = KernelSettings { secret_key: Some(ferrum_kernel::secret::SecretKey::new([7u8; 32])), ..Default::default() };
    let k = Kernel::boot(db, Catalog::from_packages(packages).expect("catalog"), hooks, settings, None).await.expect("boot");
    (k, comms.expect("Comms' handle"))
}

/// The settings as the server resolved them, as a render is given them.
fn given(pairs: &[(&str, String)]) -> impl Fn(&str) -> Option<String> + Sync + use<> {
    let pairs: Vec<(String, String)> = pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    move |name: &str| pairs.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

/// What Comms reads with `ferrum_kernel::env`: the server's resolved settings (the environment's included).
fn resolved(pairs: &[(&str, Option<String>)]) {
    ferrum_kernel::env::set(pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect());
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("comms-services-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn file<'a>(r: &'a Rendered, name: &str) -> &'a [u8] {
    r.files.iter().find(|f| f.name == name).map(|f| f.bytes.as_slice()).expect("the file")
}

/// livekit.yaml's keys, in order: (API key, secret).
fn keys_of(yaml: &[u8]) -> Vec<(String, String)> {
    let text = std::str::from_utf8(yaml).unwrap();
    let keys = text.split("\nkeys:\n").nth(1).expect("keys");
    keys.lines().map(|l| l.trim().split_once(": ").map(|(k, v)| (serde_json::from_str(k).unwrap(), serde_json::from_str(v).unwrap())).unwrap()).collect()
}

/// The installation's vault events of `name` with `action`.
async fn events(k: &Kernel, action: &str, name: &str) -> Vec<Value> {
    vault::events(&k.db, None, 1000).await.unwrap().into_iter().filter(|e| e.action == action && e.name == name).map(|e| e.details).collect()
}

/// Every log line of the test, as fields: nothing secret may be among them.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<String>>);

struct Fields<'a>(&'a Mutex<String>);

impl tracing::field::Visit for Fields<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let _ = write!(self.0.lock().unwrap(), "{}={value:?} ", field.name());
    }
}

impl tracing::Subscriber for Logs {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        span.record(&mut Fields(&self.0));
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, values: &tracing::span::Record<'_>) {
        values.record(&mut Fields(&self.0));
    }
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        event.record(&mut Fields(&self.0));
        self.0.lock().unwrap().push('\n');
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[test]
fn comms_services_render_what_livekit_and_the_mail_server_read() {
    let logs = Logs::default();
    tracing::subscriber::set_global_default(logs.clone()).expect("the test's logs");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario(logs)).await.unwrap() });
}

async fn scenario(logs: Logs) {
    let db = Db::connect(DbConfig { url: url(), max_connections: 2, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists vault cascade; drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    // Two replicas; the second registered last, so it is the one whose handle Comms' own code keeps (keys.rs).
    let (k2, _) = replica(url()).await;
    let (k, comms) = replica(url()).await;
    let none = given(&[]);
    // Every secret seen, to look for afterwards in the logs, the errors, the vault's record and the tables.
    let mut secrets: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // ── declared by Comms, listed with its files and what the vault keeps; renderable here ──
    let listed: Vec<(String, String, Vec<String>, Vec<String>, bool)> =
        k.companions(&none).await.into_iter().map(|d| (d.name, d.owner, d.files, d.made, d.refused.is_some())).collect();
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(
        listed,
        [
            ("mail".to_string(), "comms".to_string(), s(&["admin-secret"]), s(&["mail.admin_secret"]), false),
            ("meet".into(), "comms".into(), s(&["livekit.yaml"]), s(&["meet.secret"]), false),
        ]
    );

    // ── nothing set up: each says so plainly, and nothing is made ──
    let tenant = k
        .create_tenant(NewTenant {
            slug: "acme".into(),
            name: "Acme Ltd".into(),
            admin_email: "admin@acme.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["core".into(), "comms".into()],
            settings: None,
        })
        .await
        .expect("tenant");
    let session = k.login("acme", "admin@acme.test", "Correct-Horse-9").await.expect("login");
    let admin = k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx");
    resolved(&[]);
    assert_eq!(call(&k, &admin, "GET", "/meet").await.unwrap(), json!({"available": false, "recordings": false}));
    let e = ferrum_app_comms::mail_admin_account(&k).await.unwrap_err().to_string();
    assert!(e.contains("hosted mail is not set up on this server"), "{e}");
    let e = k.render("mail", &none).await.unwrap_err().to_string();
    assert!(e.contains("the service mail needs the setting comms.mail_url, which is not set"), "{e}");
    assert!(comms.describe(&k, Scope::Installation, "mail.admin_secret").await.unwrap().is_none(), "nothing made");
    errors.push(e);

    // ── meet, new: made by the first render, once, though two replicas render at once ──
    let lk = given(&[("comms.meet_node_ip", "127.0.0.1".into()), ("comms.meet_external_ip", "false".into())]);
    let (a, b) = tokio::join!(k.render("meet", &lk), k2.render("meet", &lk));
    let (a, b) = (a.expect("one replica"), b.expect("the other"));
    assert!(file(&a, "livekit.yaml") == file(&b, "livekit.yaml"), "the same secret in both");
    let made = events(&k, "make", "meet.secret").await;
    assert_eq!(made.len(), 1, "made once");
    assert_eq!((made[0]["owner"].as_str(), made[0]["service"].as_str(), made[0]["version"].as_i64()), (Some("comms"), Some("meet"), Some(1)));
    let yaml = std::str::from_utf8(file(&a, "livekit.yaml")).unwrap().to_string();
    assert!(
        yaml.starts_with("port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: \"127.0.0.1\"\nkeys:\n"),
        "LiveKit's ports and the address it gives browsers"
    );
    let first = keys_of(file(&a, "livekit.yaml"));
    assert_eq!((first.len(), first[0].0.as_str(), first[0].1.len()), (1, "ferrum.1", 43), "one key, 32 random bytes as base64url");
    secrets.push(first[0].1.clone());
    let d = comms.describe(&k, Scope::Installation, "meet.secret").await.unwrap().unwrap();
    assert_eq!((d.managed_by.as_deref(), d.rule.reveal, d.rule.overlap_secs, d.rule.hosts.len()), (Some("comms"), true, 86_400, 0));
    // Its defaults, and what is refused before anything is written.
    let plain = k.render("meet", &none).await.unwrap();
    assert!(std::str::from_utf8(file(&plain, "livekit.yaml")).unwrap().contains("  use_external_ip: true\n  node_ip: \"\"\n"));
    for (key, value, says) in [
        ("comms.meet_external_ip", "maybe", "comms.meet_external_ip is true or false"),
        ("comms.meet_node_ip", "meet.example.com", "comms.meet_node_ip is the IP address"),
    ] {
        let e = k.render("meet", &given(&[(key, value.into())])).await.unwrap_err().to_string();
        assert!(e.contains(says), "{e}");
        errors.push(e);
    }

    // ── LiveKit on the file written: a person joining a room is let in with the token Comms signs ──
    let mut lk_run = Livekit::new(livekit());
    let port = lk_run.as_ref().map_or(7880, |l| l.port);
    resolved(&[("FERRUM_MEET_URL", Some(format!("ws://127.0.0.1:{port}")))]);
    let dir = scratch("meet");
    let mode = |p: &Path| std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(p).unwrap().permissions()) & 0o777;
    companion::write(&dir, &a).expect("write");
    assert_eq!(mode(&dir.join("livekit.yaml")), 0o600);
    let before = join(&k, &admin).await;
    assert_eq!(claims(&before)["iss"], "ferrum.1");
    if let Some(run) = lk_run.as_mut() {
        run.start_on(&dir.join("livekit.yaml")).await;
        assert_eq!(run.validate(&before).await, 200, "LiveKit takes Comms' token");
    }

    // ── a rotation: the version before still signs while the overlap lasts, and LiveKit restarted lets in both ──
    let rotated = k.rotate_companion("meet", &lk).await.expect("rotate");
    assert_eq!((rotated.len(), rotated[0].version, rotated[0].previous_until.is_some()), (1, 2, true));
    let during = join(&k, &admin).await;
    assert_eq!(claims(&during)["iss"], "ferrum.1", "the version before, which LiveKit not restarted yet knows");
    let next = k.render("meet", &lk).await.unwrap();
    let two = keys_of(file(&next, "livekit.yaml"));
    assert_eq!(two.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["ferrum.2", "ferrum.1"]);
    assert!(two[1].1 == first[0].1 && two[0].1 != first[0].1, "the new secret first, then the one before");
    secrets.push(two[0].1.clone());
    let unsigned = unsigned("ferrum.2");
    let (_, signature) = comms.sign_at(&k, Scope::Installation, "meet.secret", unsigned.as_bytes(), Some(2)).await.unwrap();
    let new_one = format!("{unsigned}.{}", b64(&signature));
    if let Some(run) = lk_run.as_mut() {
        assert_eq!(run.validate(&during).await, 200, "LiveKit not restarted yet");
        run.stop().await;
        companion::write(&dir, &next).expect("write");
        run.start_on(&dir.join("livekit.yaml")).await;
        assert_eq!((run.validate(&during).await, run.validate_raw(&new_one).await), (200, 200), "restarted within the overlap: both");
        run.stop().await;
    }
    // The overlap over (as an hour's upkeep finds it): the current version alone, the one before left out.
    let mut tx = k.db.pool.begin().await.unwrap();
    sqlx::query("select set_config('ferrum.vault', 'on', true)").execute(&mut *tx).await.unwrap();
    sqlx::query("update vault.secret set valid_until = now() - interval '1 second' where owner = 'comms' and name = 'meet.secret' and valid_until is not null")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let after = join(&k, &admin).await;
    assert_eq!(claims(&after)["iss"], "ferrum.2");
    let last = k.render("meet", &lk).await.unwrap();
    assert_eq!(keys_of(file(&last, "livekit.yaml")).iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["ferrum.2"]);
    if let Some(run) = lk_run.as_mut() {
        companion::write(&dir, &last).expect("write");
        run.start_on(&dir.join("livekit.yaml")).await;
        assert_eq!((run.validate(&after).await, run.validate(&during).await), (200, 401), "the version before is left out");
        run.stop().await;
    } else {
        println!("livekit-server is not installed (FERRUM_TEST_LIVEKIT): LiveKit was not started");
    }

    // ── meet, where the operator set LiveKit's secret before the first render: kept as it is ──
    comms.remove(&k, Scope::Installation, "meet.secret").await.unwrap();
    let typed = "the-secret-livekit-was-given-by-its-operator-0123";
    secrets.push(typed.into());
    let value = vault::New::Value(Zeroizing::new(typed.as_bytes().to_vec()));
    comms.set(&k, Scope::Installation, "meet.secret", value, vault::Rule::default()).await.unwrap();
    let kept = k.render("meet", &lk).await.unwrap();
    let one = keys_of(file(&kept, "livekit.yaml"));
    assert!(one.len() == 1 && one[0].0 == "ferrum.1" && one[0].1 == typed, "the secret LiveKit runs with");
    assert_eq!(events(&k, "manage", "meet.secret").await.len(), 1, "kept once");

    // ── mail, new: made once, bound to the mail server's host, the file the secret alone ──
    let mail = Stalwart::start().await;
    let mail_url = format!("http://127.0.0.1:{}", mail.port);
    let at = given(&[("comms.mail_url", mail_url.clone())]);
    let (a, b) = tokio::join!(k.render("mail", &at), k2.render("mail", &at));
    let (a, b) = (a.expect("one replica"), b.expect("the other"));
    assert!(file(&a, "admin-secret") == file(&b, "admin-secret"), "the same in both");
    assert_eq!(events(&k, "make", "mail.admin_secret").await.len(), 1, "made once");
    let pw = std::str::from_utf8(file(&a, "admin-secret")).unwrap().to_string();
    assert!(pw.len() == 43 && !pw.contains('\n'), "the secret alone");
    secrets.push(pw.clone());
    let d = comms.describe(&k, Scope::Installation, "mail.admin_secret").await.unwrap().unwrap();
    assert_eq!((d.managed_by.as_deref(), d.rule.reveal, d.rule.overlap_secs, d.rule.hosts.clone()), (Some("comms"), true, 0, vec!["127.0.0.1".to_string()]));
    let mail_dir = scratch("mail");
    companion::write(&mail_dir, &a).expect("write");
    assert_eq!(mode(&mail_dir.join("admin-secret")), 0o600);
    // The mail server started on it: Comms signs in as its fallback administrator.
    mail.start_on(&mail_dir.join("admin-secret"));
    let admin_name = ("FERRUM_MAIL_ADMIN", Some("admin".to_string()));
    resolved(&[("FERRUM_MAIL_URL", Some(mail_url.clone())), admin_name.clone()]);
    assert_eq!(ferrum_app_comms::mail_admin_account(&k).await.expect("signed in"), "admin-account");
    // Rotated: one value, taken at the mail server's next start.
    k.rotate_companion("mail", &at).await.expect("rotate");
    let e = ferrum_app_comms::mail_admin_account(&k).await.unwrap_err().to_string();
    assert!(e.contains("401"), "the mail server not restarted yet: {e}");
    errors.push(e);
    let next = k.render("mail", &at).await.unwrap();
    secrets.push(std::str::from_utf8(file(&next, "admin-secret")).unwrap().to_string());
    companion::write(&mail_dir, &next).expect("write");
    mail.start_on(&mail_dir.join("admin-secret"));
    assert_eq!(ferrum_app_comms::mail_admin_account(&k).await.expect("signed in"), "admin-account", "restarted at once");
    // Its host is the one it was made for: an address elsewhere does not take it there.
    resolved(&[("FERRUM_MAIL_URL", Some(format!("http://localhost:{}", mail.port))), admin_name.clone()]);
    let e = ferrum_app_comms::mail_admin_account(&k).await.unwrap_err().to_string();
    assert!(e.contains("may not be sent to localhost"), "{e}");
    errors.push(e);

    // ── mail, where the operator set the administrator's password before the first render: kept as the mail server takes it ──
    comms.remove(&k, Scope::Installation, "mail.admin_secret").await.unwrap();
    let typed = "the-administrators-password-typed-for-both-0123";
    secrets.push(typed.into());
    mail.accept(typed);
    let value = vault::New::Value(Zeroizing::new(typed.as_bytes().to_vec()));
    let rule = vault::Rule { hosts: vec!["127.0.0.1".into()], ..Default::default() };
    comms.set(&k, Scope::Installation, "mail.admin_secret", value, rule).await.unwrap();
    resolved(&[("FERRUM_MAIL_URL", Some(mail_url.clone())), admin_name.clone()]);
    assert_eq!(ferrum_app_comms::mail_admin_account(&k).await.expect("signed in with the operator's"), "admin-account");
    let kept = k.render("mail", &none).await.expect("kept: nothing is made, so the address is not needed");
    assert!(file(&kept, "admin-secret") == typed.as_bytes(), "the password the mail server already takes");
    assert_eq!(events(&k, "manage", "mail.admin_secret").await.len(), 1);
    assert_eq!(ferrum_app_comms::mail_admin_account(&k).await.expect("nothing restarted"), "admin-account");

    // ── nothing secret anywhere it should not be ──
    let record = serde_json::to_string(&vault::events(&k.db, None, 1000).await.unwrap()).unwrap();
    let mut tx = k.db.pool.begin().await.unwrap();
    sqlx::query("select set_config('ferrum.vault', 'on', true)").execute(&mut *tx).await.unwrap();
    let tables: Vec<(String, String)> =
        sqlx::query_as("select schemaname::text, tablename::text from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    tracing::info!(probe = "comms-services-it", "the test's own line");
    let logged = logs.0.lock().unwrap().clone();
    assert!(logged.contains("comms-services-it"), "the logs are taken");
    for (i, secret) in secrets.iter().enumerate() {
        assert!(!record.contains(secret.as_str()), "secret {i} is in the vault's record");
        assert!(!logged.contains(secret.as_str()), "secret {i} is in a log");
        assert!(!errors.iter().any(|e| e.contains(secret.as_str())), "secret {i} is in an error");
        for (schema, table) in &tables {
            let sql = format!("select count(*) from \"{schema}\".\"{table}\" t where t::text like '%' || $1 || '%'");
            let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql)).bind(secret).fetch_one(&mut *tx).await.unwrap();
            assert_eq!(n, 0, "secret {i} is plain in {schema}.{table}");
        }
    }
    tx.rollback().await.unwrap();

    // ── a closed vault (a fresh database, and nothing to make its first slot with): nothing written ──
    sqlx::raw_sql("drop schema if exists vault cascade; drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let no_password = url().replacen("ferrum:ferrum@", "ferrum@", 1);
    assert_ne!(no_password, url(), "the test's address has a password to take out");
    let (closed, _) = replica(no_password).await;
    for service in ["meet", "mail"] {
        let e = closed.render(service, &at).await.unwrap_err().to_string();
        assert!(e.starts_with("the vault is closed"), "{service}: {e}");
    }
    assert!(closed.rotate_companion("meet", &lk).await.unwrap_err().to_string().starts_with("the vault is closed"));
    let listed = closed.companions(&at).await;
    assert!(listed.iter().all(|d| d.refused.as_deref().is_some_and(|r| r.starts_with("the vault is closed"))), "{listed:?}");
    assert!(comms.describe(&closed, Scope::Installation, "meet.secret").await.is_err(), "nothing made");
    for d in [&dir, &mail_dir] {
        let _ = std::fs::remove_dir_all(d);
    }
    ferrum_kernel::env::set(HashMap::new());
}

// ───────────────────────────── helpers ─────────────────────────────

fn b64(bytes: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

/// A token's header and claims, unsigned, naming `iss`, for a person joining room `r1`.
fn unsigned(iss: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = json!({"iss": iss, "sub": "it", "nbf": now - 10, "exp": now + 600, "video": {"room": "r1", "roomJoin": true}});
    format!("{}.{}", b64(br#"{"alg":"HS256","typ":"JWT"}"#), b64(claims.to_string().as_bytes()))
}

fn claims(pass: &Value) -> Value {
    let body = pass["token"].as_str().unwrap().split('.').nth(1).unwrap();
    serde_json::from_slice(&base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, body).unwrap()).unwrap()
}

/// `/api/app/comms{path}` as `who`.
async fn call(k: &Kernel, who: &Ctx, method: &str, path: &str) -> Result<Value, Error> {
    let mut headers = Map::new();
    headers.insert("content-type".into(), json!("application/json"));
    let req = SiteRequest {
        tenant: who.tenant,
        user: Some(who.clone()),
        method: method.into(),
        path: path.into(),
        query: Map::new(),
        headers,
        body: if method == "POST" { b"{}".to_vec() } else { vec![] },
        client_ip: "127.0.0.1".into(),
    };
    let r = k.hooks.site("comms").expect("comms' endpoint").clone().handle(k, req).await?;
    Ok(serde_json::from_slice(&r.body).unwrap_or(Value::Null))
}

/// A person joining a room they started: what Comms answers (`{url, token, title}`).
async fn join(k: &Kernel, who: &Ctx) -> Value {
    let room = call(k, who, "POST", "/meet/rooms").await.expect("a room");
    call(k, who, "POST", &format!("/meet/room/{}/token", room["id"].as_str().unwrap())).await.expect("a token")
}

fn livekit() -> Option<PathBuf> {
    std::env::var("FERRUM_TEST_LIVEKIT")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("livekit-server")).find(|p| p.is_file())))
}

/// LiveKit, on free ports of this machine's own address (the flags take the place of the file's ports, which are
/// LiveKit's own in its container); nothing it says is kept.
struct Livekit {
    bin: PathBuf,
    port: u16,
    tcp: u16,
    udp: u16,
    child: Option<tokio::process::Child>,
}

impl Livekit {
    fn new(bin: Option<PathBuf>) -> Option<Livekit> {
        let free = || std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        bin.map(|bin| Livekit { bin, port: free(), tcp: free(), udp, child: None })
    }

    async fn start(&mut self, args: &[&std::ffi::OsStr]) {
        let child = tokio::process::Command::new(&self.bin)
            .args(args)
            .args(["--bind", "127.0.0.1", "--node-ip", "127.0.0.1"])
            .args(["--port", &self.port.to_string(), "--rtc.tcp_port", &self.tcp.to_string(), "--udp-port", &self.udp.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("livekit-server");
        self.child = Some(child);
        for _ in 0..100 {
            if self.get("/", None).await == Some(200) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("LiveKit did not answer on {}", self.port);
    }

    /// The status LiveKit answers a GET of `path` with, asked as a browser asks; none while it does not listen.
    async fn get(&self, path: &str, token: Option<&str>) -> Option<u16> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.ok()?;
        let auth = token.map(|t| format!("authorization: Bearer {t}\r\n")).unwrap_or_default();
        let ask = format!("GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\n{auth}accept-encoding: gzip\r\nconnection: close\r\n\r\n");
        sock.write_all(ask.as_bytes()).await.ok()?;
        let mut answer = Vec::new();
        sock.read_to_end(&mut answer).await.ok()?;
        String::from_utf8_lossy(&answer).split(' ').nth(1)?.parse().ok()
    }

    async fn start_on(&mut self, config: &Path) {
        self.start(&["--config".as_ref(), config.as_os_str()]).await;
    }

    async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
        }
    }

    /// LiveKit's answer to a token (`/rtc/validate`, as its clients check one).
    async fn validate_raw(&self, token: &str) -> u16 {
        self.get("/rtc/validate", Some(token)).await.expect("LiveKit answers")
    }

    async fn validate(&self, pass: &Value) -> u16 {
        self.validate_raw(pass["token"].as_str().unwrap()).await
    }
}

/// A stand-in for Stalwart's administration (Stalwart is not on this machine): it takes its fallback administrator's
/// password from the file written for it as it starts, as Stalwart's `%{file:…}%` does, and opens a JMAP session only for
/// `admin` with that password.
struct Stalwart {
    port: u16,
    password: Arc<Mutex<Option<Zeroizing<String>>>>,
}

impl Stalwart {
    async fn start() -> Stalwart {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let password: Arc<Mutex<Option<Zeroizing<String>>>> = Arc::default();
        let held = password.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let held = held.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let mut n = 0;
                    while !buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut buf[n..]).await {
                            Ok(0) | Err(_) => return,
                            Ok(m) => n += m,
                        }
                    }
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let auth = head.lines().find_map(|l| l.to_ascii_lowercase().starts_with("authorization: basic ").then(|| l[21..].trim().to_string()));
                    let pair = auth.and_then(|a| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, a).ok());
                    let expected = held.lock().unwrap().as_ref().map(|p| format!("admin:{}", p.as_str()).into_bytes());
                    let ok = head.starts_with("GET /jmap/session ") && pair.is_some() && pair == expected;
                    let (status, body) = if ok {
                        ("200 OK", json!({"primaryAccounts": {"urn:stalwart:jmap": "admin-account"}}).to_string())
                    } else {
                        ("401 Unauthorized", "{}".to_string())
                    };
                    let answer =
                        format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                    let _ = sock.write_all(answer.as_bytes()).await;
                });
            }
        });
        Stalwart { port, password }
    }

    /// Started (again) on the file written for it.
    fn start_on(&self, file: &Path) {
        self.accept(&std::fs::read_to_string(file).expect("the file"));
    }

    /// Started with this administrator's password set in it by hand, as before the file.
    fn accept(&self, password: &str) {
        *self.password.lock().unwrap() = Some(Zeroizing::new(password.to_string()));
    }
}
