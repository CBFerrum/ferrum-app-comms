//! Email accounts. Passwords and the inbound webhook token are secret fields: sealed by the
//! platform outside the record, never returned (reads show `true` when set) and read here only
//! to talk to the mail servers. The inbound webhook URL is shown once, when it is created.

use crate::util::{self, b, id, int, s};
use async_trait::async_trait;
use ferrum_kernel::{Doc, DocHook, Error, FieldError, HookCtx, Kernel, Result, Tx};
use ferrum_meta::{EntityKind, FieldType};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Where inbound mail values come from when it creates a record.
pub const SOURCES: &[&str] = &["subject", "sender", "sender_name", "content", "text_content", "received_at", "account"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Security {
    Tls,
    StartTls,
    None,
}

#[derive(Debug, Clone)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Account {
    pub id: Uuid,
    pub name: String,
    pub address: String,
    pub display_name: Option<String>,
    pub company: Option<Uuid>,
    pub enable_outgoing: bool,
    pub smtp: Option<Server>,
    pub enable_incoming: bool,
    pub imap: Option<Server>,
    pub folder: String,
    pub signature: Option<String>,
    pub append_to: Option<String>,
    pub mapping: Option<Map<String, Value>>,
    pub last_uid: i64,
    pub uid_validity: i64,
}

impl Account {
    /// The domain of the account's address, for Message-IDs.
    pub fn domain(&self) -> &str {
        self.address.rsplit_once('@').map(|(_, d)| d).unwrap_or("ferrum.local")
    }
}

fn security(v: Option<&str>, default: Security) -> Security {
    match v {
        Some("TLS") => Security::Tls,
        Some("STARTTLS") => Security::StartTls,
        Some("None") => Security::None,
        _ => default,
    }
}

/// Loads an account with its passwords (for sending and polling only; never returned to users).
pub async fn load(k: &Kernel, tx: &mut Tx, tenant: Uuid, account: Uuid) -> Result<Option<Account>> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(a) from e_email_account a where a.tenant_id = $1 and a.id = $2")
        .bind(tenant)
        .bind(account)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(d) = row.map(util::obj) else { return Ok(None) };
    let smtp_password = k.secret(tx, tenant, "EmailAccount", account, "smtp_password").await?;
    let imap_password = k.secret(tx, tenant, "EmailAccount", account, "imap_password").await?;
    let server = |host: &str, port: &str, sec: &str, user: &str, password: Option<String>, default_port: i64, default_sec: Security| {
        s(&d, host).map(|h| Server {
            host: h.to_string(),
            port: u16::try_from(if int(&d, port) > 0 { int(&d, port) } else { default_port }).unwrap_or(25),
            security: security(s(&d, sec), default_sec),
            username: s(&d, user).map(str::to_string),
            password,
        })
    };
    Ok(Some(Account {
        id: account,
        name: s(&d, "account_name").unwrap_or_default().to_string(),
        address: s(&d, "email_address").unwrap_or_default().to_string(),
        display_name: s(&d, "display_name").map(str::to_string),
        company: id(&d, "company"),
        enable_outgoing: b(&d, "enable_outgoing"),
        smtp: server("smtp_host", "smtp_port", "smtp_security", "smtp_username", smtp_password, 587, Security::StartTls),
        enable_incoming: b(&d, "enable_incoming"),
        imap: server("imap_host", "imap_port", "imap_security", "imap_username", imap_password, 993, Security::Tls),
        folder: s(&d, "imap_folder").unwrap_or("INBOX").to_string(),
        signature: s(&d, "signature").map(str::to_string),
        append_to: s(&d, "append_to").map(str::to_string),
        mapping: d.get("append_to_mapping").and_then(Value::as_object).cloned().filter(|m| !m.is_empty()),
        last_uid: int(&d, "last_uid"),
        uid_validity: int(&d, "uid_validity"),
    }))
}

/// The default outgoing account for a company: its own default, else the shared default.
pub async fn default_outgoing(tx: &mut Tx, tenant: Uuid, company: Option<Uuid>) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "select id from e_email_account where tenant_id = $1 and enable_outgoing and default_outgoing \
         and (company = $2 or company is null) order by (company is null), created_at limit 1",
    )
    .bind(tenant)
    .bind(company)
    .fetch_optional(&mut **tx)
    .await?)
}

/// A host name or address without scheme, path or spaces.
fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:[]_".contains(c))
}

pub struct AccountHook;

#[async_trait]
impl DocHook for AccountHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        let mut err = |f: &str, m: &str| errors.push(FieldError::new(f, m));
        for host in ["smtp_host", "imap_host"] {
            if s(doc, host).is_some_and(|h| !valid_host(h)) {
                err(host, "enter a host name such as smtp.example.com (no https:// or spaces)");
            }
        }
        if b(doc, "enable_outgoing") {
            if s(doc, "smtp_host").is_none() {
                err("smtp_host", "is required for sending");
            }
            if s(doc, "smtp_username").is_some() && !b(doc, "smtp_password") {
                err("smtp_password", "set the SMTP password");
            }
        } else if b(doc, "default_outgoing") {
            err("default_outgoing", "only an account that sends can be the default");
        }
        if b(doc, "enable_incoming") {
            for f in ["imap_host", "imap_username"] {
                if s(doc, f).is_none() {
                    err(f, "is required for receiving");
                }
            }
            if !b(doc, "imap_password") {
                err("imap_password", "set the IMAP password");
            }
            if s(doc, "imap_folder").is_none() {
                err("imap_folder", "is required for receiving");
            }
        }
        if let Some(target) = s(doc, "append_to") {
            match hc.ctx.schema.entity(target) {
                Some(e) if matches!(e.def.kind, EntityKind::Master | EntityKind::Document) => {
                    if let Some(m) = doc.get("append_to_mapping").filter(|v| !v.is_null()) {
                        match m.as_object() {
                            None => err("append_to_mapping", "must be an object of target field → source"),
                            Some(m) => {
                                for (field, source) in m {
                                    if !e.field(field).is_some_and(|f| f.ftype != FieldType::Table) {
                                        err("append_to_mapping", &format!("{target} has no field {field}"));
                                    }
                                    if !source.as_str().is_some_and(|x| SOURCES.contains(&x)) {
                                        err("append_to_mapping", &format!("{source} is not a source; use one of {}", SOURCES.join(", ")));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => err("append_to", &format!("{target} is not an installed master or document entity")),
            }
        }
        if !errors.is_empty() {
            return Err(Error::Validation(errors));
        }
        if b(doc, "default_outgoing") {
            let other: Option<String> = sqlx::query_scalar(
                "select account_name from e_email_account where tenant_id = $1 and id <> $2 and default_outgoing \
                 and company is not distinct from $3 limit 1",
            )
            .bind(hc.ctx.tenant)
            .bind(util::doc_id(doc)?)
            .bind(id(doc, "company"))
            .fetch_optional(&mut **hc.tx)
            .await?;
            if let Some(name) = other {
                return Err(Error::field("default_outgoing", format!("{name} is already the default for this company; untick it first")));
            }
        }
        Ok(())
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        if name != "rotate_inbound_token" {
            return Ok(None);
        }
        let account = util::doc_id(doc)?;
        let secret = util::new_token();
        let mut patch = Doc::new();
        patch.insert("inbound_token".into(), json!(secret));
        hc.kernel.update_tx(&util::sys(hc.ctx), hc.tx, "EmailAccount", account, patch, None).await?;
        let token = util::record_token(account, &secret);
        let (path, url) = util::public_url(hc.tx, hc.ctx.tenant, &format!("/inbound/{token}")).await?;
        Ok(Some(json!({
            "token": token,
            "path": path,
            "url": url,
            "note": "POST raw MIME (message/rfc822) here. The address is shown only now; create a new one if it is lost.",
        })))
    }
}
