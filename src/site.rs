//! The package's HTTP endpoints: `/api/app/comms/...` for signed-in users (Comms roles; webmail
//! for whoever has a hosted mailbox) and `/api/site/{tenant}/comms/...` for the public (inbound
//! mail webhook, calendar feeds — each authenticated by an unguessable or signed token). See README.md.

use crate::util::{self, created, ok};
use crate::{calendar, chat, dav, dns, hosted, inbound, mail, mailadmin, meet, webmail};
use async_trait::async_trait;
use ferrum_kernel::{Access, Action, Ctx, Error, Kernel, Result, Site, SiteRequest, SiteResponse};
use serde_json::{Value, json};
use uuid::Uuid;

/// Media types a browser could execute; served as downloads of unknown type.
const ACTIVE_TYPES: &[&str] =
    &["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript", "text/xml", "application/xml"];

/// What anyone with a link sends: an answer to an invitation, a guest's name for a meeting.
const PUBLIC_BODY: usize = 16 << 10;
/// Webmail's own calls carry a message's text, twice (its HTML and the plain text made from it), and a reply's or
/// forward's quoted original, which the composer reads up to 4,000,000 bytes (`maxBodyValueBytes`,
/// ui/src/MailCompose.tsx): 2 × 4 MB, doubled for JSON's escaping. Pictures and files go up first (`mail/upload`).
const JMAP_BODY: usize = 16 << 20;

pub struct CommsSite;

#[async_trait]
impl Site for CommsSite {
    /// JSON: an event's notes or a message's text at most.
    fn max_body(&self) -> usize {
        1 << 20
    }

    /// A whole message or file only where one comes (the raw message a provider forwards, a file for a hosted mail
    /// message, a calendar file to import), and less still from anyone with a link.
    fn max_body_for(&self, method: &str, path: &str) -> usize {
        let p: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        match (method, p.as_slice()) {
            ("POST", ["inbound", _] | ["mail", "upload", _] | ["calendar", "import"]) => inbound::MAX_MESSAGE,
            ("POST", ["mail", "jmap"]) => JMAP_BODY,
            (_, ["rsvp"] | ["meet", "guest"] | ["chat", "hook", _]) => PUBLIC_BODY,
            _ => self.max_body(),
        }
    }

    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let path: Vec<&str> = req.path.split('/').filter(|p| !p.is_empty()).collect();
        match &req.user {
            None => public(k, &req, &path).await,
            Some(ctx) => {
                if let ["mail", rest @ ..] = path.as_slice() {
                    return webmail::handle(k, ctx, &req, rest).await;
                }
                util::require_member(ctx)?;
                app(k, ctx, &req, &path).await
            }
        }
    }
}

async fn public(k: &Kernel, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    match (req.method.as_str(), path) {
        ("POST", ["inbound", token]) => {
            Ok(SiteResponse::json(202, &inbound::webhook(k, req.tenant, token, util::header(req, "content-type"), &req.body).await?))
        }
        ("POST", ["meet", "guest"]) => meet::guest(k, req).await,
        ("POST", ["chat", "hook", token]) => chat::webhook_post(k, req.tenant, token, &req.body).await,
        ("GET", ["rsvp"]) => Ok(ok(calendar::answer_info(k, req.tenant, util::param(req, "token").unwrap_or_default()).await?)),
        ("POST", ["rsvp"]) => Ok(ok(calendar::answer(k, req.tenant, &req.client_ip, &util::body_json(req)?).await?)),
        ("GET", ["calendar", file]) => match file.strip_suffix(".ics") {
            Some(token) => calendar::feed(k, req.tenant, token).await,
            None => Err(Error::NotFound("calendar".into())),
        },
        _ => Err(Error::NotFound("page".into())),
    }
}

fn uuid(seg: &str) -> Result<Uuid> {
    seg.parse().map_err(|_| Error::NotFound("record".into()))
}

async fn app(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let body = || util::body_json(req);
    Ok(match (req.method.as_str(), path) {
        (_, ["chat", rest @ ..]) => return chat::handle(k, ctx, req, rest).await,
        (_, ["calendar", rest @ ..]) => return calendar::handle(k, ctx, req, rest).await,
        (_, ["meet", rest @ ..]) => return meet::handle(k, ctx, req, rest).await,
        (_, ["dav", rest @ ..]) => return dav::handle(k, ctx, req, rest).await,
        ("GET", ["domain"]) => ok(dns::health(k, ctx).await?),
        ("GET", ["domain", "mailboxes"]) => ok(hosted::usage(k, ctx).await?),
        ("PUT", ["domain", "mailboxes", account, "quota"]) => ok(mailadmin::set_quota(k, ctx, account, &body()?).await?),
        ("GET", ["domain", "spam"]) => ok(mailadmin::spam(k, ctx).await?),
        ("GET", ["domain", "retention"]) => ok(mailadmin::retention(k, ctx).await?),
        ("GET", ["domain", "senders"]) => ok(mailadmin::senders(k, ctx).await?),
        ("POST", ["domain", "senders"]) => created(mailadmin::add_sender(k, ctx, &body()?).await?),
        ("DELETE", ["domain", "senders", who]) => ok(mailadmin::remove_sender(k, ctx, who).await?),
        ("GET", ["accounts"]) => ok(mail::accounts(k, ctx).await?),
        ("POST", ["send"]) => created(mail::send(k, ctx, body()?).await?),
        ("POST", ["templates", "preview"]) => ok(mail::preview(k, ctx, body()?).await?),
        ("GET", ["communications"]) => ok(mail::list(k, ctx, &req.query).await?),
        ("GET", ["communications", c]) => ok(mail::detail(k, ctx, uuid(c)?).await?),
        ("POST", ["communications", c, "seen"]) => ok(mail::mark_seen(k, ctx, uuid(c)?, body()?).await?),
        ("POST", ["communications", c, "retry"]) => ok(retry(k, ctx, uuid(c)?).await?),
        ("GET", ["attachments", a]) => return download(k, ctx, uuid(a)?).await,
        _ => return Err(Error::NotFound("endpoint".into())),
    })
}

/// `POST /communications/{id}/retry`: its author (or a manager) queues a failed email again.
async fn retry(k: &Kernel, ctx: &Ctx, comm: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let author: Option<Option<Uuid>> = sqlx::query_scalar("select created_by from e_communication where tenant_id = $1 and id = $2")
        .bind(ctx.tenant)
        .bind(comm)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    let manager = ctx.perms.access("Communication", Action::Write) == Access::All;
    match author {
        Some(a) if manager || a == Some(ctx.user) => k.run_action(&util::elevated(ctx), "Communication", comm, "retry", json!({})).await,
        _ => Err(Error::NotFound("Communication".into())),
    }
}

/// `GET /attachments/{id}`: a stored file (`/api/files`) for whoever may see the message it
/// belongs to: chat files by channel membership, mail files by the communication's visibility,
/// files of other records by read access to the record, unattached ones by their uploader.
async fn download(k: &Kernel, ctx: &Ctx, file: Uuid) -> Result<SiteResponse> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let row: Option<(Option<String>, Option<Uuid>, Option<Uuid>)> =
        sqlx::query_as("select entity, record_id, created_by from file_object where tenant_id = $1 and id = $2")
            .bind(ctx.tenant)
            .bind(file)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((entity, record, created_by)) = row else { return Err(Error::NotFound("attachment".into())) };
    let allowed = match (entity.as_deref(), record) {
        (Some("ChatMessage"), Some(m)) => chat::message_visible(&mut tx, ctx, m).await?,
        (Some("Communication"), Some(c)) => mail::visible(k, ctx, &mut tx, c).await?,
        (Some(e), Some(r)) => ctx.schema.entity(e).is_some() && k.get_tx(ctx, &mut tx, e, r, false).await.is_ok(),
        _ => created_by == Some(ctx.user),
    };
    tx.commit().await?;
    if !allowed {
        return Err(Error::NotFound("attachment".into()));
    }
    let f = k.file_info(&util::sys(ctx), file).await?;
    let mut r = attachment(&f.name, &f.content_type, Vec::new());
    // The server streams the stored file as the body, whatever its size.
    r = SiteResponse::file(r.status, &r.content_type, r.headers, file);
    Ok(r)
}

/// A file as a download: never shown in the page, and never as a type a browser could run.
pub(crate) fn attachment(name: &str, ctype: &str, data: Vec<u8>) -> SiteResponse {
    let ctype = ctype.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let ctype = if ctype.is_empty() || ACTIVE_TYPES.contains(&ctype.as_str()) { "application/octet-stream".to_string() } else { ctype };
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '_' }).collect();
    SiteResponse {
        status: 200,
        content_type: ctype,
        headers: vec![
            ("content-disposition".into(), format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", ascii.replace('"', ""), util::url_encode(name))),
            ("x-content-type-options".into(), "nosniff".into()),
            ("cache-control".into(), "private, max-age=3600".into()),
        ],
        body: data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_whole_message_or_file_may_be_large() {
        // What anyone with a link sends: a 1 MB answer to an invitation is refused on its length, before it is read.
        for (method, path) in [("POST", "rsvp"), ("GET", "rsvp"), ("POST", "/meet/guest")] {
            assert!(CommsSite.max_body_for(method, path) < 1 << 20, "{method} {path}");
        }
        for (method, path) in [("POST", "inbound/a.b"), ("POST", "mail/upload/a1"), ("POST", "calendar/import")] {
            assert_eq!(CommsSite.max_body_for(method, path), inbound::MAX_MESSAGE, "{method} {path}");
        }
        // A reply quoting the largest original webmail reads (4,000,000 bytes of HTML), as HTML and as text, escaped.
        assert_eq!(CommsSite.max_body_for("POST", "mail/jmap"), 16 << 20);
        // A calendar app's event is at most what CalDAV's max-resource-size says (dav.rs, 1 MB).
        for (method, path) in [("POST", "send"), ("PUT", "dav/calendars/a/b.ics"), ("POST", "calendar/events"), ("POST", "inbound")] {
            assert_eq!(CommsSite.max_body_for(method, path), 1 << 20, "{method} {path}");
        }
    }
}
