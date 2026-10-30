//! Helpers shared by the package: document access, tokens and signed links, settings, users,
//! attachments (platform files) and HTTP plumbing for the site.

use base64::Engine as _;
use chrono::{DateTime, SecondsFormat, Utc};
pub use ferrum_domain::util::{b, elevated, id, rows, s, sys};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, SiteRequest, SiteResponse, Tx};
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Roles that may use mail, chat and calendar through the package's endpoints.
pub const ROLES: &[&str] = &["Comms User", "Comms Manager", "Chat Admin"];

/// Attachments of one message, together.
pub const MAX_ATTACHMENTS: usize = 25 * 1024 * 1024;

pub fn now() -> DateTime<Utc> {
    Utc::now()
}

/// RFC 3339 UTC with milliseconds, the kernel's canonical date-time form.
pub fn ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_ts(v: &str) -> Option<DateTime<Utc>> {
    ferrum_kernel::value::parse_datetime(v).ok()
}

pub fn time(doc: &Doc, k: &str) -> Option<DateTime<Utc>> {
    s(doc, k).and_then(parse_ts)
}

pub fn int(doc: &Doc, k: &str) -> i64 {
    doc.get(k).and_then(Value::as_i64).unwrap_or(0)
}

pub fn doc_id(doc: &Doc) -> Result<Uuid> {
    id(doc, "id").ok_or_else(|| Error::internal("document without id"))
}

pub fn obj(v: Value) -> Doc {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Text without control characters (tabs become spaces), cut to `max` characters.
pub fn clean_line(v: &str, max: usize) -> String {
    v.chars().map(|c| if c == '\t' { ' ' } else { c }).filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// Cuts text to `max` characters.
pub fn cut(v: &str, max: usize) -> String {
    if v.chars().count() <= max { v.to_string() } else { v.chars().take(max).collect() }
}

pub fn is_member(ctx: &Ctx) -> bool {
    ctx.is_admin || ROLES.iter().any(|r| ctx.has_role(r))
}

pub fn require_member(ctx: &Ctx) -> Result<()> {
    if is_member(ctx) { Ok(()) } else { Err(Error::Forbidden("communication features need the Comms User role".into())) }
}

// ───────────────────────────── tokens and signed links ─────────────────────────────

/// 256 random bits, URL-safe.
pub fn new_token() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

/// A bearer token naming its record: `{record}.{secret}`, the secret kept in a secret field.
pub fn record_token(record: Uuid, secret: &str) -> String {
    format!("{}.{secret}", record.simple())
}

/// Checks a [`record_token`] against the record's secret field; the record on success.
pub async fn check_token(k: &Kernel, tenant: Uuid, entity: &str, field: &str, token: &str) -> Result<Option<Uuid>> {
    let Some((record, presented)) = token.split_once('.').and_then(|(r, t)| Some((Uuid::try_parse(r).ok()?, t))).filter(|(_, t)| t.len() >= 20) else {
        return Ok(None);
    };
    let mut tx = k.db.tenant_tx(tenant).await?;
    let stored = k.secret(&mut tx, tenant, entity, record, field).await?;
    tx.commit().await?;
    // Comparing digests keeps the comparison's timing independent of the secret.
    Ok(stored.filter(|s| Sha256::digest(s.as_bytes()) == Sha256::digest(presented.as_bytes())).map(|_| record))
}

/// The tenant's HMAC key for signed links, a secret field of Communication Settings created on
/// first use.
pub async fn signing_key(k: &Kernel, tenant: Uuid) -> Result<Vec<u8>> {
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    for _ in 0..2 {
        let mut tx = k.db.tenant_tx(tenant).await?;
        let settings: Option<Uuid> =
            sqlx::query_scalar("select id from e_comms_settings where tenant_id = $1 limit 1 for update").bind(tenant).fetch_optional(&mut *tx).await?;
        if let Some(id) = settings
            && let Some(key) = k.secret(&mut tx, tenant, "CommsSettings", id, "signing_key").await?
        {
            tx.commit().await?;
            return hex::decode(key).map_err(Error::internal);
        }
        let fresh = hex::encode(rand::random::<[u8; 32]>());
        let mut values = Doc::new();
        values.insert("signing_key".into(), json!(fresh));
        let written = match settings {
            Some(id) => k.update_tx(&sys, &mut tx, "CommsSettings", id, values, None).await,
            None => k.insert_tx(&sys, &mut tx, "CommsSettings", values).await,
        };
        match written {
            Ok(_) => {
                tx.commit().await?;
                return hex::decode(fresh).map_err(Error::internal);
            }
            // The settings were created at the same moment elsewhere: read theirs.
            Err(Error::Conflict(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(Error::Retryable("signing key".into()))
}

pub fn sign(key: &[u8], message: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    hex::encode(&mac.finalize().into_bytes()[..16])
}

/// Constant-time check of a signature made by [`sign`].
pub fn verify(key: &[u8], message: &str, signature: &str) -> bool {
    let Ok(sig) = hex::decode(signature.trim()) else { return false };
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.verify_truncated_left(&sig).is_ok() && sig.len() == 16
}

// ───────────────────────────── settings and users ─────────────────────────────

#[derive(Debug, Clone)]
pub struct Settings {
    pub public_url: Option<String>,
    pub hourly_limit: i64,
    pub max_attempts: i64,
}

pub async fn settings(tx: &mut Tx, tenant: Uuid) -> Result<Settings> {
    let row: Option<(Option<String>, Option<i64>, Option<i64>)> =
        sqlx::query_as("select public_url, newsletter_hourly_limit, max_send_attempts from e_comms_settings where tenant_id = $1 limit 1")
            .bind(tenant)
            .fetch_optional(&mut **tx)
            .await?;
    let (url, limit, attempts) = row.unwrap_or_default();
    Ok(Settings {
        public_url: url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()),
        hourly_limit: limit.unwrap_or(500).max(1),
        max_attempts: attempts.unwrap_or(5).clamp(1, 20),
    })
}

/// The workspace's short name, as its public addresses carry it.
pub async fn slug(tx: &mut Tx, tenant: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar("select slug from tenant where id = $1").bind(tenant).fetch_one(&mut **tx).await?)
}

/// `/api/site/{slug}/comms`, the root of the package's public endpoints.
pub async fn site_path(tx: &mut Tx, tenant: Uuid) -> Result<String> {
    Ok(format!("/api/site/{}/comms", slug(tx, tenant).await?))
}

/// Absolute public URL of `path` under the site root, when the public URL is configured.
pub async fn public_url(tx: &mut Tx, tenant: Uuid, path: &str) -> Result<(String, Option<String>)> {
    let rel = format!("{}{path}", site_path(tx, tenant).await?);
    let base = settings(tx, tenant).await?.public_url;
    Ok((rel.clone(), base.map(|b| format!("{b}{rel}"))))
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub full_name: String,
}

/// Active users with these emails.
pub async fn users(tx: &mut Tx, tenant: Uuid, emails: &[String]) -> Result<Vec<User>> {
    if emails.is_empty() {
        return Ok(vec![]);
    }
    let lower: Vec<String> = emails.iter().map(|e| e.trim().to_lowercase()).collect();
    let rows: Vec<(Uuid, String, String)> =
        sqlx::query_as("select id, email::text, full_name from app_user where tenant_id = $1 and is_active and lower(email::text) = any($2)")
            .bind(tenant)
            .bind(&lower)
            .fetch_all(&mut **tx)
            .await?;
    Ok(rows.into_iter().map(|(id, email, full_name)| User { id, email: email.to_lowercase(), full_name }).collect())
}

pub async fn user_id(tx: &mut Tx, tenant: Uuid, email: &str) -> Result<Option<Uuid>> {
    Ok(users(tx, tenant, &[email.to_string()]).await?.first().map(|u| u.id))
}

// ───────────────────────────── attachments (platform files) ─────────────────────────────

/// A file's name, type and bytes, for sending.
#[derive(Debug, Clone)]
pub struct File {
    pub file_name: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

/// A plausible `type/subtype` media type, or `application/octet-stream`.
pub fn content_type(raw: &str) -> String {
    let t = raw.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let ok = t.len() <= 100
        && t.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
        && t.chars().all(|c| c.is_ascii_alphanumeric() || "/.+-_".contains(c));
    if ok { t } else { "application/octet-stream".into() }
}

/// File ids listed in an `attachments` value (`[{id}]` or `[id]`).
pub fn attachment_ids(v: Option<&Value>) -> Vec<Uuid> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("id").and_then(Value::as_str).or(x.as_str()).and_then(|s| s.parse().ok())).collect())
        .unwrap_or_default()
}

/// Checks an `attachments` list from a user: stored files (`/api/files`) they may read — attached
/// to a record they can read, or uploaded by them and attached to nothing yet — at most 20 and
/// [`MAX_ATTACHMENTS`] bytes together. Returns the canonical list.
pub async fn check_files(k: &Kernel, tx: &mut Tx, ctx: &Ctx, v: Option<&Value>) -> Result<Value> {
    if v.is_some_and(|x| !x.is_null() && !x.is_array()) {
        return Err(Error::field("attachments", "must be a list of {id} objects"));
    }
    let ids = attachment_ids(v);
    if ids.len() > 20 {
        return Err(Error::field("attachments", "at most 20 attachments"));
    }
    if ids.is_empty() {
        return Ok(json!([]));
    }
    let rows: Vec<(Uuid, String, String, i64, Option<String>, Option<Uuid>, Option<Uuid>)> =
        sqlx::query_as("select id, file_name, content_type, size_bytes, entity, record_id, created_by from file_object where tenant_id = $1 and id = any($2)")
            .bind(ctx.tenant)
            .bind(&ids)
            .fetch_all(&mut **tx)
            .await?;
    let (mut out, mut total) = (Vec::new(), 0i64);
    for wanted in &ids {
        let readable = match rows.iter().find(|r| r.0 == *wanted) {
            Some((_, _, _, _, Some(e), Some(r), _)) => ctx.is_system || (ctx.schema.entity(e).is_some() && k.get_tx(ctx, tx, e, *r, false).await.is_ok()),
            Some((_, _, _, _, _, _, by)) => ctx.is_system || *by == Some(ctx.user),
            None => false,
        };
        let Some((id, name, ctype, size, ..)) = rows.iter().find(|r| r.0 == *wanted).filter(|_| readable) else {
            return Err(Error::field("attachments", format!("file {wanted} does not exist or you cannot read it")));
        };
        total += size;
        out.push(json!({"id": id, "file_name": name, "content_type": ctype, "size": size, "url": format!("/files/{id}")}));
    }
    if total > MAX_ATTACHMENTS as i64 {
        return Err(Error::field("attachments", format!("attachments are limited to {} MB together", MAX_ATTACHMENTS / 1024 / 1024)));
    }
    Ok(Value::Array(out))
}

/// Attaches files that belong to nothing yet to the record a message belongs to, so they list
/// with that record and follow its access rules.
pub async fn attach_files(tx: &mut Tx, tenant: Uuid, v: Option<&Value>, entity: &str, record: Uuid) -> Result<()> {
    let ids = attachment_ids(v);
    if !ids.is_empty() {
        sqlx::query("update file_object set entity = $3, record_id = $4 where tenant_id = $1 and id = any($2) and entity is null and record_id is null")
            .bind(tenant)
            .bind(&ids)
            .bind(entity)
            .bind(record)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// The files of an `attachments` list, read from the platform's file storage.
pub async fn load_files(k: &Kernel, tenant: Uuid, v: Option<&Value>) -> Result<Vec<File>> {
    let ids = attachment_ids(v);
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let (file_name, content_type, data) = k.read_file(&sys, id).await?;
        out.push(File { file_name, content_type, data });
    }
    Ok(out)
}

// ───────────────────────────── HTTP plumbing ─────────────────────────────

pub fn body_json(req: &SiteRequest) -> Result<Map<String, Value>> {
    if req.body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(Error::invalid("the request body must be a JSON object")),
        Err(e) => Err(Error::invalid(format!("invalid JSON: {e}"))),
    }
}

pub fn param<'a>(req: &'a SiteRequest, key: &str) -> Option<&'a str> {
    req.query.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

pub fn header<'a>(req: &'a SiteRequest, key: &str) -> Option<&'a str> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).and_then(|(_, v)| v.as_str())
}

pub fn ok(v: Value) -> SiteResponse {
    SiteResponse::json(200, &v)
}

pub fn created(v: Value) -> SiteResponse {
    SiteResponse::json(201, &v)
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// A small self-contained HTML page (no scripts, no external resources).
pub fn page(status: u16, title: &str, body_html: &str) -> SiteResponse {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>{t}</title><style>body{{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;\
         color:#1f2328;background:#f6f8fa;margin:0;padding:48px 16px}}main{{max-width:460px;margin:auto;background:#fff;border:1px solid #d0d7de;\
         border-radius:8px;padding:24px}}h1{{font-size:20px;margin:0 0 12px}}button{{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #1f6feb;\
         background:#1f6feb;color:#fff;cursor:pointer}}</style></head><body><main><h1>{t}</h1>{body_html}</main></body></html>",
        t = html_escape(title)
    );
    let mut r = SiteResponse::text(status, "text/html; charset=utf-8", html);
    r.headers.push(("content-security-policy".into(), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'".into()));
    r.headers.push(("cache-control".into(), "no-store".into()));
    r.headers.push(("x-frame-options".into(), "DENY".into()));
    r
}

/// Percent-encodes a query value.
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_and_tokens() {
        let key = b"0123456789abcdef0123456789abcdef";
        let sig = sign(key, "unsubscribe:n1:a@b.test");
        assert_eq!(sig.len(), 32);
        assert!(verify(key, "unsubscribe:n1:a@b.test", &sig));
        assert!(!verify(key, "unsubscribe:n1:x@b.test", &sig));
        assert!(!verify(key, "unsubscribe:n1:a@b.test", &sig[..30]));
        assert!(!verify(key, "unsubscribe:n1:a@b.test", "zz"));
        let mut tampered = sig.clone().into_bytes();
        tampered[0] = if tampered[0] == b'a' { b'b' } else { b'a' };
        assert!(!verify(key, "unsubscribe:n1:a@b.test", std::str::from_utf8(&tampered).unwrap()));
        let t = new_token();
        assert!(t.len() >= 43 && !t.contains(['/', '+', '=', '.']));
        assert_ne!(t, new_token());
        let id = Uuid::now_v7();
        assert_eq!(record_token(id, &t), format!("{}.{t}", id.simple()));
    }

    #[test]
    fn names_types_and_encoding() {
        assert_eq!(content_type("Text/Plain; charset=utf-8"), "text/plain");
        assert_eq!(content_type("<script>"), "application/octet-stream");
        assert_eq!(url_encode("a+b@c.test"), "a%2Bb%40c.test");
        assert_eq!(clean_line("Hi\u{7}\tthere\r\n", 100), "Hi there");
        assert_eq!(html_escape("<a href=\"x\">'"), "&lt;a href=&quot;x&quot;&gt;&#39;");
    }
}
