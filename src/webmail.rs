//! Webmail: the signed-in person's hosted mailbox (`hosted.rs`) over JMAP, through Ferrum, so the
//! web app has one origin and one session. Ferrum signs in to the mail server as the person with
//! the password it keeps sealed; the mail server decides what the account may do, and Ferrum
//! passes on only the methods of mail (`METHODS`). Messages to read come made safe (`message`).

use crate::inbound::{self, Ingested};
use crate::{hosted, site, util};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ferrum_kernel::{Ctx, Error, Kernel, Result, SiteRequest, SiteResponse};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use uuid::Uuid;

/// JMAP methods the web app may call, by prefix: mail, sending, identities, vacation replies,
/// filters (Sieve), quotas and the person's app passwords.
const METHODS: &[&str] = &[
    "Core/echo",
    "Mailbox/",
    "Thread/",
    "Email/",
    "SearchSnippet/",
    "Identity/",
    "EmailSubmission/",
    "VacationResponse/",
    "SieveScript/",
    "Quota/",
    "x:AppPassword/",
];
/// Largest attachment passed through.
const MAX_BLOB: usize = 50 * 1024 * 1024;
/// Inline (`cid:`) images embedded in a message to read, together.
const MAX_INLINE: usize = 5 * 1024 * 1024;
/// Inline styles a message may keep: layout, type and colour (nothing that loads a URL).
const STYLES: &[&str] = &[
    "color",
    "background-color",
    "font",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "text-align",
    "text-decoration",
    "text-transform",
    "text-indent",
    "line-height",
    "letter-spacing",
    "white-space",
    "vertical-align",
    "word-break",
    "overflow-wrap",
    "word-wrap",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-color",
    "border-style",
    "border-width",
    "border-collapse",
    "border-spacing",
    "border-radius",
    "width",
    "min-width",
    "max-width",
    "height",
    "min-height",
    "max-height",
    "display",
    "table-layout",
    "list-style-type",
];

/// `/api/app/comms/mail/...`
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let q = |name: &str| req.query.get(name).and_then(Value::as_str);
    match (req.method.as_str(), path) {
        ("GET", []) => Ok(util::ok(session(k, ctx).await?)),
        ("POST", ["jmap"]) => jmap(k, ctx, &req.body).await,
        ("POST", ["upload", account]) => {
            let ctype = util::header(req, "content-type").unwrap_or("application/octet-stream");
            let (_, out) = send(k, ctx, &format!("/jmap/upload/{}/", jmap_id(account)?), Some((ctype, req.body.clone())), 1 << 20).await?;
            Ok(SiteResponse { status: 201, content_type: "application/json".into(), headers: vec![], body: out })
        }
        ("GET", ["blob", account, blob]) => {
            let name = q("name").map(|n| util::clean_line(n, 200)).filter(|n| !n.is_empty()).unwrap_or_else(|| "attachment".into());
            let (ctype, data) = send(k, ctx, &download(account, blob, &name, q("type"))?, None, MAX_BLOB).await?;
            Ok(site::attachment(&name, &ctype, data))
        }
        ("GET", ["message", account, email]) => Ok(util::ok(message(k, ctx, jmap_id(account)?, jmap_id(email)?, q("images") == Some("1")).await?)),
        ("POST", ["file"]) => Ok(util::created(file(k, ctx, util::body_json(req)?).await?)),
        _ => Err(Error::NotFound("endpoint".into())),
    }
}

/// A JMAP id (`[A-Za-z0-9_-]`, RFC 8620 §1.2), so it can go into a path.
fn jmap_id(id: &str) -> Result<&str> {
    if !id.is_empty() && id.len() <= 255 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(id)
    } else {
        Err(Error::NotFound("message".into()))
    }
}

fn download(account: &str, blob: &str, name: &str, ctype: Option<&str>) -> Result<String> {
    let ctype = ctype.unwrap_or("application/octet-stream");
    Ok(format!("/jmap/download/{}/{}/{}?accept={}", jmap_id(account)?, jmap_id(blob)?, util::url_encode(name), util::url_encode(ctype)))
}

/// The signed-in person's mailbox: its record, the mail server and the person's sign-in for it
/// (none while no password is kept).
struct Mailbox {
    row: Uuid,
    url: String,
    auth: Option<String>,
}

async fn mailbox(k: &Kernel, ctx: &Ctx) -> Result<Mailbox> {
    let url = hosted::server_url().ok_or_else(|| Error::NotFound("mailbox".into()))?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let row: Option<(Uuid, String, Option<String>)> = sqlx::query_as("select id, email, status from e_hosted_mailbox where tenant_id = $1 and user_id = $2")
        .bind(ctx.tenant)
        .bind(ctx.user.to_string())
        .fetch_optional(&mut *tx)
        .await?;
    let Some((row, address, status)) = row else { return Err(Error::NotFound("mailbox".into())) };
    if status.as_deref() != Some("Active") {
        return Err(Error::Forbidden("your mailbox is locked".into()));
    }
    let secret = k.secret(&mut tx, ctx.tenant, "HostedMailbox", row, "secret").await?;
    tx.commit().await?;
    Ok(Mailbox { row, url, auth: secret.map(|s| hosted::basic(&address, &s)) })
}

/// A request to the mail server as the person: content type and body. When the server refuses
/// the kept password, a new one is set (`hosted::renew`) and the request made once more.
async fn send(k: &Kernel, ctx: &Ctx, path: &str, body: Option<(&str, Vec<u8>)>, max: usize) -> Result<(String, Vec<u8>)> {
    for attempt in 0..2 {
        let mb = mailbox(k, ctx).await?;
        if let Some(auth) = &mb.auth {
            let (status, ctype, out) = hosted::send(k, &mb.url, auth, path, body.clone(), max).await?;
            let said = || util::cut(&String::from_utf8_lossy(&out), 300);
            match status {
                200..=299 => return Ok((ctype, out)),
                401 if attempt == 0 => {}
                401 => break,
                403 => return Err(Error::Forbidden(format!("the mail server refused it: {}", said()))),
                404 => return Err(Error::NotFound("message".into())),
                400..=499 => return Err(Error::invalid(format!("the mail server refused it: {}", said()))),
                _ => return Err(Error::Unavailable(format!("the mail server answered {status}"))),
            }
        }
        if attempt == 0 {
            hosted::renew(k, ctx.tenant, mb.row).await?;
        }
    }
    Err(Error::Unavailable("your mailbox is being set up; try again in a few minutes".into()))
}

async fn send_json(k: &Kernel, ctx: &Ctx, request: &Value) -> Result<Value> {
    let (_, out) = send(k, ctx, "/jmap/", Some(("application/json", request.to_string().into_bytes())), MAX_BLOB).await?;
    serde_json::from_slice(&out).map_err(|_| Error::Unavailable("the mail server answered something else than JSON".into()))
}

/// `GET /mail`: the JMAP session (accounts, capabilities and limits) without the mail server's
/// URLs, and where mail programs connect when the operator named the server (`FERRUM_MAIL_HOST`).
async fn session(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    let (_, out) = send(k, ctx, "/jmap/session", None, 1 << 20).await?;
    let mut s: Value = serde_json::from_slice(&out).map_err(|_| Error::Unavailable("the mail server answered something else than JSON".into()))?;
    let o = s.as_object_mut().ok_or_else(|| Error::Unavailable("no session".into()))?;
    for key in ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"] {
        o.remove(key);
    }
    if let Some(host) = std::env::var("FERRUM_MAIL_HOST").ok().map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        o.insert("servers".into(), json!({"imap": format!("{host}:993"), "smtp": format!("{host}:465")}));
    }
    Ok(s)
}

/// `POST /mail/jmap`: a JMAP request of mail methods. What was checked is what is sent: the
/// request is passed on as parsed, never as received.
async fn jmap(k: &Kernel, ctx: &Ctx, body: &[u8]) -> Result<SiteResponse> {
    let request: Value = serde_json::from_slice(body).map_err(|_| Error::invalid("send a JMAP request"))?;
    let calls = request["methodCalls"].as_array().ok_or_else(|| Error::invalid("send a JMAP request (methodCalls)"))?;
    for call in calls {
        let method = call[0].as_str().unwrap_or_default();
        if !METHODS.iter().any(|m| if m.ends_with('/') { method.starts_with(m) } else { method == *m }) {
            return Err(Error::Forbidden(format!("{method} is not available here")));
        }
    }
    Ok(util::ok(send_json(k, ctx, &request).await?))
}

/// `GET /mail/message/{account}/{email}`: a message to read. Its HTML is made safe ([`sanitize`]):
/// inline images are embedded, remote ones kept only with `images` and otherwise counted
/// (`remote_images`); `text` is the plain-text body and `attachments` the files.
async fn message(k: &Kernel, ctx: &Ctx, account: &str, email: &str, images: bool) -> Result<Value> {
    let properties = [
        "id",
        "threadId",
        "mailboxIds",
        "keywords",
        "from",
        "to",
        "cc",
        "bcc",
        "replyTo",
        "subject",
        "sentAt",
        "receivedAt",
        "messageId",
        "inReplyTo",
        "references",
        "htmlBody",
        "textBody",
        "attachments",
        "bodyValues",
        "preview",
        "size",
    ];
    let got = send_json(
        k,
        ctx,
        &json!({"using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], "methodCalls": [["Email/get", {
            "accountId": account, "ids": [email], "properties": properties,
            "bodyProperties": ["partId", "blobId", "type", "name", "size", "cid", "disposition"],
            "fetchHTMLBodyValues": true, "fetchTextBodyValues": true, "maxBodyValueBytes": 4_000_000,
        }, "0"]]}),
    )
    .await?;
    let answer = &got["methodResponses"][0];
    if answer[0] == "error" {
        return Err(match answer[1]["type"].as_str() {
            Some("accountNotFound" | "forbidden" | "accountNotSupportedByMethod") => Error::NotFound("message".into()),
            _ => Error::invalid(format!("the mail server refused it: {}", answer[1])),
        });
    }
    let mut m = answer[1]["list"][0].clone();
    let Some(o) = m.as_object_mut() else { return Err(Error::NotFound("message".into())) };
    let values = o.remove("bodyValues").unwrap_or_default();
    let value = |part: &Value| values[part["partId"].as_str().unwrap_or_default()]["value"].as_str().unwrap_or_default().to_string();
    let parts = |key: &str| o.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let (html_parts, text_parts, files) = (parts("htmlBody"), parts("textBody"), parts("attachments"));
    let mut html = String::new();
    for part in &html_parts {
        match part["type"].as_str() {
            Some("text/html") => html.push_str(&value(part)),
            Some("text/plain") => html.push_str(&format!("<pre>{}</pre>", escape(&value(part)))),
            _ => {}
        }
    }
    let text = text_parts.iter().filter(|p| p["type"] == "text/plain").map(value).collect::<Vec<_>>().join("\n");
    // Images the HTML shows by Content-ID, embedded so the page needs nothing else.
    let mut inline = HashMap::new();
    let mut budget = MAX_INLINE;
    for part in html_parts.iter().chain(&files) {
        let (Some(cid), Some(blob), Some(ctype)) = (part["cid"].as_str(), part["blobId"].as_str(), part["type"].as_str()) else { continue };
        let size = part["size"].as_u64().unwrap_or(u64::MAX) as usize;
        if !matches!(ctype, "image/png" | "image/jpeg" | "image/gif" | "image/webp") || size > budget || inline.contains_key(cid) {
            continue;
        }
        let (_, data) = send(k, ctx, &download(account, blob, "inline", Some(ctype))?, None, budget).await?;
        budget -= data.len();
        inline.insert(cid.to_string(), format!("data:{ctype};base64,{}", STANDARD.encode(data)));
    }
    let (safe, remote) = sanitize(&html, &inline, images);
    let attachments: Vec<Value> = files
        .iter()
        .filter(|p| !(p["cid"].as_str().is_some_and(|c| inline.contains_key(c)) && p["disposition"] != "attachment"))
        .map(|p| json!({"blobId": p["blobId"], "name": p["name"], "type": p["type"], "size": p["size"]}))
        .collect();
    for key in ["htmlBody", "textBody", "attachments"] {
        o.remove(key);
    }
    o.insert("html".into(), json!(safe));
    o.insert("remote_images".into(), json!(remote));
    o.insert("text".into(), json!(text));
    o.insert("attachments".into(), json!(attachments));
    Ok(m)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Mail HTML made safe to show (in a sandboxed frame): ammonia's safe tags and attributes, inline
/// styles limited to [`STYLES`], links opening a new tab, `cid:` images from `inline`, remote
/// images only with `remote`. Returns the HTML and how many remote images were left out.
fn sanitize(html: &str, inline: &HashMap<String, String>, remote: bool) -> (String, usize) {
    // The filter owns what it uses.
    let (inline, left_out) = (Arc::new(inline.clone()), Arc::new(AtomicUsize::new(0)));
    let counter = left_out.clone();
    let safe = ammonia::Builder::default()
        .add_tags(["font", "center"])
        .add_generic_attributes(["style", "align", "valign", "bgcolor", "width", "height", "dir"])
        .add_tag_attributes("font", ["color", "face", "size"])
        .filter_style_properties(STYLES.iter().copied().collect::<HashSet<_>>())
        .add_url_schemes(["cid", "data"])
        .set_tag_attribute_value("a", "target", "_blank")
        .attribute_filter(move |element, attribute, value| match (element, attribute) {
            ("img", "src") => {
                if let Some(cid) = value.strip_prefix("cid:") {
                    inline.get(cid.trim_matches(['<', '>'])).map(|d| Cow::Owned(d.clone()))
                } else if value.starts_with("data:image/") {
                    Some(value.into())
                } else if remote && (value.starts_with("https://") || value.starts_with("http://")) {
                    Some(value.into())
                } else {
                    counter.fetch_add(1, Ordering::Relaxed);
                    None
                }
            }
            (_, "href" | "src" | "cite" | "action") if value.starts_with("data:") || value.starts_with("cid:") => None,
            _ => Some(value.into()),
        })
        .clean(html)
        .to_string();
    (safe, left_out.load(Ordering::Relaxed))
}

/// `POST /mail/file {account, email, entity, record}`: puts a message on a record's timeline as
/// the person's communication (Comms roles; the record must be one they can read). A message
/// already in the log moves onto the record when it is on none.
async fn file(k: &Kernel, ctx: &Ctx, body: serde_json::Map<String, Value>) -> Result<Value> {
    util::require_member(ctx)?;
    let field = |name: &str| body.get(name).and_then(Value::as_str).ok_or_else(|| Error::field(name, "required"));
    let (account, email, entity) = (jmap_id(field("account")?)?, jmap_id(field("email")?)?, field("entity")?);
    let record: Uuid = field("record")?.parse().map_err(|_| Error::field("record", "not an id"))?;
    k.get(ctx, entity, record, false).await?;
    let got = send_json(
        k,
        ctx,
        &json!({"using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
                "methodCalls": [["Email/get", {"accountId": account, "ids": [email], "properties": ["blobId"]}, "0"]]}),
    )
    .await?;
    let blob = got["methodResponses"][0][1]["list"][0]["blobId"].as_str().ok_or_else(|| Error::NotFound("message".into()))?.to_string();
    let (_, raw) = send(k, ctx, &download(account, &blob, "message.eml", Some("message/rfc822"))?, None, inbound::MAX_MESSAGE).await?;
    let me = util::elevated(ctx);
    let filed = match inbound::file(k, &me, &raw, (entity, record)).await? {
        Ingested::Created(c) => c,
        Ingested::Duplicate(c) => {
            let comm = k.get(&me, "Communication", c, false).await?;
            match (util::s(&comm, "reference_entity"), util::s(&comm, "reference_id")) {
                (Some(e), Some(r)) if e == entity && r == record.to_string() => {}
                (Some(_), Some(_)) => return Err(Error::Conflict("this message is already filed to another record".into())),
                _ => {
                    k.update(&me, "Communication", c, util::obj(json!({"reference_entity": entity, "reference_id": record.to_string()})), None).await?;
                }
            }
            c
        }
    };
    Ok(json!({"communication": filed}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_html_is_made_safe() {
        let inline = HashMap::from([("logo@x".to_string(), "data:image/png;base64,AAAA".to_string())]);
        let html = r#"<div style="color: red; background: url(https://t.example/p.gif); position: fixed" onclick="steal()">Hi
            <script>alert(1)</script><style>body{background:url(https://t.example/s)}</style>
            <img src="cid:logo@x"><img src="https://t.example/pixel.gif"><img src="cid:unknown">
            <a href="https://example.com/x">link</a><a href="javascript:alert(1)">bad</a><a href="data:text/html,x">data</a>
            <form action="https://evil.example"><input name="password"></form><iframe src="https://evil.example"></iframe></div>"#;
        let (safe, left_out) = sanitize(html, &inline, false);
        for gone in ["script", "alert", "onclick", "url(", "position", "<style", "<form", "<input", "<iframe", "javascript:", "data:text", "pixel.gif", "cid:"]
        {
            assert!(!safe.contains(gone), "{gone} in {safe}");
        }
        for kept in ["color:red", "data:image/png;base64,AAAA", "https://example.com/x", "target=\"_blank\"", "noopener"] {
            assert!(safe.replace(' ', "").contains(&kept.replace(' ', "")), "{kept} not in {safe}");
        }
        assert_eq!(left_out, 1, "the remote image (an unknown inline one is not remote)");
        let (with_images, none_left) = sanitize(html, &inline, true);
        assert!(with_images.contains("https://t.example/pixel.gif") && none_left == 0);
        assert_eq!(jmap_id("Ma1_-b").ok(), Some("Ma1_-b"));
        assert!(jmap_id("../admin").is_err() && jmap_id("").is_err() && jmap_id("a/b").is_err());
    }
}
