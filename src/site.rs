//! The package's HTTP endpoints: `/api/app/comms/...` for signed-in users (Comms roles; webmail
//! for whoever has a hosted mailbox) and `/api/site/{tenant}/comms/...` for the public (inbound
//! mail webhook, unsubscribe pages, calendar feeds — each authenticated by an unguessable or
//! signed token). See README.md.

use crate::util::{self, created, ok};
use crate::{calendar, chat, inbound, mail, newsletter, webmail};
use async_trait::async_trait;
use ferrum_kernel::{Access, Action, Ctx, Error, Kernel, Result, Site, SiteRequest, SiteResponse};
use serde_json::{Value, json};
use uuid::Uuid;

/// Media types a browser could execute; served as downloads of unknown type.
const ACTIVE_TYPES: &[&str] =
    &["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript", "text/xml", "application/xml"];

pub struct CommsSite;

#[async_trait]
impl Site for CommsSite {
    /// Raw messages forwarded to the inbound webhook can be large.
    fn max_body(&self) -> usize {
        inbound::MAX_MESSAGE
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
        ("GET" | "POST", ["unsubscribe"]) => newsletter::unsubscribe(k, req).await,
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
    let (name, ctype, data) = k.read_file(&util::sys(ctx), file).await?;
    Ok(attachment(&name, &ctype, data))
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
