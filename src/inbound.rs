//! Inbound mail: MIME parsing (mail-parser), threading onto the original record, "append to"
//! records for new threads, and IMAP polling behind [`MailboxConnector`] so the poller can be
//! tested with a fake mailbox. Messages are deduplicated by Message-ID (unique per tenant), so
//! a message seen by both the poller and the webhook, or fetched twice, is stored once.

use crate::account::{self, Account, Security, Server};
use crate::util;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, notify};
use futures::StreamExt;
use mail_parser::{Address, HeaderValue, MessageParser, MimeHeaders};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use uuid::Uuid;

/// Messages imported per account and poll; a backlog drains over the following polls.
const PER_POLL: usize = 50;
/// A mailbox polled for the first time imports only its newest messages.
const FIRST_SYNC: usize = 50;
/// Larger messages are imported with their headers only (and the webhook refuses them).
pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 50;
const NET_TIMEOUT: Duration = Duration::from_secs(30);
/// Text kept per body (the kernel caps text fields at a million characters).
const MAX_BODY_CHARS: usize = 900_000;

#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    pub file_name: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedMail {
    /// Without angle brackets.
    pub message_id: Option<String>,
    pub in_reply_to: Vec<String>,
    pub references: Vec<String>,
    pub subject: String,
    pub from: Option<(Option<String>, String)>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub date: Option<DateTime<Utc>>,
    pub html: Option<String>,
    pub text: Option<String>,
    pub attachments: Vec<ParsedAttachment>,
    /// Auto-replies, bounces and bulk mail (they never create records).
    pub automatic: bool,
}

fn ids(v: &HeaderValue<'_>) -> Vec<String> {
    let clean = |s: &str| s.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string();
    match v {
        HeaderValue::Text(t) => t.split_whitespace().map(clean).filter(|x| !x.is_empty()).collect(),
        HeaderValue::TextList(l) => l.iter().map(|x| clean(x)).filter(|x| !x.is_empty()).collect(),
        _ => vec![],
    }
}

fn addresses(a: Option<&Address<'_>>) -> Vec<String> {
    a.map(|a| {
        a.iter()
            .filter_map(|x| {
                let address = x.address()?;
                Some(match x.name().filter(|n| !n.trim().is_empty()) {
                    Some(n) => format!("\"{}\" <{address}>", n.replace('"', "")),
                    None => address.to_string(),
                })
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Parses a raw RFC 5322 message.
pub fn parse_mime(raw: &[u8]) -> Result<ParsedMail> {
    let msg = MessageParser::default().parse(raw).ok_or_else(|| Error::invalid("not an email message"))?;
    if msg.from().is_none() && msg.message_id().is_none() && msg.subject().is_none() {
        return Err(Error::invalid("not an email message (no From, Message-ID or Subject)"));
    }
    let from =
        msg.from().and_then(|a| a.first()).and_then(|a| Some((a.name().map(str::to_string).filter(|n| !n.trim().is_empty()), a.address()?.to_lowercase())));
    let html = msg.html_part(0).filter(|p| p.is_text_html()).and_then(|p| p.text_contents()).map(str::to_string);
    let text = msg.text_part(0).filter(|p| !p.is_text_html()).and_then(|p| p.text_contents()).map(str::to_string);
    let mut attachments = Vec::new();
    for (i, part) in msg.attachments().enumerate().take(MAX_ATTACHMENTS) {
        let content_type = part
            .content_type()
            .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("octet-stream")))
            .unwrap_or_else(|| "application/octet-stream".into());
        let name = part.attachment_name().map(str::to_string).unwrap_or_else(|| {
            let ext = if part.is_message() { "eml" } else { "bin" };
            format!("attachment-{}.{ext}", i + 1)
        });
        attachments.push(ParsedAttachment { file_name: name, content_type, data: part.contents().to_vec() });
    }
    let raw_header = |name: &str| msg.header_raw(name).map(|v| v.trim().to_ascii_lowercase());
    let sender_is_system = from.as_ref().is_some_and(|(_, a)| a.starts_with("mailer-daemon@") || a.starts_with("postmaster@") || a.starts_with("noreply@"));
    let automatic = raw_header("Auto-Submitted").is_some_and(|v| v != "no")
        || raw_header("Precedence").is_some_and(|v| matches!(v.as_str(), "bulk" | "junk" | "list" | "auto_reply"))
        || msg.header_raw("X-Autoreply").is_some()
        || msg.header_raw("X-Autorespond").is_some()
        || sender_is_system;
    Ok(ParsedMail {
        message_id: msg.message_id().map(|m| m.trim().trim_start_matches('<').trim_end_matches('>').to_string()).filter(|m| !m.is_empty()),
        in_reply_to: ids(msg.in_reply_to()),
        references: ids(msg.references()),
        subject: util::clean_line(msg.subject().unwrap_or_default(), 990),
        from,
        to: addresses(msg.to()),
        cc: addresses(msg.cc()),
        date: msg.date().and_then(|d| DateTime::from_timestamp(d.to_timestamp(), 0)),
        html,
        text,
        attachments,
        automatic,
    })
}

/// The raw message of a provider's inbound webhook: the body itself, or the `body-mime`
/// (Mailgun), `email` (SendGrid) or `raw` field of a multipart form.
pub fn webhook_payload<'a>(content_type: Option<&str>, body: &'a [u8]) -> Result<std::borrow::Cow<'a, [u8]>> {
    let Some(ct) = content_type.filter(|c| c.to_ascii_lowercase().starts_with("multipart/form-data")) else {
        return Ok(std::borrow::Cow::Borrowed(body));
    };
    // A form is MIME too: parse it as a message with that content type.
    let mut wrapped = format!("Content-Type: {ct}\r\nMIME-Version: 1.0\r\n\r\n").into_bytes();
    wrapped.extend_from_slice(body);
    let msg = MessageParser::default().parse(&wrapped).ok_or_else(|| Error::invalid("unreadable form"))?;
    for part in msg.parts.iter() {
        let name = part.content_disposition().and_then(|d| d.attribute("name")).unwrap_or_default();
        if matches!(name, "body-mime" | "email" | "raw" | "message") {
            return Ok(std::borrow::Cow::Owned(part.contents().to_vec()));
        }
    }
    Err(Error::invalid("the form has no raw message field (body-mime, email or raw)"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ingested {
    Created(Uuid),
    Duplicate(Uuid),
}

/// The value of an "append to" source.
fn source_value(source: &str, mail: &ParsedMail, account: &Account, text: &str) -> Value {
    match source {
        "subject" => json!(if mail.subject.is_empty() { "(no subject)" } else { mail.subject.as_str() }),
        "sender" => json!(mail.from.as_ref().map(|f| f.1.clone())),
        "sender_name" => json!(mail.from.as_ref().map(|f| f.0.clone().unwrap_or_else(|| f.1.clone()))),
        "content" => json!(mail.html.clone().unwrap_or_else(|| text.to_string())),
        "text_content" => json!(text),
        "received_at" => json!(util::ts(mail.date.unwrap_or_else(util::now))),
        "account" => json!(account.name),
        _ => Value::Null,
    }
}

/// Without an explicit mapping, fill the usual field names.
const DEFAULT_MAPPING: &[(&[&str], &str)] = &[
    (&["subject", "title"], "subject"),
    (&["raised_by", "email", "email_id", "email_address", "contact_email", "customer_email"], "sender"),
    (&["lead_name", "contact_name", "customer_name", "full_name", "first_name", "person_name"], "sender_name"),
    (&["description", "details", "content", "message", "notes"], "text_content"),
];

/// Creates the "append to" record for a new thread; returns its id.
async fn create_record(k: &Kernel, ctx: &Ctx, tx: &mut ferrum_kernel::Tx, account: &Account, mail: &ParsedMail, text: &str) -> Result<(String, Uuid)> {
    let entity = account.append_to.clone().unwrap_or_default();
    let ent = k.entity(ctx, &entity)?;
    let mut doc = Doc::new();
    match &account.mapping {
        Some(m) => {
            for (field, source) in m {
                doc.insert(field.clone(), source_value(source.as_str().unwrap_or_default(), mail, account, text));
            }
        }
        None => {
            for (fields, source) in DEFAULT_MAPPING {
                if let Some(f) = fields.iter().find(|f| ent.field(f).is_some()) {
                    doc.insert(f.to_string(), source_value(source, mail, account, text));
                }
            }
        }
    }
    if let (Some(c), Some(f)) = (account.company, ent.field("company"))
        && f.to.as_deref() == Some("Company")
        && !doc.contains_key("company")
    {
        doc.insert("company".into(), json!(c));
    }
    // Keep values inside each field's limits so a long subject never loses the mail.
    for (k, v) in doc.iter_mut() {
        if let (Some(f), Value::String(t)) = (ent.field(k), &*v) {
            let long = matches!(f.ftype, ferrum_meta::FieldType::Text | ferrum_meta::FieldType::Markdown | ferrum_meta::FieldType::Code);
            let max = f.max_length.map(|m| m as usize).unwrap_or(if long { MAX_BODY_CHARS } else { 1000 });
            *v = json!(util::cut(t, max));
        }
    }
    let created = k.insert_tx(ctx, tx, &entity, doc).await?;
    Ok((entity, util::doc_id(&created)?))
}

/// Stores one received message (deduplicated by Message-ID), threaded onto the record of the
/// message it answers; a new thread creates the account's "append to" record.
pub async fn ingest(k: &Kernel, tenant: Uuid, account: &Account, raw: &[u8], truncated: bool) -> Result<Ingested> {
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    store(k, &ctx, raw, truncated, Some(account), None).await
}

/// Files a message from a person's hosted mailbox onto `record` (entity, id), deduplicated by
/// Message-ID like received mail: Sent when it is from them, Received otherwise. `ctx` is the
/// person with engine privileges (`util::elevated`), so the communication is theirs.
pub async fn file(k: &Kernel, ctx: &Ctx, raw: &[u8], record: (&str, Uuid)) -> Result<Ingested> {
    store(k, ctx, raw, false, None, Some(record)).await
}

async fn store(k: &Kernel, ctx: &Ctx, raw: &[u8], truncated: bool, account: Option<&Account>, record: Option<(&str, Uuid)>) -> Result<Ingested> {
    let tenant = ctx.tenant;
    let mail = parse_mime(raw)?;
    let digest = hex::encode(Sha256::digest(raw));
    let message_id = match mail.message_id.as_deref() {
        Some(m) if m.len() <= 500 => util::clean_line(m, 500),
        Some(m) => format!("{}@long-message-id.invalid", &hex::encode(Sha256::digest(m.as_bytes()))[..32]),
        None => format!("{}@missing-message-id.invalid", &digest[..32]),
    };
    let mut tx = k.db.tenant_tx(tenant).await?;
    let existing: Option<Uuid> = sqlx::query_scalar("select id from e_communication where tenant_id = $1 and message_id = $2")
        .bind(tenant)
        .bind(&message_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(e) = existing {
        return Ok(Ingested::Duplicate(e));
    }
    tx.commit().await?;
    // Attachments go to the platform's file storage first: if it is unavailable the message is
    // not stored either and comes again (the poller does not move on, providers retry webhooks).
    // The communication's hook then attaches them to its record.
    let mut attachments = Vec::new();
    for a in mail.attachments.iter().filter(|a| a.data.len() <= util::MAX_ATTACHMENTS) {
        let ctype = util::content_type(&a.content_type);
        let mut stored = k.store_file(ctx, None, &a.file_name, &ctype, &a.data).await?;
        stored["content_type"] = json!(ctype);
        attachments.push(stored);
    }
    // Stored attachments belong to the message: unless it is created, they leave storage again.
    let stored: Vec<Uuid> = attachments.iter().filter_map(|a| a.get("id")?.as_str()?.parse().ok()).collect();
    let outcome: Result<Ingested> = async {
        let mut tx = k.db.tenant_tx(tenant).await?;
        let mut parents: Vec<String> = mail.in_reply_to.clone();
        parents.extend(mail.references.iter().rev().cloned());
        let parent: Option<(Option<String>, Option<String>, Option<String>, Option<Uuid>)> = sqlx::query_as(
            "select reference_entity, reference_id, thread_key, created_by from e_communication \
             where tenant_id = $1 and message_id = any($2) order by communication_date desc limit 1",
        )
        .bind(tenant)
        .bind(&parents)
        .fetch_optional(&mut *tx)
        .await?;
        let text = mail.text.clone().unwrap_or_else(|| mail.html.as_deref().map(mail_parser::decoders::html::html_to_text).unwrap_or_default());
        let text = util::cut(&text, MAX_BODY_CHARS);
        let (mut reference, thread_key) = match &parent {
            Some((e, r, t, _)) => (e.clone().zip(r.clone()), t.clone().unwrap_or_else(|| message_id.clone())),
            None => (None, message_id.clone()),
        };
        if let Some((e, r)) = record {
            reference = Some((e.to_string(), r.to_string()));
        }
        if parent.is_none()
            && let Some(account) = account.filter(|a| a.append_to.is_some())
            && !mail.automatic
        {
            sqlx::query("savepoint append_to").execute(&mut *tx).await?;
            match create_record(k, ctx, &mut tx, account, &mail, &text).await {
                Ok((e, r)) => reference = Some((e, r.to_string())),
                Err(err) => {
                    sqlx::query("rollback to savepoint append_to").execute(&mut *tx).await?;
                    tracing::warn!(%tenant, account = %account.name, "inbound mail could not create a {}: {err}", account.append_to.as_deref().unwrap_or_default());
                }
            }
        }
        let comm = Uuid::now_v7();
        let (html, text) = if truncated {
            let note = format!("(This message was larger than {} MB; only its headers were imported.)", MAX_MESSAGE / 1024 / 1024);
            (None, note)
        } else {
            (mail.html.as_deref().map(|h| util::cut(h, MAX_BODY_CHARS)), text)
        };
        let sender = mail.from.as_ref().map(|f| util::cut(&f.1, 320));
        // A filed message the person sent themselves.
        let sent = record.is_some() && sender.as_deref() == Some(ctx.email.to_lowercase().as_str());
        let direction = if sent { "Sent" } else { "Received" };
        let doc = json!({
            "id": comm,
            "channel": "Email",
            "direction": direction,
            "status": direction,
            "subject": if mail.subject.is_empty() { None } else { Some(&mail.subject) },
            "communication_date": util::ts(mail.date.filter(|d| *d <= util::now() + chrono::Duration::days(1)).unwrap_or_else(util::now)),
            "email_account": account.map(|a| a.id),
            "sender": sender,
            "sender_name": mail.from.as_ref().and_then(|f| f.0.as_deref()).map(|n| util::clean_line(n, 200)),
            "recipients": util::cut(&mail.to.join(", "), 100_000),
            "cc": util::cut(&mail.cc.join(", "), 100_000),
            "content": html.unwrap_or_else(|| mail_parser::decoders::html::text_to_html(&text)),
            "text_content": text,
            "attachments": attachments,
            "reference_entity": reference.as_ref().map(|r| r.0.clone()),
            "reference_id": reference.as_ref().map(|r| r.1.clone()),
            "message_id": message_id,
            "in_reply_to": mail.in_reply_to.first().map(|m| util::cut(m, 500)),
            "mail_references": util::cut(&mail.references.join(" "), 50_000),
            "thread_key": util::cut(&thread_key, 500),
            "seen": record.is_some(),
        });
        match k.insert_tx(ctx, &mut tx, "Communication", util::obj(doc)).await {
            Ok(_) => {}
            // The same message arrived through another path a moment ago.
            Err(Error::Conflict(_)) => {
                tx.rollback().await?;
                let mut tx = k.db.tenant_tx(tenant).await?;
                let e: Uuid = sqlx::query_scalar("select id from e_communication where tenant_id = $1 and message_id = $2")
                    .bind(tenant)
                    .bind(&message_id)
                    .fetch_one(&mut *tx)
                    .await?;
                tx.commit().await?;
                return Ok(Ingested::Duplicate(e));
            }
            Err(e) => return Err(e),
        }
        if let Some((_, _, _, Some(user))) = &parent
            && !sent
            && *user != ctx.user
        {
            let who = mail.from.as_ref().map(|f| f.0.clone().unwrap_or_else(|| f.1.clone())).unwrap_or_default();
            let title = util::cut(&format!("Reply from {who}: {}", mail.subject), 200);
            notify::send_kind(&mut tx, tenant, *user, "comms.reply", "inapp", &title, Some(&util::cut(&text, 300)), Some("Communication"), Some(comm)).await?;
        }
        tx.commit().await?;
        Ok(Ingested::Created(comm))
    }
    .await;
    if !matches!(outcome, Ok(Ingested::Created(_))) {
        for id in stored {
            if let Err(e) = k.remove_file(ctx, id).await {
                tracing::warn!(%tenant, file = %id, "inbound mail: could not remove an unused attachment: {e}");
            }
        }
    }
    outcome
}

// ───────────────────────────── IMAP polling ─────────────────────────────

/// An opened, logged-in mailbox.
#[async_trait]
pub trait Mailbox: Send {
    /// Selects `folder` and returns its UIDVALIDITY.
    async fn select(&mut self, folder: &str) -> Result<u32>;
    /// UIDs greater than `after`, ascending.
    async fn uids_after(&mut self, after: u32) -> Result<Vec<u32>>;
    /// The raw message, or only its header (`true`) when it is larger than `max_bytes`;
    /// `None` when it disappeared meanwhile.
    async fn fetch(&mut self, uid: u32, max_bytes: usize) -> Result<Option<(Vec<u8>, bool)>>;
    async fn logout(&mut self);
}

/// Opens mailboxes; the IMAP implementation is [`ImapConnector`].
#[async_trait]
pub trait MailboxConnector: Send + Sync {
    async fn connect(&self, account: &Account) -> Result<Box<dyn Mailbox>>;
}

fn imap_err(e: impl std::fmt::Display) -> Error {
    Error::Unavailable(format!("IMAP: {e}"))
}

async fn timed<T>(f: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(NET_TIMEOUT, f).await.map_err(|_| Error::Unavailable("IMAP: the server did not answer in time".into()))?
}

fn tls() -> Result<tokio_rustls::TlsConnector> {
    let provider = rustls::crypto::CryptoProvider::get_default().cloned().unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(imap_err)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}

/// One `UID FETCH`: (RFC822.SIZE, body, header) of the message with that UID.
async fn fetch_one<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug + Send>(
    session: &mut async_imap::Session<T>,
    uid: u32,
    query: &str,
) -> Result<Option<(Option<u32>, Option<Vec<u8>>, Option<Vec<u8>>)>> {
    let mut stream = session.uid_fetch(uid.to_string(), query).await.map_err(imap_err)?;
    let mut found = None;
    while let Some(item) = stream.next().await {
        let f = item.map_err(imap_err)?;
        if f.uid == Some(uid) {
            found = Some((f.size, f.body().map(<[u8]>::to_vec), f.header().map(<[u8]>::to_vec)));
        }
    }
    Ok(found)
}

struct ImapMailbox<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug + Send> {
    session: async_imap::Session<T>,
}

#[async_trait]
impl<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug + Send + Sync + 'static> Mailbox for ImapMailbox<T> {
    async fn select(&mut self, folder: &str) -> Result<u32> {
        let mb = timed(async { self.session.select(folder).await.map_err(imap_err) }).await?;
        Ok(mb.uid_validity.unwrap_or(0))
    }

    async fn uids_after(&mut self, after: u32) -> Result<Vec<u32>> {
        let set = timed(async { self.session.uid_search(format!("UID {}:*", after.saturating_add(1))).await.map_err(imap_err) }).await?;
        let mut uids: Vec<u32> = set.into_iter().filter(|u| *u > after).collect();
        uids.sort_unstable();
        Ok(uids)
    }

    async fn fetch(&mut self, uid: u32, max_bytes: usize) -> Result<Option<(Vec<u8>, bool)>> {
        let Some((size, _, _)) = timed(fetch_one(&mut self.session, uid, "(UID RFC822.SIZE)")).await? else { return Ok(None) };
        if size.is_some_and(|s| s as usize > max_bytes) {
            let header = timed(fetch_one(&mut self.session, uid, "(UID BODY.PEEK[HEADER])")).await?.and_then(|f| f.2);
            return Ok(header.map(|h| (h, true)));
        }
        Ok(timed(fetch_one(&mut self.session, uid, "(UID BODY.PEEK[])")).await?.and_then(|f| f.1).map(|b| (b, false)))
    }

    async fn logout(&mut self) {
        let _ = timed(async { self.session.logout().await.map_err(imap_err) }).await;
    }
}

async fn login<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug + Send + Sync + 'static>(
    client: async_imap::Client<T>,
    server: &Server,
) -> Result<Box<dyn Mailbox>> {
    let user = server.username.clone().unwrap_or_default();
    let password = server.password.clone().unwrap_or_default();
    let session = timed(async { client.login(user, password).await.map_err(|(e, _)| imap_err(e)) }).await?;
    Ok(Box::new(ImapMailbox { session }))
}

async fn greeting<T: AsyncRead + AsyncWrite + Unpin + std::fmt::Debug + Send>(client: &mut async_imap::Client<T>) -> Result<()> {
    timed(async { client.read_response().await.map_err(imap_err)?.ok_or_else(|| imap_err("connection closed before the greeting")).map(|_| ()) }).await
}

/// Real IMAP over TLS, STARTTLS or plain TCP.
pub struct ImapConnector;

#[async_trait]
impl MailboxConnector for ImapConnector {
    async fn connect(&self, account: &Account) -> Result<Box<dyn Mailbox>> {
        let server = account.imap.as_ref().ok_or_else(|| Error::invalid("the account has no IMAP host"))?;
        let tcp = timed(async { tokio::net::TcpStream::connect((server.host.as_str(), server.port)).await.map_err(imap_err) }).await?;
        let name = || rustls::pki_types::ServerName::try_from(server.host.clone()).map_err(imap_err);
        match server.security {
            Security::Tls => {
                let stream = timed(async { tls()?.connect(name()?, tcp).await.map_err(imap_err) }).await?;
                let mut client = async_imap::Client::new(stream);
                greeting(&mut client).await?;
                login(client, server).await
            }
            Security::StartTls => {
                let mut client = async_imap::Client::new(tcp);
                greeting(&mut client).await?;
                timed(async { client.run_command_and_check_ok("STARTTLS", None).await.map_err(imap_err) }).await?;
                let stream = timed(async { tls()?.connect(name()?, client.into_inner()).await.map_err(imap_err) }).await?;
                login(async_imap::Client::new(stream), server).await
            }
            Security::None => {
                let mut client = async_imap::Client::new(tcp);
                greeting(&mut client).await?;
                login(client, server).await
            }
        }
    }
}

/// Polls one account: new UIDs since the last poll (the first poll takes the newest
/// [`FIRST_SYNC`]), at most [`PER_POLL`] per run. Returns how many messages were stored.
pub async fn poll_account(k: &Kernel, tenant: Uuid, account_id: Uuid, connector: &dyn MailboxConnector) -> Result<usize> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let account = account::load(k, &mut tx, tenant, account_id).await?.ok_or_else(|| Error::NotFound("Email Account".into()))?;
    // Marked first: a failing mailbox waits for its interval instead of being retried each minute.
    sqlx::query("update e_email_account set last_polled_at = now() where tenant_id = $1 and id = $2").bind(tenant).bind(account_id).execute(&mut *tx).await?;
    tx.commit().await?;
    let save = |last_uid: u32, validity: u32| async move {
        let mut tx = k.db.tenant_tx(tenant).await?;
        sqlx::query("update e_email_account set last_uid = $3, uid_validity = $4 where tenant_id = $1 and id = $2")
            .bind(tenant)
            .bind(account_id)
            .bind(last_uid as i64)
            .bind(validity as i64)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<_, Error>(())
    };
    let run = async {
        let mut mailbox = connector.connect(&account).await?;
        let result = async {
            let validity = mailbox.select(&account.folder).await?;
            // A new UIDVALIDITY renumbers the folder: start over (Message-IDs prevent duplicates).
            let mut last = if validity as i64 == account.uid_validity { u32::try_from(account.last_uid).unwrap_or(0) } else { 0 };
            let mut uids = mailbox.uids_after(last).await?;
            if last == 0 && uids.len() > FIRST_SYNC {
                uids = uids.split_off(uids.len() - FIRST_SYNC);
            }
            uids.truncate(PER_POLL);
            let mut stored = 0;
            for uid in uids {
                if let Some((raw, truncated)) = mailbox.fetch(uid, MAX_MESSAGE).await? {
                    match ingest(k, tenant, &account, &raw, truncated).await {
                        Ok(Ingested::Created(_)) => stored += 1,
                        Ok(Ingested::Duplicate(_)) => {}
                        // Unreadable messages are skipped; anything else stops here to retry later.
                        Err(Error::Invalid(m)) => tracing::warn!(%tenant, account = %account.name, uid, "skipped an unreadable message: {m}"),
                        Err(e) => return Err(e),
                    }
                }
                last = uid;
                save(last, validity).await?;
            }
            if validity as i64 != account.uid_validity {
                save(last, validity).await?;
            }
            Ok::<_, Error>(stored)
        }
        .await;
        mailbox.logout().await;
        result
    };
    let outcome = run.await;
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query("update e_email_account set last_poll_error = $3 where tenant_id = $1 and id = $2")
        .bind(tenant)
        .bind(account_id)
        .bind(outcome.as_ref().err().map(|e| util::cut(&e.to_string(), 1000)))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    outcome
}

/// Polls the tenant's accounts whose interval has passed, within `budget`.
pub async fn poll_due(k: &Kernel, tenant: Uuid, connector: &dyn MailboxConnector, budget: Duration) -> Result<usize> {
    let started = Instant::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_email_account where tenant_id = $1 and enable_incoming \
         and (last_polled_at is null or last_polled_at + make_interval(mins => greatest(coalesce(poll_interval_minutes, 5), 1)::int) <= now() + interval '5 seconds') \
         order by last_polled_at nulls first limit 20",
    )
    .bind(tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut stored = 0;
    for account in due {
        if started.elapsed() > budget {
            break;
        }
        match poll_account(k, tenant, account, connector).await {
            Ok(n) => stored += n,
            Err(e) => tracing::warn!(%tenant, %account, "mail polling failed: {e}"),
        }
    }
    Ok(stored)
}

/// `POST /inbound/{token}` (public): a provider forwards one raw message.
pub async fn webhook(k: &Kernel, tenant: Uuid, token: &str, content_type: Option<&str>, body: &[u8]) -> Result<Value> {
    let account_id = util::check_token(k, tenant, "EmailAccount", "inbound_token", token).await?.ok_or_else(|| Error::NotFound("inbound address".into()))?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let account = account::load(k, &mut tx, tenant, account_id).await?.ok_or_else(|| Error::NotFound("inbound address".into()))?;
    tx.commit().await?;
    if body.is_empty() || body.len() > MAX_MESSAGE {
        return Err(Error::invalid(format!("the request body must be the raw message, at most {} MB", MAX_MESSAGE / 1024 / 1024)));
    }
    let raw = webhook_payload(content_type, body)?;
    Ok(match ingest(k, tenant, &account, &raw, false).await? {
        Ingested::Created(id) => json!({"status": "created", "id": id}),
        Ingested::Duplicate(id) => json!({"status": "duplicate", "id": id}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALTERNATIVE: &str = "From: \"=?UTF-8?Q?Jos=C3=A9_P=C3=A9rez?=\" <jose@cliente.test>\r\n\
To: Sales <sales@acme.test>, \"Rao, Priya\" <priya@acme.test>\r\n\
Cc: boss@cliente.test\r\n\
Subject: =?UTF-8?B?UmU6IENvdGl6YWNpw7NuIDIwMjY=?=\r\n\
Date: Thu, 29 Oct 2026 10:15:00 +0530\r\n\
Message-ID: <CAF=reply.123@mail.cliente.test>\r\n\
In-Reply-To: <0192d3b1abc@acme.test>\r\n\
References: <root.1@acme.test>\r\n <0192d3b1abc@acme.test>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
\r\n\
--outer\r\n\
Content-Type: multipart/alternative; boundary=\"inner\"\r\n\
\r\n\
--inner\r\n\
Content-Type: text/plain; charset=\"iso-8859-1\"\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
Gracias, la cotizaci=F3n est=E1 bien.\r\n\
--inner\r\n\
Content-Type: text/html; charset=\"utf-8\"\r\n\
\r\n\
<p>Gracias, la cotización está bien.</p><script>alert(1)</script>\r\n\
--inner--\r\n\
--outer\r\n\
Content-Type: application/pdf; name=\"=?UTF-8?Q?pedido_n=C2=BA7.pdf?=\"\r\n\
Content-Disposition: attachment; filename=\"=?UTF-8?Q?pedido_n=C2=BA7.pdf?=\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQKJcfsj6IK\r\n\
--outer--\r\n";

    #[test]
    fn parses_multipart_alternative_with_encoded_headers_and_attachments() {
        let m = parse_mime(ALTERNATIVE.as_bytes()).unwrap();
        assert_eq!(m.from, Some((Some("José Pérez".into()), "jose@cliente.test".into())));
        assert_eq!(m.subject, "Re: Cotización 2026");
        assert_eq!(m.message_id.as_deref(), Some("CAF=reply.123@mail.cliente.test"));
        assert_eq!(m.in_reply_to, vec!["0192d3b1abc@acme.test".to_string()]);
        assert_eq!(m.references, vec!["root.1@acme.test".to_string(), "0192d3b1abc@acme.test".to_string()]);
        assert_eq!(m.to, vec!["\"Sales\" <sales@acme.test>".to_string(), "\"Rao, Priya\" <priya@acme.test>".to_string()]);
        assert_eq!(m.cc, vec!["boss@cliente.test".to_string()]);
        assert_eq!(m.text.as_deref().map(str::trim), Some("Gracias, la cotización está bien."));
        assert!(m.html.as_deref().unwrap().contains("<p>Gracias, la cotización está bien.</p>"));
        assert_eq!(m.date.unwrap().to_rfc3339(), "2026-10-29T04:45:00+00:00");
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.attachments[0].file_name, "pedido nº7.pdf");
        assert_eq!(m.attachments[0].content_type, "application/pdf");
        assert!(m.attachments[0].data.starts_with(b"%PDF-1.4"));
        assert!(!m.automatic);
    }

    #[test]
    fn plain_text_auto_replies_and_garbage() {
        let raw = "From: robot@vendor.test\r\nTo: sales@acme.test\r\nSubject: Out of office\r\nAuto-Submitted: auto-replied\r\n\r\nI am away.\r\n";
        let m = parse_mime(raw.as_bytes()).unwrap();
        assert!(m.automatic);
        assert_eq!(m.html, None);
        assert_eq!(m.text.as_deref().map(str::trim), Some("I am away."));
        assert!(m.message_id.is_none());
        let bounce = "From: MAILER-DAEMON@mx.test\r\nSubject: Undelivered Mail\r\n\r\nx\r\n";
        assert!(parse_mime(bounce.as_bytes()).unwrap().automatic);
        assert!(parse_mime(b"").is_err());
        assert!(parse_mime(b"just some text without headers").is_err());
    }

    #[test]
    fn provider_forms_carry_the_raw_message() {
        let body = "--b1\r\nContent-Disposition: form-data; name=\"recipient\"\r\n\r\nsales@acme.test\r\n\
--b1\r\nContent-Disposition: form-data; name=\"body-mime\"\r\n\r\nFrom: a@b.test\r\nSubject: Hi\r\n\r\nHello\r\n--b1--\r\n";
        let raw = webhook_payload(Some("multipart/form-data; boundary=b1"), body.as_bytes()).unwrap();
        let m = parse_mime(&raw).unwrap();
        assert_eq!(m.subject, "Hi");
        assert_eq!(webhook_payload(Some("message/rfc822"), b"x").unwrap().as_ref(), b"x");
        assert!(
            webhook_payload(Some("multipart/form-data; boundary=b1"), b"--b1\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\ny\r\n--b1--\r\n").is_err()
        );
    }
}
