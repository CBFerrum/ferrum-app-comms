//! Video meetings (Ferrum docs/plan/collaboration.md, C4). LiveKit, a service of its own like the
//! mail server, carries the sound and pictures; Comms decides who may join which meeting and signs
//! their LiveKit access tokens. A meeting belongs to:
//! * a chat channel: whoever may read it (its members, or anyone for a public channel);
//! * a calendar event: whoever may see it (its organizer and guests, or anyone for a public one);
//! * a room someone started ("Meet now"): anyone in the workspace who has its link.
//!
//! People outside the workspace join by link as guests (`POST /api/site/{tenant}/comms/meet/guest`):
//! an event's outside guests by the personal link their invitation carries, anyone by a room's
//! guest link. Removing the guest from the event, or turning the room's link off, stops the link.
//!
//! The operator turns meetings on with `FERRUM_MEET_URL` (LiveKit as browsers reach it, `wss://`),
//! `FERRUM_MEET_KEY` and `FERRUM_MEET_SECRET` (an API key and its secret, as LiveKit was given).

use crate::util::{self, created, ok, s};
use crate::{calendar, chat, recur};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ferrum_kernel::{Ctx, Error, Kernel, Result, SiteRequest, SiteResponse, Tx};
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use uuid::Uuid;

/// How long a token admits its holder. LiveKit checks it when joining and reconnecting, so it
/// covers a long meeting's reconnections; a person who loses access gets no new one.
const TOKEN_SECONDS: i64 = 6 * 3600;

struct Server {
    url: String,
    key: String,
    secret: String,
}

/// LiveKit, when the operator set it up.
fn server() -> Option<Server> {
    let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let url = var("FERRUM_MEET_URL")?.trim_end_matches('/').to_string();
    if !url.starts_with("wss://") && !url.starts_with("ws://") {
        tracing::warn!("FERRUM_MEET_URL must start with wss:// (ws:// only for a test): meetings are off");
        return None;
    }
    Some(Server { url, key: var("FERRUM_MEET_KEY")?, secret: var("FERRUM_MEET_SECRET")? })
}

/// `/api/app/comms/meet/...`
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    match (req.method.as_str(), path) {
        ("GET", []) => Ok(ok(json!({"available": server().is_some()}))),
        ("POST", ["rooms"]) => Ok(created(new_room(k, ctx, util::body_json(req)?).await?)),
        ("POST", ["room", id, "guest-link"]) => Ok(ok(guest_link(k, ctx, uuid(id)?, true).await?)),
        ("DELETE", ["room", id, "guest-link"]) => Ok(ok(guest_link(k, ctx, uuid(id)?, false).await?)),
        ("POST", [kind, id, "token"]) => {
            let server = server().ok_or_else(|| Error::invalid("video meetings are not set up on this server"))?;
            let id = id.parse().map_err(|_| Error::NotFound("Meeting".into()))?;
            Ok(ok(join(k, ctx, &server, kind, id).await?))
        }
        _ => Err(Error::NotFound("meeting endpoint".into())),
    }
}

fn uuid(seg: &str) -> Result<Uuid> {
    seg.parse().map_err(|_| Error::NotFound("Meeting".into()))
}

/// `POST /meet/rooms {title?}`: a room to meet in now.
async fn new_room(k: &Kernel, ctx: &Ctx, body: Map<String, Value>) -> Result<Value> {
    let title = body.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map_or_else(|| "Meeting".into(), |t| util::cut(t, 140));
    let id = Uuid::new_v4();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query("insert into comms_meeting (tenant_id, id, title, created_by) values ($1, $2, $3, $4)")
        .bind(ctx.tenant)
        .bind(id)
        .bind(&title)
        .bind(ctx.user)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"kind": "room", "id": id, "title": title}))
}

/// `POST /meet/{kind}/{id}/token`: `{url, token, title}` for a meeting the caller may join; any
/// other is "not found".
async fn join(k: &Kernel, ctx: &Ctx, server: &Server, kind: &str, id: Uuid) -> Result<Value> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let mut guest_path = None;
    let title = match kind {
        "channel" => chat::call_title(&mut tx, ctx, id).await?,
        "event" => event_title(k, ctx, &mut tx, id).await?,
        "room" => {
            let (title, key): (String, Option<String>) =
                sqlx::query_as("update comms_meeting set used_at = now() where tenant_id = $1 and id = $2 returning title, guest_key")
                    .bind(ctx.tenant)
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(|| Error::NotFound("Meeting".into()))?;
            if let Some(key) = key {
                guest_path = Some(room_guest_path(&util::slug(&mut tx, ctx.tenant).await?, id, &key));
            }
            title
        }
        _ => return Err(Error::NotFound("Meeting".into())),
    };
    tx.commit().await?;
    let name = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    // Each joining is its own participant, so a person can be in from two devices.
    let identity = format!("{}.{}", ctx.user.simple(), hex::encode(rand::random::<[u8; 4]>()));
    let room = format!("{}-{kind}-{}", ctx.tenant.simple(), id.simple());
    let token = token(server, &identity, &name, &room, chrono::Utc::now().timestamp());
    Ok(json!({"url": server.url, "token": token, "title": title, "guest_path": guest_path}))
}

// ───────────────────────────── guests ─────────────────────────────

/// Comms' public page for guests (its interface's `meet/guest`, Ferrum docs/plan/apps-ui.md §7.3).
fn room_guest_path(slug: &str, room: Uuid, key: &str) -> String {
    format!("/meet/guest/{slug}/r.{}.{key}", room.simple())
}

/// `POST /meet/room/{id}/guest-link`: a new guest link for the room (the old one stops working);
/// `DELETE`: no guest link.
async fn guest_link(k: &Kernel, ctx: &Ctx, room: Uuid, on: bool) -> Result<Value> {
    let key = on.then(|| URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>()));
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let n = sqlx::query("update comms_meeting set guest_key = $3 where tenant_id = $1 and id = $2")
        .bind(ctx.tenant)
        .bind(room)
        .bind(&key)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(Error::NotFound("Meeting".into()));
    }
    let slug = util::slug(&mut tx, ctx.tenant).await?;
    tx.commit().await?;
    Ok(json!({"guest_path": key.map(|key| room_guest_path(&slug, room, &key))}))
}

/// What an outside guest's link signs: the event and their address.
fn guest_claim(event: Uuid, email: &str) -> String {
    format!("meet-guest|{event}|{}", email.to_lowercase())
}

/// The link to an event's meeting for one outside guest, when `link` (the event's meeting link) is
/// this event's meeting here: the invitation carries it instead.
pub(crate) async fn invitation_link(k: &Kernel, tx: &mut Tx, tenant: Uuid, event: Uuid, link: &str, email: &str) -> Result<Option<String>> {
    // Links made before Comms had pages of its own lead to the web app (`/app/meet/…`).
    let link = link.trim();
    let Some((origin, rest)) = link.split_once("/app/meet/event/").or_else(|| link.split_once("/meet/event/")) else { return Ok(None) };
    if server().is_none()
        || rest.trim_end_matches('/').parse::<Uuid>().ok() != Some(event)
        || !origin.starts_with("http")
        || origin.contains(char::is_whitespace)
    {
        return Ok(None);
    }
    let key = util::signing_key(k, tenant).await?;
    let email = email.to_lowercase();
    let token = format!("e.{}.{}.{}", event.simple(), URL_SAFE_NO_PAD.encode(&email), util::sign(&key, &guest_claim(event, &email)));
    Ok(Some(format!("{origin}/meet/guest/{}/{token}", util::slug(tx, tenant).await?)))
}

/// `POST /api/site/{tenant}/comms/meet/guest {token, name?}`: someone outside the workspace joins by
/// their link, as "Name (guest)". An event's link names its guest; a room's takes the name typed.
pub async fn guest(k: &Kernel, req: &SiteRequest) -> Result<SiteResponse> {
    let server = server().ok_or_else(|| Error::invalid("video meetings are not set up on this server"))?;
    let body = util::body_json(req)?;
    let link = body.get("token").and_then(Value::as_str).unwrap_or_default();
    let typed = body.get("name").and_then(Value::as_str).map(|n| util::clean_line(n, 60)).filter(|n| !n.trim().is_empty());
    let gone = || Error::NotFound("This link no longer works. Ask the person who invited you for a new one.".into());
    let tenant = req.tenant;
    let (kind, id, title, name) = match link.split('.').collect::<Vec<_>>().as_slice() {
        ["e", event, email, signature] => {
            let event: Uuid = event.parse().map_err(|_| gone())?;
            let email = URL_SAFE_NO_PAD.decode(email).ok().and_then(|e| String::from_utf8(e).ok()).ok_or_else(gone)?;
            if !util::verify(&util::signing_key(k, tenant).await?, &guest_claim(event, &email), signature) {
                return Err(gone());
            }
            let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
            let mut tx = k.db.tenant_tx(tenant).await?;
            let doc = k.get_tx(&sys, &mut tx, "CalendarEvent", event, false).await.map_err(|_| gone())?;
            tx.commit().await?;
            let invited = util::rows(&doc, "attendees")
                .iter()
                .find(|a| s(a, "email").is_some_and(|e| e.eq_ignore_ascii_case(&email)))
                .map(|a| s(a, "attendee_name").map(str::to_string));
            let Some(invited_as) = invited else { return Err(gone()) };
            if s(&doc, "status") == Some("Cancelled") {
                return Err(Error::invalid("this event was cancelled"));
            }
            // The link works until a day after the event's last occurrence.
            let now = chrono::Utc::now();
            if calendar::series(&doc).is_none_or(|sr| recur::occurrences(&sr, now - chrono::Duration::days(1), now + chrono::Duration::days(400)).is_empty()) {
                return Err(gone());
            }
            let name = typed.or(invited_as).unwrap_or_else(|| email.split('@').next().unwrap_or("Guest").to_string());
            ("event", event, s(&doc, "subject").unwrap_or("Meeting").to_string(), name)
        }
        ["r", room, key] => {
            let room: Uuid = room.parse().map_err(|_| gone())?;
            let mut tx = k.db.tenant_tx(tenant).await?;
            let row: Option<(String, Option<String>)> = sqlx::query_as("select title, guest_key from comms_meeting where tenant_id = $1 and id = $2")
                .bind(tenant)
                .bind(room)
                .fetch_optional(&mut *tx)
                .await?;
            tx.commit().await?;
            let Some((title, Some(stored))) = row else { return Err(gone()) };
            let same = stored.len() == key.len() && stored.bytes().zip(key.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
            if !same {
                return Err(gone());
            }
            let name = typed.ok_or_else(|| Error::field("name", "type your name, as others in the meeting will see it"))?;
            ("room", room, title, name)
        }
        _ => return Err(gone()),
    };
    let identity = format!("guest.{}", hex::encode(rand::random::<[u8; 6]>()));
    let room_name = format!("{}-{kind}-{}", tenant.simple(), id.simple());
    let pass = token(&server, &identity, &format!("{name} (guest)"), &room_name, chrono::Utc::now().timestamp());
    Ok(ok(json!({"url": server.url, "token": pass, "title": title, "name": name})))
}

/// An event's subject, when the caller may see the event and it was not cancelled.
async fn event_title(k: &Kernel, ctx: &Ctx, tx: &mut Tx, id: Uuid) -> Result<String> {
    let doc = match k.get_tx(ctx, tx, "CalendarEvent", id, false).await {
        Ok(doc) => doc,
        Err(_) => k
            .get_tx(&util::sys(ctx), tx, "CalendarEvent", id, false)
            .await
            .ok()
            .filter(|d| s(d, "visibility") == Some("Public"))
            .ok_or_else(|| Error::NotFound("Meeting".into()))?,
    };
    if s(&doc, "status") == Some("Cancelled") {
        return Err(Error::invalid("this event was cancelled"));
    }
    Ok(s(&doc, "subject").unwrap_or("Meeting").to_string())
}

/// A LiveKit access token: a JWT (HS256) admitting `identity` to `room` with camera,
/// microphone, screen sharing and the meeting's chat.
fn token(server: &Server, identity: &str, name: &str, room: &str, now: i64) -> String {
    let claims = json!({
        "iss": server.key, "sub": identity, "name": name, "nbf": now - 10, "exp": now + TOKEN_SECONDS,
        "video": {"room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true},
    });
    let unsigned = format!("{}.{}", URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#), URL_SAFE_NO_PAD.encode(claims.to_string()));
    let mut mac = Hmac::<Sha256>::new_from_slice(server.secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(unsigned.as_bytes());
    format!("{unsigned}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_signed_for_one_room() {
        let server = Server { url: "wss://meet.test".into(), key: "APIkey".into(), secret: "a-secret".into() };
        let t = token(&server, "u.1", "Ana Rao", "t-room-x", 1_000_000);
        let parts: Vec<&str> = t.split('.').collect();
        let mut mac = Hmac::<Sha256>::new_from_slice(b"a-secret").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).expect("signed with the secret");
        let part = |i: usize| serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(parts[i]).unwrap()).unwrap();
        assert_eq!(part(0)["alg"], "HS256");
        let claims = part(1);
        assert_eq!((claims["iss"].clone(), claims["sub"].clone(), claims["name"].clone()), (json!("APIkey"), json!("u.1"), json!("Ana Rao")));
        assert_eq!((claims["nbf"].clone(), claims["exp"].clone()), (json!(999_990), json!(1_000_000 + TOKEN_SECONDS)));
        assert_eq!(claims["video"], json!({"room": "t-room-x", "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true}));
    }
}
