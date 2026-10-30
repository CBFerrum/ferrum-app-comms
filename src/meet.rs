//! Video meetings (Ferrum docs/plan/collaboration.md, C4). LiveKit, a service of its own like the
//! mail server, carries the sound and pictures; Comms decides who may join which meeting and signs
//! their LiveKit access tokens. A meeting belongs to:
//! * a chat channel: whoever may read it (its members, or anyone for a public channel);
//! * a calendar event: whoever may see it (its organizer and guests, or anyone for a public one);
//! * a room someone started ("Meet now"): anyone in the workspace who has its link.
//!
//! The operator turns meetings on with `FERRUM_MEET_URL` (LiveKit as browsers reach it, `wss://`),
//! `FERRUM_MEET_KEY` and `FERRUM_MEET_SECRET` (an API key and its secret, as LiveKit was given).

use crate::chat;
use crate::util::{self, created, ok, s};
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
        ("POST", [kind, id, "token"]) => {
            let server = server().ok_or_else(|| Error::invalid("video meetings are not set up on this server"))?;
            let id = id.parse().map_err(|_| Error::NotFound("Meeting".into()))?;
            Ok(ok(join(k, ctx, &server, kind, id).await?))
        }
        _ => Err(Error::NotFound("meeting endpoint".into())),
    }
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
    let title = match kind {
        "channel" => chat::call_title(&mut tx, ctx, id).await?,
        "event" => event_title(k, ctx, &mut tx, id).await?,
        "room" => sqlx::query_scalar("update comms_meeting set used_at = now() where tenant_id = $1 and id = $2 returning title")
            .bind(ctx.tenant)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| Error::NotFound("Meeting".into()))?,
        _ => return Err(Error::NotFound("Meeting".into())),
    };
    tx.commit().await?;
    let name = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    // Each joining is its own participant, so a person can be in from two devices.
    let identity = format!("{}.{}", ctx.user.simple(), hex::encode(rand::random::<[u8; 4]>()));
    let room = format!("{}-{kind}-{}", ctx.tenant.simple(), id.simple());
    let token = token(server, &identity, &name, &room, chrono::Utc::now().timestamp());
    Ok(json!({"url": server.url, "token": token, "title": title}))
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
