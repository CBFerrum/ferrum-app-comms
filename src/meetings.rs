//! Meetings other apps make for their own records (a booking, a live class). The caller creates the
//! meeting, asks for join links, moves it and ends it, and reads who was in it; Comms sends no
//! invitation, the calling app sends its own. Such a meeting is a room (`comms_meeting`): it is in
//! nobody's calendar. Members join by the link of its page (they sign in, as for any room); an
//! outside guest joins with a link made for their name and address, which admits them to this
//! meeting only and stops working two hours after it was due to end, or when it is ended.
//!
//! Attendance is what the meeting server reports of the room while it runs: LiveKit keeps no
//! history of who was in a room, so Comms asks it who is in the room every minute (its upkeep) from
//! a quarter of an hour before the meeting until two hours after it was due to end, and keeps each
//! joining with the server's own time of joining. The time spent is accurate to about a minute: a
//! person who joined and left between two asks is not seen, and a person's time ends when they were
//! last seen. Nothing has to be set up beyond the meeting server itself.

use crate::meet::{self, Server};
use crate::util;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, Utc};
use ferrum_kernel::{Error, Kernel, Tx};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::time::Duration as Wait;
use uuid::Uuid;

/// How long after a meeting was due to end its guests' links keep working, and its attendance is read.
const GRACE: i64 = 2;
/// How long before it starts attendance is read.
const EARLY_MINUTES: i64 = 15;

/// Why a meeting could not be made or reached; callers branch on the first two to do without.
#[derive(Debug)]
pub enum MeetingError {
    /// The workspace does not have the Comms package.
    NotInstalled,
    /// The operator has not set up a meeting server (`FERRUM_MEET_URL`, key and secret).
    NotConfigured,
    /// No such meeting here.
    NotFound,
    /// The meeting was ended.
    Ended,
    /// Guests' links need the workspace's public address (Comms settings).
    NoPublicAddress,
    /// The request is wrong: its message says how.
    Invalid(String),
    /// The meeting server or the database failed.
    Failed(Error),
}

impl std::fmt::Display for MeetingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInstalled => f.write_str("the Mail, Chat and Calendar app is not installed in this workspace"),
            Self::NotConfigured => f.write_str("video meetings are not set up on this server"),
            Self::NotFound => f.write_str("no such meeting"),
            Self::Ended => f.write_str("this meeting was ended"),
            Self::NoPublicAddress => f.write_str("set the workspace's public address in Comms settings to make guest links"),
            Self::Invalid(m) => f.write_str(m),
            Self::Failed(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MeetingError {}

impl From<Error> for MeetingError {
    fn from(e: Error) -> Self {
        Self::Failed(e)
    }
}

impl From<sqlx::Error> for MeetingError {
    fn from(e: sqlx::Error) -> Self {
        Self::Failed(e.into())
    }
}

pub type Result<T> = std::result::Result<T, MeetingError>;

/// What a caller asks for.
pub struct NewMeeting<'a> {
    /// The calling app's record, as its source: entity name and id.
    pub entity: &'a str,
    pub record: Uuid,
    pub title: &'a str,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    /// The user who hosts it (a booking's staff member, a class's instructor).
    pub host: Uuid,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Meeting {
    pub id: Uuid,
    pub entity: String,
    pub record: Uuid,
    pub title: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub host: Option<Uuid>,
    pub ended_at: Option<DateTime<Utc>>,
}

/// A link for an outside guest and when it stops working.
#[derive(Debug, Clone, PartialEq)]
pub struct GuestLink {
    pub url: String,
    pub expires_at: DateTime<Utc>,
}

/// One person's time in a meeting, from what the meeting server reported. A member has `user`; a
/// guest has the `email` their link was made for.
#[derive(Debug, Clone, PartialEq)]
pub struct Attendee {
    pub user: Option<Uuid>,
    pub email: Option<String>,
    pub name: String,
    pub first_joined: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    /// Time in the room, joinings from several devices counted once.
    pub seconds: i64,
    pub joinings: i64,
}

type Row = (Uuid, String, Uuid, String, DateTime<Utc>, DateTime<Utc>, Option<Uuid>, Option<DateTime<Utc>>);
const COLUMNS: &str = "id, source_entity, source_id, title, starts_at, ends_at, created_by, ended_at";

fn meeting(r: Row) -> Meeting {
    Meeting { id: r.0, entity: r.1, record: r.2, title: r.3, starts_at: r.4, ends_at: r.5, host: r.6, ended_at: r.7 }
}

/// Whether meetings can be made in this workspace now: `Ok`, or why not.
pub async fn available(k: &Kernel, tenant: Uuid) -> Result<()> {
    if !k.registry.schema(tenant).await?.packages.iter().any(|p| p == "comms") {
        return Err(MeetingError::NotInstalled);
    }
    meet::server().map(|_| ()).ok_or(MeetingError::NotConfigured)
}

/// A meeting for a record of the caller's. The record's open meeting is returned if it has one.
pub async fn create(k: &Kernel, tenant: Uuid, new: NewMeeting<'_>) -> Result<Meeting> {
    available(k, tenant).await?;
    let (entity, title) = (util::clean_line(new.entity, 140), util::clean_line(new.title, 140));
    if entity.is_empty() {
        return Err(MeetingError::Invalid("a meeting belongs to a record: say which".into()));
    }
    if new.ends_at <= new.starts_at {
        return Err(MeetingError::Invalid("a meeting ends after it starts".into()));
    }
    if let Some(open) = find(k, tenant, &entity, new.record).await?.filter(|m| m.ended_at.is_none()) {
        return Ok(open);
    }
    let id = Uuid::new_v4();
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query(
        "insert into comms_meeting (tenant_id, id, title, created_by, source_entity, source_id, starts_at, ends_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(tenant)
    .bind(id)
    .bind(if title.is_empty() { "Meeting" } else { &title })
    .bind(new.host)
    .bind(&entity)
    .bind(new.record)
    .bind(new.starts_at)
    .bind(new.ends_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    get(k, tenant, id).await
}

/// The latest meeting made for a record, ended or not; `None` when there is none (or Comms is not
/// installed).
pub async fn find(k: &Kernel, tenant: Uuid, entity: &str, record: Uuid) -> Result<Option<Meeting>> {
    if !k.registry.schema(tenant).await?.packages.iter().any(|p| p == "comms") {
        return Ok(None);
    }
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {COLUMNS} from comms_meeting where tenant_id = $1 and source_entity = $2 and source_id = $3 order by created_at desc limit 1"
    )))
    .bind(tenant)
    .bind(entity)
    .bind(record)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row.map(meeting))
}

/// A meeting made for a record by this API.
pub async fn get(k: &Kernel, tenant: Uuid, id: Uuid) -> Result<Meeting> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<Row> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("select {COLUMNS} from comms_meeting where tenant_id = $1 and id = $2 and source_entity is not null")))
            .bind(tenant)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    row.map(meeting).ok_or(MeetingError::NotFound)
}

/// The public address of the workspace, when it has one.
async fn base(k: &Kernel, tx: &mut Tx, tenant: Uuid) -> Result<String> {
    util::settings(tx, tenant)
        .await?
        .public_url
        .or_else(|| k.settings.public_url.clone().map(|u| u.trim_end_matches('/').to_string()))
        .ok_or(MeetingError::NoPublicAddress)
}

/// The link a signed-in member opens to join (they sign in first, as for any room).
pub async fn member_link(k: &Kernel, tenant: Uuid, id: Uuid) -> Result<String> {
    available(k, tenant).await?;
    let m = open(k, tenant, id).await?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let base = base(k, &mut tx, tenant).await?;
    tx.commit().await?;
    Ok(format!("{base}/meet/room/{}", m.id))
}

/// What a guest's link signs: the meeting, their address and the name it was made for.
pub(crate) fn guest_claim(room: Uuid, email: &str, name: &str) -> String {
    format!("meet-app-guest|{room}|{}|{name}", email.to_lowercase())
}

/// A link for an outside guest, by name and address. It needs no account, admits only to this
/// meeting, and stops working two hours after it was due to end (a moved meeting moves it) or when
/// the meeting is ended. Making it again gives the same link.
pub async fn guest_link(k: &Kernel, tenant: Uuid, id: Uuid, name: &str, email: &str) -> Result<GuestLink> {
    available(k, tenant).await?;
    let m = open(k, tenant, id).await?;
    let email = email.trim().to_lowercase();
    if !email.contains('@') || email.chars().any(char::is_whitespace) {
        return Err(MeetingError::Invalid("the guest needs an email address".into()));
    }
    let name = util::clean_line(name, 60);
    let name = if name.is_empty() { email.split('@').next().unwrap_or("Guest").to_string() } else { name };
    let key = util::signing_key(k, tenant).await?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let base = base(k, &mut tx, tenant).await?;
    let slug = util::slug(&mut tx, tenant).await?;
    tx.commit().await?;
    let token = format!(
        "m.{}.{}.{}.{}",
        m.id.simple(),
        URL_SAFE_NO_PAD.encode(&email),
        URL_SAFE_NO_PAD.encode(&name),
        util::sign(&key, &guest_claim(m.id, &email, &name))
    );
    Ok(GuestLink { url: format!("{base}/meet/guest/{slug}/{token}"), expires_at: m.ends_at + Duration::hours(GRACE) })
}

/// The meeting's title when a guest may join it now (not ended, not long over).
pub(crate) async fn admit_guest(k: &Kernel, tenant: Uuid, room: Uuid) -> ferrum_kernel::Result<Option<String>> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<(String, DateTime<Utc>)> =
        sqlx::query_as("select title, ends_at from comms_meeting where tenant_id = $1 and id = $2 and source_entity is not null and ended_at is null")
            .bind(tenant)
            .bind(room)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(row.filter(|(_, ends)| Utc::now() < *ends + Duration::hours(GRACE)).map(|(title, _)| title))
}

/// An open meeting.
async fn open(k: &Kernel, tenant: Uuid, id: Uuid) -> Result<Meeting> {
    let m = get(k, tenant, id).await?;
    if m.ended_at.is_some() { Err(MeetingError::Ended) } else { Ok(m) }
}

/// Moves a meeting. Links already given keep working at the new time.
pub async fn reschedule(k: &Kernel, tenant: Uuid, id: Uuid, starts_at: DateTime<Utc>, ends_at: DateTime<Utc>) -> Result<Meeting> {
    available(k, tenant).await?;
    if ends_at <= starts_at {
        return Err(MeetingError::Invalid("a meeting ends after it starts".into()));
    }
    open(k, tenant, id).await?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query("update comms_meeting set starts_at = $3, ends_at = $4 where tenant_id = $1 and id = $2")
        .bind(tenant)
        .bind(id)
        .bind(starts_at)
        .bind(ends_at)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    get(k, tenant, id).await
}

/// Ends a meeting: attendance is read one last time, everyone in the room is sent out and no link
/// admits anyone again. Ending an ended meeting changes nothing. The meeting is ended here even if
/// the meeting server cannot be reached (the log says so).
pub async fn end(k: &Kernel, tenant: Uuid, id: Uuid) -> Result<Meeting> {
    let m = get(k, tenant, id).await?;
    if m.ended_at.is_some() {
        return Ok(m);
    }
    if let Some(server) = meet::server() {
        if let Err(e) = record(k, tenant, &server, id).await {
            tracing::warn!(%tenant, meeting = %id, "attendance of an ended meeting was not read: {e}");
        }
        let room = meet::room_name(tenant, "room", id);
        if let Err(e) = twirp(k, &server, "RoomService", "DeleteRoom", json!({"room": room}), &room).await {
            tracing::warn!(%tenant, meeting = %id, "the meeting server did not close the room: {e}");
        }
    }
    let mut tx = k.db.tenant_tx(tenant).await?;
    sqlx::query("update comms_meeting set ended_at = now() where tenant_id = $1 and id = $2 and ended_at is null")
        .bind(tenant)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    get(k, tenant, id).await
}

/// Who was in the meeting and for how long, as read so far (see the module's note on accuracy).
pub async fn attendance(k: &Kernel, tenant: Uuid, id: Uuid) -> Result<Vec<Attendee>> {
    get(k, tenant, id).await?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let rows: Vec<(Option<Uuid>, Option<String>, String, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "select user_id, email, name, joined_at, last_seen from comms_attendance where tenant_id = $1 and room_id = $2 order by joined_at, identity",
    )
    .bind(tenant)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut people: Vec<Attendee> = vec![];
    let mut spans: Vec<Vec<(DateTime<Utc>, DateTime<Utc>)>> = vec![];
    for (user, email, name, joined, seen) in rows {
        let seen = seen.max(joined);
        match people.iter().position(|p| p.user == user && p.email == email) {
            Some(i) => {
                people[i].last_seen = people[i].last_seen.max(seen);
                people[i].joinings += 1;
                spans[i].push((joined, seen));
            }
            None => {
                people.push(Attendee { user, email, name, first_joined: joined, last_seen: seen, seconds: 0, joinings: 1 });
                spans.push(vec![(joined, seen)]);
            }
        }
    }
    for (p, mut s) in people.iter_mut().zip(spans) {
        // Time covered by at least one joining.
        s.sort();
        let mut covered = 0;
        let mut edge: Option<DateTime<Utc>> = None;
        for (from, to) in s {
            let from = edge.map_or(from, |e| from.max(e));
            if to > from {
                covered += (to - from).num_seconds();
                edge = Some(to);
            }
        }
        p.seconds = covered;
    }
    Ok(people)
}

/// Reads the room now and keeps who is in it (upkeep does this every minute while a meeting is on;
/// call it for a fresher answer from [`attendance`]).
pub async fn record_attendance(k: &Kernel, tenant: Uuid, id: Uuid) -> Result<()> {
    available(k, tenant).await?;
    get(k, tenant, id).await?;
    let server = meet::server().ok_or(MeetingError::NotConfigured)?;
    record(k, tenant, &server, id).await.map_err(MeetingError::Failed)
}

/// Who is in the room, as its identity names them: a member's is `{user}.{random}`, a guest's by
/// link is `guest.{hex of address}.{random}`; others are not Comms' to count.
fn who(identity: &str) -> Option<(Option<Uuid>, Option<String>)> {
    let parts: Vec<&str> = identity.split('.').collect();
    match parts.as_slice() {
        ["guest", email, _] => hex::decode(email).ok().and_then(|b| String::from_utf8(b).ok()).map(|e| (None, Some(e))),
        [user, _] => user.parse::<Uuid>().ok().map(|u| (Some(u), None)),
        _ => None,
    }
}

async fn record(k: &Kernel, tenant: Uuid, server: &Server, id: Uuid) -> ferrum_kernel::Result<()> {
    let room = meet::room_name(tenant, "room", id);
    let answer = twirp(k, server, "RoomService", "ListParticipants", json!({"room": room}), &room).await?;
    let now = Utc::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    for p in answer.get("participants").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let identity = p.get("identity").and_then(Value::as_str).unwrap_or_default();
        let Some((user, email)) = who(identity) else { continue };
        let name = p.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(identity);
        // LiveKit sends 64-bit numbers as strings (protojson) or numbers: seconds since 1970.
        let joined = p
            .get("joined_at")
            .or_else(|| p.get("joinedAt"))
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .and_then(|s| DateTime::from_timestamp(s, 0))
            .filter(|j| *j <= now)
            .unwrap_or(now);
        sqlx::query(
            "insert into comms_attendance (tenant_id, room_id, identity, user_id, email, name, joined_at, last_seen) values ($1, $2, $3, $4, $5, $6, $7, $8) \
             on conflict (tenant_id, room_id, identity) do update set last_seen = excluded.last_seen, name = excluded.name",
        )
        .bind(tenant)
        .bind(id)
        .bind(identity)
        .bind(user)
        .bind(email)
        .bind(name)
        .bind(joined)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// A short-lived token for LiveKit's room service, for one room.
fn admin_token(server: &Server, room: &str, now: i64) -> String {
    let claims =
        json!({"iss": server.key, "sub": "ferrum-comms", "nbf": now - 10, "exp": now + 600, "video": {"roomAdmin": true, "roomCreate": true, "room": room}});
    let unsigned = format!("{}.{}", URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#), URL_SAFE_NO_PAD.encode(claims.to_string()));
    let mut mac = Hmac::<Sha256>::new_from_slice(server.secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(unsigned.as_bytes());
    format!("{unsigned}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// One call to LiveKit's server API (Twirp, JSON).
async fn twirp(k: &Kernel, server: &Server, service: &str, method: &str, body: Value, room: &str) -> ferrum_kernel::Result<Value> {
    let url = format!("{}/twirp/livekit.{service}/{method}", meet::api_url(server));
    // The operator's own server, usually beside Ferrum: private addresses allowed.
    let (client, parsed) = k.vetted_client(&url, true, Wait::from_secs(20), "Ferrum Comms").await?;
    let unavailable = |e: String| Error::Unavailable(format!("the meeting server: {e}"));
    let res = client
        .post(parsed)
        .header("authorization", format!("Bearer {}", admin_token(server, room, Utc::now().timestamp())))
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

/// Reads the rooms of meetings that are on now, for [`crate::maintenance`].
pub(crate) async fn upkeep(k: &Kernel, tenant: Uuid) -> ferrum_kernel::Result<usize> {
    let Some(server) = meet::server() else { return Ok(0) };
    let now = Utc::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    let on: Vec<Uuid> = sqlx::query_scalar(
        "select id from comms_meeting where tenant_id = $1 and source_entity is not null and ended_at is null and starts_at <= $2 and ends_at >= $3",
    )
    .bind(tenant)
    .bind(now + Duration::minutes(EARLY_MINUTES))
    .bind(now - Duration::hours(GRACE))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut first = None;
    for id in &on {
        if let Err(e) = record(k, tenant, &server, *id).await {
            first.get_or_insert(e);
        }
    }
    first.map_or(Ok(on.len()), Err)
}

/// What meetings keep of a person: the times they were seen in a meeting another app made. They
/// are in the person's copy and go with their erasure; the calling app keeps what it recorded.
pub struct Attendance;

#[async_trait::async_trait]
impl ferrum_kernel::privacy::PersonalHeld for Attendance {
    fn app(&self) -> &'static str {
        "comms"
    }

    async fn report(&self, tx: &mut Tx, tenant: Uuid, account: Option<Uuid>, emails: &[String]) -> ferrum_kernel::Result<Vec<Value>> {
        let seen: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('meeting', room_id, 'joined_at', joined_at, 'last_seen', last_seen) from comms_attendance \
             where tenant_id = $1 and (user_id = $2 or lower(email) = any($3)) order by joined_at limit 10000",
        )
        .bind(tenant)
        .bind(account)
        .bind(emails.iter().map(|e| e.to_lowercase()).collect::<Vec<_>>())
        .fetch_all(&mut **tx)
        .await?;
        Ok(if seen.is_empty() { vec![] } else { vec![json!({"what": "When they were in meetings made by other apps", "times": seen})] })
    }

    async fn erase(&self, tx: &mut Tx, tenant: Uuid, account: Option<Uuid>, emails: &[String], _reason: &str) -> ferrum_kernel::Result<u64> {
        let gone = sqlx::query("delete from comms_attendance where tenant_id = $1 and (user_id = $2 or lower(email) = any($3))")
            .bind(tenant)
            .bind(account)
            .bind(emails.iter().map(|e| e.to_lowercase()).collect::<Vec<_>>())
            .execute(&mut **tx)
            .await?;
        Ok(gone.rows_affected())
    }
}
