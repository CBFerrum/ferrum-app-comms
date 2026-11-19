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
//! The operator turns meetings on with the setting `comms.meet_url` (`FERRUM_MEET_URL`: LiveKit as browsers reach it,
//! `wss://`) and an API key and its secret as LiveKit was given them, Comms' secrets `meet.key` and `meet.secret` in the
//! installation's vault (keys.rs).
//!
//! Or LiveKit takes its keys from the vault as it starts: the service `meet` ([`Service`]; `ferrum task render
//! service:meet to:<dir>`) writes `livekit.yaml`, with `meet.secret` made by the vault at the first render (or the one
//! already there kept), under the API key `ferrum.<version>`, both the current and the one before while a rotation's
//! overlap lasts. Comms then signs with the version before during the overlap, which a LiveKit not restarted yet knows
//! too, and with the current one after it.
//!
//! Captions are each person's own: their browser's speech recognition captions their voice into
//! the call (LiveKit's `lk.transcription` text stream, the one LiveKit's own transcription agents
//! use, so an operator's agent shows the same way), and what they captioned is kept as the
//! meeting's transcript for whoever may join it. Recording is LiveKit Egress, which the operator
//! runs beside LiveKit with its own storage (`FERRUM_MEET_RECORDINGS=true`; `FERRUM_MEET_API_URL`
//! when the server reaches LiveKit at another address than browsers): anyone in the meeting may
//! start or stop it, everyone in the call sees that it is recording, and Comms keeps where each
//! recording went.

use crate::util::{self, created, ok, s};
use crate::{calendar, chat, keys, recur};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ferrum_kernel::vault::Zeroizing;
use ferrum_kernel::{Ctx, Error, Kernel, Result, SiteRequest, SiteResponse, Tx};
use serde_json::{Map, Value, json};
use sqlx::AssertSqlSafe;
use std::time::Duration;
use uuid::Uuid;

/// How long a pass admits its holder: minutes, enough to connect (DECISIONS, Comms). A connected person's pass is
/// refreshed by the meeting server itself; a person who loses access, or whom a host removed, gets no new one.
const TOKEN_SECONDS: i64 = 5 * 60;

pub(crate) struct Server {
    pub(crate) url: String,
    pub(crate) key: String,
    /// The version of the vault's secret that signs, the one `key` names; none: its current one.
    version: Option<i32>,
}

/// A setting (`ferrum_kernel::env`: the environment, else the settings table), read at each use.
fn setting(name: &str) -> Option<String> {
    ferrum_kernel::env::var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The hosts LiveKit's tokens go to: the browsers' address and, when it is another, the server API's.
fn hosts(url: &str) -> Vec<String> {
    let mut out: Vec<String> = [Some(url.to_string()), setting("FERRUM_MEET_API_URL")].into_iter().flatten().filter_map(|u| keys::host(&u)).collect();
    out.dedup();
    out
}

/// LiveKit, when the operator set it up: its addresses are settings; its key and secret are Comms' in the vault. A secret
/// the operator set signs only for the hosts its rule names, so that a changed address does not take what it signs
/// elsewhere.
pub(crate) async fn server(k: &Kernel) -> Result<Server> {
    let not_set_up = || Error::invalid("video meetings are not set up on this server");
    let url = setting("FERRUM_MEET_URL").ok_or_else(not_set_up)?.trim_end_matches('/').to_string();
    if !url.starts_with("wss://") && !url.starts_with("ws://") {
        tracing::warn!("FERRUM_MEET_URL must start with wss:// (ws:// only for a test): meetings are off");
        return Err(not_set_up());
    }
    let hosts = hosts(&url);
    if let Some(d) = keys::MEET_SECRET.describe(k).await?.filter(|d| d.managed_by.is_some()) {
        // The service meet's (a render made or kept it), bound to LiveKit by the render, not to an address: the version
        // before while a rotation's overlap lasts, which a LiveKit not restarted since knows too; else the current one.
        let previous = d.previous_until.is_some_and(|until| until > chrono::Utc::now());
        let version = if previous { d.version - 1 } else { d.version };
        return Ok(Server { url, key: key_name(version), version: Some(version) });
    }
    let key = keys::MEET_KEY.reveal(k).await?.ok_or_else(not_set_up)?.to_string();
    let allowed = keys::MEET_SECRET.hosts(k).await?.ok_or_else(not_set_up)?;
    if let Some(host) = hosts.iter().find(|h| !keys::names(&allowed, h)) {
        tracing::warn!(host, "Comms' secret meet.secret does not name the meeting server's host: meetings are off until its rule does");
        return Err(Error::Unavailable(format!(
            "LiveKit's secret may not sign for {host}: the meeting server's address moved, so change the hosts of Comms' secret meet.secret to match"
        )));
    }
    Ok(Server { url, key, version: None })
}

/// The API key LiveKit's rendered file names a version of `meet.secret` by.
fn key_name(version: i32) -> String {
    format!("ferrum.{version}")
}

/// `claims` as a LiveKit token (a JWT, HS256), signed by the vault.
pub(crate) async fn signed(k: &Kernel, server: &Server, claims: &Value) -> Result<String> {
    let unsigned = unsigned(claims);
    let signature = keys::MEET_SECRET.sign_at(k, unsigned.as_bytes(), server.version).await?;
    Ok(format!("{unsigned}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

fn unsigned(claims: &Value) -> String {
    format!("{}.{}", URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#), URL_SAFE_NO_PAD.encode(claims.to_string()))
}

/// Whether the operator runs LiveKit Egress beside LiveKit, for recordings (a setting).
fn recordings_on() -> bool {
    ferrum_kernel::env::var("FERRUM_MEET_RECORDINGS").is_some_and(|v| v.trim() == "true")
}

/// LiveKit's server API: `FERRUM_MEET_API_URL` (a setting), or the browsers' address over http(s).
pub(crate) fn api_url(server: &Server) -> String {
    match setting("FERRUM_MEET_API_URL") {
        Some(url) => url.trim_end_matches('/').to_string(),
        None => server.url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1),
    }
}

/// `/api/app/comms/meet/...`
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    match (req.method.as_str(), path) {
        ("GET", []) => {
            let available = server(k).await.is_ok();
            Ok(ok(json!({"available": available, "recordings": available && recordings_on()})))
        }
        ("GET", [kind, id, "transcript"]) => Ok(ok(transcript(k, ctx, kind, uuid(id)?).await?)),
        ("POST", [kind, id, "transcript"]) => Ok(ok(said(k, ctx, kind, uuid(id)?, util::body_json(req)?).await?)),
        ("GET", [kind, id, "recordings"]) => Ok(ok(recordings(k, ctx, kind, uuid(id)?).await?)),
        ("POST", [kind, id, "recordings"]) => Ok(created(start_recording(k, ctx, kind, uuid(id)?).await?)),
        ("POST", [kind, id, "recordings", rec, "stop"]) => Ok(ok(stop_recording(k, ctx, kind, uuid(id)?, uuid(rec)?).await?)),
        ("POST", ["rooms"]) => Ok(created(new_room(k, ctx, util::body_json(req)?).await?)),
        ("POST", ["room", id, "guest-link"]) => Ok(ok(guest_link(k, ctx, uuid(id)?, true).await?)),
        ("DELETE", ["room", id, "guest-link"]) => Ok(ok(guest_link(k, ctx, uuid(id)?, false).await?)),
        ("POST", [kind, id, "token"]) => {
            let server = server(k).await?;
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
    let (title, guest_path) = admit(k, ctx, kind, id).await?;
    let room = room_name(ctx.tenant, kind, id);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    if crate::hosts::denied(&mut tx, ctx.tenant, &room, &ctx.user.simple().to_string()).await? {
        return Err(Error::Forbidden("you were removed from this meeting".into()));
    }
    let host = crate::hosts::is_host(k, &mut tx, ctx, kind, id).await?;
    tx.commit().await?;
    let (meeting, recording_by) = crate::hosts::ensure_meeting(k, ctx.tenant, kind, id).await?;
    let name = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    // Each joining is its own participant, so a person can be in from two devices.
    let identity = format!("{}.{}", ctx.user.simple(), hex::encode(rand::random::<[u8; 4]>()));
    let token = token(k, server, &identity, &name, &room, chrono::Utc::now().timestamp()).await?;
    Ok(
        json!({"url": server.url, "token": token, "title": title, "guest_path": guest_path, "identity": identity, "meeting": meeting, "host": host, "recording_by": recording_by}),
    )
}

/// Who may start and stop a recording: everyone who may join, or only hosts when the meeting says so.
async fn may_record(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid) -> Result<()> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let by: Option<Option<String>> = sqlx::query_scalar("select recording_by from e_meeting where tenant_id = $1 and room = $2")
        .bind(ctx.tenant)
        .bind(room_name(ctx.tenant, kind, id))
        .fetch_optional(&mut *tx)
        .await?;
    let hosts_only = by.flatten().as_deref() == Some("Hosts");
    let allowed = !hosts_only || crate::hosts::is_host(k, &mut tx, ctx, kind, id).await?;
    tx.commit().await?;
    if allowed { Ok(()) } else { Err(Error::Forbidden("only hosts record this meeting".into())) }
}

/// The LiveKit room of a meeting.
pub(crate) fn room_name(tenant: Uuid, kind: &str, id: Uuid) -> String {
    format!("{}-{kind}-{}", tenant.simple(), id.simple())
}

/// A meeting's title when this person may join it, and a room's guest link.
async fn admit(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid) -> Result<(String, Option<String>)> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let mut kept_key = None;
    let title = match kind {
        "channel" => chat::call_title(&mut tx, ctx, id).await?,
        "event" => event_title(k, ctx, &mut tx, id).await?,
        "room" => {
            let (title, key): (String, Option<String>) =
                sqlx::query_as("update comms_meeting set used_at = now() where tenant_id = $1 and id = $2 and ended_at is null returning title, guest_key")
                    .bind(ctx.tenant)
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(|| Error::NotFound("Meeting".into()))?;
            if let Some(key) = key {
                kept_key = Some((util::slug(&mut tx, ctx.tenant).await?, key));
            }
            title
        }
        _ => return Err(Error::NotFound("Meeting".into())),
    };
    tx.commit().await?;
    // The link people in the room may share, its key opened after the transaction. With the vault closed they join all
    // the same, without it.
    let guest_path = match kept_key {
        Some((slug, kept)) => match keys::guest_key(k, ctx.tenant, id, &kept).await {
            Ok(key) => key.map(|key| room_guest_path(&slug, id, &key)),
            Err(e) => {
                tracing::warn!(room = %id, "a room's guest link was left out: {e}");
                None
            }
        },
        None => None,
    };
    Ok((title, guest_path))
}

// ───────────────────────────── transcripts ─────────────────────────────

/// What meetings keep of a person in Comms' own table (FEO-016): the captions they gave of their own
/// voice. They are in the person's copy, go with their erasure, and go again when a restore replays
/// it. The meeting keeps everyone else's words.
pub struct Transcripts;

#[async_trait::async_trait]
impl ferrum_kernel::privacy::PersonalHeld for Transcripts {
    fn app(&self) -> &'static str {
        "comms"
    }

    async fn report(&self, tx: &mut Tx, tenant: Uuid, account: Option<Uuid>, _emails: &[String]) -> Result<Vec<Value>> {
        let Some(account) = account else { return Ok(vec![]) };
        let said: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('meeting', room, 'text', text, 'said_at', said_at) from comms_transcript \
             where tenant_id = $1 and speaker = $2 order by said_at, segment limit 10000",
        )
        .bind(tenant)
        .bind(account)
        .fetch_all(&mut **tx)
        .await?;
        Ok(if said.is_empty() { vec![] } else { vec![json!({"what": "What they said in meetings, as their own captions", "segments": said})] })
    }

    async fn erase(&self, tx: &mut Tx, tenant: Uuid, account: Option<Uuid>, _emails: &[String], _reason: &str) -> Result<u64> {
        let Some(account) = account else { return Ok(0) };
        let gone = sqlx::query("delete from comms_transcript where tenant_id = $1 and speaker = $2").bind(tenant).bind(account).execute(&mut **tx).await?;
        Ok(gone.rows_affected())
    }
}

/// `POST /meet/{kind}/{id}/transcript {segment, text}`: what this person said, as their own browser
/// heard it. A segment is theirs: saying it again replaces its words, and nobody else's.
async fn said(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid, body: Map<String, Value>) -> Result<Value> {
    admit(k, ctx, kind, id).await?;
    let segment = body.get("segment").and_then(Value::as_str).unwrap_or_default();
    if segment.is_empty() || segment.len() > 100 || !segment.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
        return Err(Error::field("segment", "letters, digits, dots, dashes and underscores, up to 100"));
    }
    let text = body.get("text").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if text.is_empty() || text.chars().count() > 2000 {
        return Err(Error::field("text", "what was said, up to 2000 characters"));
    }
    let name = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query(
        "insert into comms_transcript (tenant_id, room, speaker, segment, speaker_name, text) values ($1, $2, $3, $4, $5, $6) \
         on conflict (tenant_id, room, speaker, segment) do update set text = excluded.text",
    )
    .bind(ctx.tenant)
    .bind(room_name(ctx.tenant, kind, id))
    .bind(ctx.user)
    .bind(segment)
    .bind(&name)
    .bind(text)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"saved": true}))
}

/// `GET /meet/{kind}/{id}/transcript`: what people captioned, in the order they said it.
async fn transcript(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid) -> Result<Value> {
    admit(k, ctx, kind, id).await?;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let segments: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('speaker', speaker, 'name', speaker_name, 'text', text, 'said_at', said_at) from comms_transcript \
         where tenant_id = $1 and room = $2 order by said_at, segment limit 10000",
    )
    .bind(ctx.tenant)
    .bind(room_name(ctx.tenant, kind, id))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"segments": segments}))
}

// ───────────────────────────── recordings ─────────────────────────────

/// A short-lived token for LiveKit's server API, allowed to record rooms.
async fn api_token(k: &Kernel, server: &Server, now: i64) -> Result<String> {
    let claims = json!({"iss": server.key, "sub": "ferrum-comms", "nbf": now - 10, "exp": now + 600, "video": {"roomRecord": true}});
    signed(k, server, &claims).await
}

/// One call to LiveKit Egress's API (Twirp, JSON).
async fn egress(k: &Kernel, server: &Server, method: &str, body: Value) -> Result<Value> {
    let url = format!("{}/twirp/livekit.Egress/{method}", api_url(server));
    // The operator's own server, usually beside Ferrum: private addresses allowed.
    let (client, parsed) = k.vetted_client(&url, true, Duration::from_secs(20), "Ferrum Comms").await?;
    let unavailable = |e: String| Error::Unavailable(format!("the meeting server's recordings: {e}"));
    let res = client
        .post(parsed)
        .header("authorization", format!("Bearer {}", api_token(k, server, chrono::Utc::now().timestamp()).await?))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| unavailable(e.to_string()))?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|e| unavailable(e.to_string()))?;
    let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(unavailable(answer.get("msg").and_then(Value::as_str).map_or_else(|| format!("status {status}"), str::to_string)));
    }
    Ok(answer)
}

/// A field of LiveKit's answer, by its proto name or its JSON name.
fn field<'a>(v: &'a Value, proto: &str, json: &str) -> Option<&'a Value> {
    v.get(proto).or_else(|| v.get(json))
}

/// An egress that will change no more.
fn finished(status: &str) -> bool {
    matches!(status, "EGRESS_COMPLETE" | "EGRESS_FAILED" | "EGRESS_ABORTED" | "EGRESS_LIMIT_REACHED")
}

/// What an egress says of itself: its status, where its file went, and what went wrong.
fn egress_state(info: &Value) -> (String, Option<String>, Option<String>) {
    // An unset enum is its first value.
    let status = info.get("status").and_then(Value::as_str).unwrap_or("EGRESS_STARTING").to_string();
    let files = field(info, "file_results", "fileResults").and_then(Value::as_array);
    let location = files.and_then(|f| f.first()).and_then(|f| f.get("location").or_else(|| f.get("filename"))).and_then(Value::as_str).map(str::to_string);
    let error = info.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()).map(str::to_string);
    (status, location, error)
}

const RECORDING: &str = "jsonb_build_object('id', id, 'status', status, 'started_by', started_by, 'started_at', started_at, \
    'stopped_by', stopped_by, 'ended_at', ended_at, 'location', location, 'error', error)";

/// `GET /meet/{kind}/{id}/recordings`: the meeting's recordings, newest first; those still going
/// are asked about first.
async fn recordings(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid) -> Result<Value> {
    admit(k, ctx, kind, id).await?;
    let room = room_name(ctx.tenant, kind, id);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let going: Vec<String> =
        sqlx::query_scalar("select egress_id from comms_recording where tenant_id = $1 and room = $2 and ended_at is null and egress_id is not null")
            .bind(ctx.tenant)
            .bind(&room)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    if let (false, Ok(server)) = (going.is_empty(), server(k).await) {
        let listed = egress(k, &server, "ListEgress", json!({"room_name": room})).await?;
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        for info in listed.get("items").and_then(Value::as_array).into_iter().flatten() {
            let Some(egress_id) = field(info, "egress_id", "egressId").and_then(Value::as_str).filter(|e| going.iter().any(|g| g == e)) else { continue };
            let (status, location, error) = egress_state(info);
            sqlx::query(
                "update comms_recording set status = $4, location = coalesce($5, location), error = $6, ended_at = case when $7 then coalesce(ended_at, now()) end \
                 where tenant_id = $1 and room = $2 and egress_id = $3",
            )
            .bind(ctx.tenant)
            .bind(&room)
            .bind(egress_id)
            .bind(&status)
            .bind(location)
            .bind(error)
            .bind(finished(&status))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let rows: Vec<Value> = sqlx::query_scalar(AssertSqlSafe(format!(
        "select {RECORDING} from comms_recording where tenant_id = $1 and room = $2 order by started_at desc limit 100"
    )))
    .bind(ctx.tenant)
    .bind(&room)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"recordings": rows}))
}

/// `POST /meet/{kind}/{id}/recordings`: starts recording the call, one recording at a time.
async fn start_recording(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid) -> Result<Value> {
    let server = server(k).await.ok().filter(|_| recordings_on()).ok_or_else(|| Error::invalid("recordings are not set up on this server"))?;
    admit(k, ctx, kind, id).await?;
    may_record(k, ctx, kind, id).await?;
    let room = room_name(ctx.tenant, kind, id);
    let rec = Uuid::new_v4();
    // The partial unique index keeps it to one at a time, even when two people start at once.
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    sqlx::query("insert into comms_recording (tenant_id, id, room, started_by, status) values ($1, $2, $3, $4, 'EGRESS_STARTING')")
        .bind(ctx.tenant)
        .bind(rec)
        .bind(&room)
        .bind(ctx.user)
        .execute(&mut *tx)
        .await
        .map_err(|e| match Error::from(e) {
            Error::Conflict(_) => Error::Conflict("this meeting is being recorded already".into()),
            other => other,
        })?;
    tx.commit().await?;
    let filepath = format!("ferrum/{}/{room}/{}.mp4", ctx.tenant.simple(), rec.simple());
    let started = egress(
        k,
        &server,
        "StartRoomCompositeEgress",
        json!({"room_name": room, "layout": "speaker", "file_outputs": [{"file_type": "MP4", "filepath": filepath}]}),
    )
    .await;
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let info = match started {
        Ok(info) => info,
        Err(e) => {
            sqlx::query("delete from comms_recording where tenant_id = $1 and id = $2").bind(ctx.tenant).bind(rec).execute(&mut *tx).await?;
            tx.commit().await?;
            return Err(e);
        }
    };
    let egress_id =
        field(&info, "egress_id", "egressId").and_then(Value::as_str).ok_or_else(|| Error::Unavailable("the meeting server started no recording".into()))?;
    let row: Value = sqlx::query_scalar(AssertSqlSafe(format!(
        "update comms_recording set egress_id = $3, status = $4 where tenant_id = $1 and id = $2 returning {RECORDING}"
    )))
    .bind(ctx.tenant)
    .bind(rec)
    .bind(egress_id)
    .bind(egress_state(&info).0)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

/// `POST /meet/{kind}/{id}/recordings/{rec}/stop`: stops a recording of the call. Its file is
/// finished and stored after; the recordings list says where once it is.
async fn stop_recording(k: &Kernel, ctx: &Ctx, kind: &str, id: Uuid, rec: Uuid) -> Result<Value> {
    let server = server(k).await?;
    admit(k, ctx, kind, id).await?;
    may_record(k, ctx, kind, id).await?;
    let room = room_name(ctx.tenant, kind, id);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let found: Option<(Option<String>, bool)> =
        sqlx::query_as("select egress_id, ended_at is not null from comms_recording where tenant_id = $1 and id = $2 and room = $3 for update")
            .bind(ctx.tenant)
            .bind(rec)
            .bind(&room)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    let (egress_id, ended) = found.ok_or_else(|| Error::NotFound("recording".into()))?;
    let egress_id = egress_id.ok_or_else(|| Error::invalid("this recording has not started yet"))?;
    if !ended {
        let info = egress(k, &server, "StopEgress", json!({"egress_id": egress_id})).await?;
        let (status, location, error) = egress_state(&info);
        let mut tx = k.db.tenant_tx(ctx.tenant).await?;
        sqlx::query(
            "update comms_recording set stopped_by = $3, status = $4, location = coalesce($5, location), error = $6, \
             ended_at = case when $7 then coalesce(ended_at, now()) end where tenant_id = $1 and id = $2",
        )
        .bind(ctx.tenant)
        .bind(rec)
        .bind(ctx.user)
        .bind(&status)
        .bind(location)
        .bind(error)
        .bind(finished(&status))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let row: Value = sqlx::query_scalar(AssertSqlSafe(format!("select {RECORDING} from comms_recording where tenant_id = $1 and id = $2")))
        .bind(ctx.tenant)
        .bind(rec)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row)
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
    // The room keeps it sealed (keys.rs), sealed before the transaction: the vault answers on a connection of its own.
    let kept = match &key {
        Some(key) => Some(keys::seal_guest_key(k, ctx.tenant, room, key).await?),
        None => None,
    };
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let n = sqlx::query("update comms_meeting set guest_key = $3 where tenant_id = $1 and id = $2")
        .bind(ctx.tenant)
        .bind(room)
        .bind(&kept)
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
    let link = link.trim();
    let Some((origin, rest)) = link.split_once("/meet/event/") else { return Ok(None) };
    if server(k).await.is_err()
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
    let server = server(k).await?;
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
            let Some((title, Some(kept))) = row else { return Err(gone()) };
            let Some(stored) = keys::guest_key(k, tenant, room, &kept).await? else { return Err(gone()) };
            let same = stored.len() == key.len() && stored.bytes().zip(key.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
            if !same {
                return Err(gone());
            }
            let name = typed.ok_or_else(|| Error::field("name", "type your name, as others in the meeting will see it"))?;
            ("room", room, title, name)
        }
        ["m", room, email, name, signature] => {
            let room: Uuid = room.parse().map_err(|_| gone())?;
            let decode = |v: &str| URL_SAFE_NO_PAD.decode(v).ok().and_then(|e| String::from_utf8(e).ok());
            let (email, signed_name) = (decode(email).ok_or_else(gone)?, decode(name).ok_or_else(gone)?);
            if !util::verify(&util::signing_key(k, tenant).await?, &crate::meetings::guest_claim(room, &email, &signed_name), signature) {
                return Err(gone());
            }
            let title = crate::meetings::admit_guest(k, tenant, room).await?.ok_or_else(gone)?;
            let mut tx = k.db.tenant_tx(tenant).await?;
            let removed = crate::hosts::denied(&mut tx, tenant, &room_name(tenant, "room", room), &format!("guest.{}", hex::encode(&email))).await?;
            tx.commit().await?;
            if removed {
                return Err(Error::Forbidden("you were removed from this meeting".into()));
            }
            let identity = format!("guest.{}.{}", hex::encode(&email), hex::encode(rand::random::<[u8; 4]>()));
            let name = typed.unwrap_or(signed_name);
            let pass = token(k, &server, &identity, &format!("{name} (guest)"), &room_name(tenant, "room", room), chrono::Utc::now().timestamp()).await?;
            return Ok(ok(json!({"url": server.url, "token": pass, "title": title, "name": name})));
        }
        _ => return Err(gone()),
    };
    let identity = format!("guest.{}", hex::encode(rand::random::<[u8; 6]>()));
    let pass = token(k, &server, &identity, &format!("{name} (guest)"), &room_name(tenant, kind, id), chrono::Utc::now().timestamp()).await?;
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
pub(crate) async fn token(k: &Kernel, server: &Server, identity: &str, name: &str, room: &str, now: i64) -> Result<String> {
    signed(k, server, &claims(server, identity, name, room, now)).await
}

fn claims(server: &Server, identity: &str, name: &str, room: &str, now: i64) -> Value {
    json!({
        "iss": server.key, "sub": identity, "name": name, "nbf": now - 10, "exp": now + TOKEN_SECONDS,
        "video": {"room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true},
    })
}

// ───────────────────────────── the service meet ─────────────────────────────

/// How long the secret before a rotation still signs, and is still given to LiveKit: a day, to restart LiveKit in.
const OVERLAP_SECS: i64 = 86_400;

/// LiveKit's configuration file, written as LiveKit starts (`ferrum task render service:meet to:<dir>`, then
/// `livekit-server --config <dir>/livekit.yaml`): its ports, the address it gives browsers (`comms.meet_node_ip`,
/// `comms.meet_external_ip`) and its keys. `meet.secret` is made by the vault at the first render where it holds none,
/// or, where the operator set one before it, kept as it is (keys.rs, `made_or_kept`). Each version kept is written under
/// the API key `ferrum.<version>`, the current one first, which is what Comms names in the tokens it signs with the
/// vault's (LiveKit started on this file knows no other API key).
pub(crate) struct Service;

#[async_trait::async_trait]
impl ferrum_kernel::companion::Companion for Service {
    fn files(&self) -> &'static [&'static str] {
        &["livekit.yaml"]
    }

    fn made(&self) -> &'static [&'static str] {
        &[keys::MEET_SECRET.name]
    }

    async fn render(&self, r: &ferrum_kernel::companion::Rendering<'_>) -> Result<Vec<ferrum_kernel::companion::File>> {
        let rule = ferrum_kernel::vault::Rule { reveal: true, overlap_secs: OVERLAP_SECS, ..Default::default() };
        keys::made_or_kept(r, keys::MEET_SECRET.name, rule, || Ok(vec![])).await?;
        let external = match r.setting("comms.meet_external_ip").map(|v| v.to_ascii_lowercase()).as_deref() {
            None | Some("true") => true,
            Some("false") => false,
            Some(_) => return Err(Error::invalid("comms.meet_external_ip is true or false")),
        };
        let node_ip = r.setting("comms.meet_node_ip").unwrap_or_default();
        if !node_ip.is_empty() && node_ip.parse::<std::net::IpAddr>().is_err() {
            return Err(Error::invalid("comms.meet_node_ip is the IP address LiveKit gives browsers, such as 203.0.113.7"));
        }
        // ponytail: room for the file up front, so that no copy of a secret is left behind in memory a reallocation freed.
        let mut yaml = Zeroizing::new(String::with_capacity(4096));
        yaml.push_str("port: 7880\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n");
        yaml.push_str(if external { "  use_external_ip: true\n" } else { "  use_external_ip: false\n" });
        yaml.push_str("  node_ip: ");
        quoted(&mut yaml, &node_ip);
        yaml.push_str("\nkeys:\n");
        for v in r.versions(keys::MEET_SECRET.name).await? {
            let secret = std::str::from_utf8(&v.value).map_err(|_| Error::invalid("meet.secret is text"))?;
            yaml.push_str("  ");
            quoted(&mut yaml, &key_name(v.version));
            yaml.push_str(": ");
            quoted(&mut yaml, secret);
            yaml.push('\n');
        }
        let bytes = Zeroizing::new(std::mem::take(&mut *yaml).into_bytes());
        Ok(vec![ferrum_kernel::companion::File { name: "livekit.yaml".into(), bytes, secret: true }])
    }
}

/// `text` as a YAML double-quoted scalar, onto `out`: JSON's escapes, which YAML takes.
fn quoted(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_made_for_one_room() {
        let server = Server { url: "wss://meet.test".into(), key: "APIkey".into(), version: None };
        let t = unsigned(&claims(&server, "u.1", "Ana Rao", "t-room-x", 1_000_000));
        let parts: Vec<&str> = t.split('.').collect();
        let part = |i: usize| serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(parts[i]).unwrap()).unwrap();
        assert_eq!(part(0)["alg"], "HS256");
        let claims = part(1);
        assert_eq!((claims["iss"].clone(), claims["sub"].clone(), claims["name"].clone()), (json!("APIkey"), json!("u.1"), json!("Ana Rao")));
        assert_eq!((claims["nbf"].clone(), claims["exp"].clone()), (json!(999_990), json!(1_000_000 + TOKEN_SECONDS)));
        assert_eq!(claims["video"], json!({"room": "t-room-x", "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true}));
    }

    /// What an operator typed (a key from LiveKit's environment) goes into livekit.yaml as one quoted value, whatever it holds.
    #[test]
    fn values_are_quoted_whole() {
        for text in ["APIkey", "", "a \"b\" \\c", "line\nbreak\ttab\u{7f}", "ünïcødé: {x}, #y"] {
            let mut out = String::new();
            quoted(&mut out, text);
            assert!(!out.contains('\n'), "{out}");
            assert_eq!(serde_json::from_str::<String>(&out).unwrap(), text, "{out}");
        }
    }
}
