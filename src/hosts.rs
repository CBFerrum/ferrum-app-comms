//! Meet's hosts and their controls. A call of a channel, an event or a room has a `Meeting` record, made the first
//! time a member joins, which the controls act on. Hosts are worked out, never stored: a room's creator, an event's
//! organizer, a channel's owners or a Chat Admin, either person of a direct conversation. Mute, Remove and End are
//! queued as a job in the action's transaction and carried out by the meeting server after the commit (tried again
//! when it cannot be reached), so a host's button and a host's agent do the same thing; nothing is called from inside
//! a transaction, and no stronger grant is put in anyone's pass.

use crate::meet::{self, room_name};
use crate::util::{self, s};
use async_trait::async_trait;
use ferrum_kernel::jobs::{Job, JobHandler, NewJob};
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result, Tx};
use serde_json::{Value, json};
use uuid::Uuid;

pub const COMMAND: &str = "comms.meet_command";
/// How long a removed person gets no new pass.
const DENIED_HOURS: i64 = 6;

/// The meeting record of a call (`kind` room, channel or event, `source` its id): its id and who may record. Made on
/// first use; two first joins at once make one (the unique room decides, the other reads it).
pub(crate) async fn ensure_meeting(k: &Kernel, tenant: Uuid, kind: &str, source: Uuid) -> Result<(Uuid, String)> {
    let room = room_name(tenant, kind, source);
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    for _ in 0..2 {
        let mut tx = k.db.tenant_tx(tenant).await?;
        let found: Option<(Uuid, Option<String>)> = sqlx::query_as("select id, recording_by from e_meeting where tenant_id = $1 and room = $2")
            .bind(tenant)
            .bind(&room)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some((id, by)) = found {
            tx.commit().await?;
            return Ok((id, by.unwrap_or_else(|| "Everyone".into())));
        }
        let doc = util::obj(json!({"room": room, "meeting_kind": kind, "source": source.to_string(), "recording_by": "Everyone"}));
        match k.insert_tx(&sys, &mut tx, "Meeting", doc).await {
            Ok(saved) => {
                tx.commit().await?;
                return Ok((util::doc_id(&saved)?, "Everyone".into()));
            }
            Err(Error::Conflict(_)) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(Error::Retryable("meeting".into()))
}

/// Whether `ctx` is a host of the call of `kind` / `source`, from the stored room, event or channel.
pub(crate) async fn is_host(k: &Kernel, tx: &mut Tx, ctx: &Ctx, kind: &str, source: Uuid) -> Result<bool> {
    Ok(match kind {
        "room" => {
            let by: Option<Option<Uuid>> = sqlx::query_scalar("select created_by from comms_meeting where tenant_id = $1 and id = $2")
                .bind(ctx.tenant)
                .bind(source)
                .fetch_optional(&mut **tx)
                .await?;
            by.flatten() == Some(ctx.user)
        }
        "event" => {
            let doc = k.get_tx(&util::sys(ctx), tx, "CalendarEvent", source, false).await.ok();
            doc.as_ref().and_then(|d| s(d, "owner")).is_some_and(|o| o.eq_ignore_ascii_case(&ctx.email))
        }
        "channel" => crate::chat::channel_host(tx, ctx, source).await?,
        _ => false,
    })
}

/// Who an identity is, for a denial: the identity without its last part (a member's user id, a named guest's
/// `guest.<address in hex>`).
fn who_of(identity: &str) -> &str {
    identity.rsplit_once('.').map_or(identity, |(who, _)| who)
}

/// Whether `who` was removed from `room` and may not come back yet.
pub(crate) async fn denied(tx: &mut Tx, tenant: Uuid, room: &str, who: &str) -> Result<bool> {
    Ok(sqlx::query_scalar("select exists (select 1 from comms_meeting_denied where tenant_id = $1 and room = $2 and who = $3 and until > now())")
        .bind(tenant)
        .bind(room)
        .bind(who)
        .fetch_one(&mut **tx)
        .await?)
}

/// Removals that have ended, for upkeep.
pub(crate) async fn purge(k: &Kernel, tenant: Uuid) -> Result<u64> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let n = sqlx::query("delete from comms_meeting_denied where tenant_id = $1 and until < now()").bind(tenant).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    Ok(n)
}

pub struct MeetingHook;

#[async_trait]
impl DocHook for MeetingHook {
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        if !matches!(name, "mute" | "remove" | "end" | "set_recording") {
            return Ok(None);
        }
        let kind = s(doc, "meeting_kind").unwrap_or_default().to_string();
        let source: Uuid = s(doc, "source").and_then(|v| v.parse().ok()).ok_or_else(|| Error::internal("a meeting without its source"))?;
        if !is_host(hc.kernel, hc.tx, hc.ctx, &kind, source).await? {
            return Err(Error::Forbidden("only a host of this meeting can do this".into()));
        }
        let meeting = util::doc_id(doc)?;
        let room = s(doc, "room").unwrap_or_default().to_string();
        if name == "set_recording" {
            let by = params
                .get("by")
                .and_then(Value::as_str)
                .filter(|b| matches!(*b, "Everyone" | "Hosts"))
                .ok_or_else(|| Error::field("by", "Everyone or Hosts"))?;
            hc.kernel.update_tx(&util::sys(hc.ctx), hc.tx, "Meeting", meeting, util::obj(json!({"recording_by": by})), None).await?;
            return Ok(Some(json!({"recording_by": by})));
        }
        let identity = if name == "end" {
            String::new()
        } else {
            let identity = params.get("identity").and_then(Value::as_str).unwrap_or_default();
            if identity.is_empty() || identity.len() > 120 || !identity.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
                return Err(Error::field("identity", "a participant's identity in the call"));
            }
            identity.to_string()
        };
        if name == "remove" {
            if who_of(&identity) == hc.ctx.user.simple().to_string() {
                return Err(Error::invalid("leave the meeting instead"));
            }
            sqlx::query(
                "insert into comms_meeting_denied (tenant_id, room, who, until, denied_by) values ($1, $2, $3, now() + make_interval(hours => $4), $5) \
                 on conflict (tenant_id, room, who) do update set until = excluded.until, denied_by = excluded.denied_by",
            )
            .bind(hc.ctx.tenant)
            .bind(&room)
            .bind(who_of(&identity))
            .bind(DENIED_HOURS as i32)
            .bind(hc.ctx.user)
            .execute(&mut **hc.tx)
            .await?;
        }
        let mut job = NewJob::new(COMMAND, json!({"room": room, "command": name, "identity": identity}));
        job.max_attempts = 5;
        ferrum_kernel::jobs::enqueue(hc.tx, hc.ctx.tenant, Some(hc.ctx.user), job).await?;
        Ok(Some(json!({"queued": true})))
    }
}

/// Carries out a host's command on the meeting server: each call is harmless twice, and a person or room that is gone
/// is done; a server that cannot be reached is tried again.
pub struct MeetCommand;

#[async_trait]
impl JobHandler for MeetCommand {
    fn kind(&self) -> &'static str {
        COMMAND
    }

    fn title(&self) -> &'static str {
        "Meeting control"
    }

    fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(120)
    }

    async fn run(&self, k: &Kernel, job: &Job) -> Result<Value> {
        let Ok(server) = meet::server(k).await else { return Ok(json!({"skipped": "no meeting server"})) };
        let p = &job.payload;
        let (room, command, identity) =
            (p["room"].as_str().unwrap_or_default(), p["command"].as_str().unwrap_or_default(), p["identity"].as_str().unwrap_or_default());
        let call = |method: &'static str, body: Value| crate::meetings::twirp(k, &server, "RoomService", method, body, room);
        let gone = |e: &Error| e.to_string().contains("not found") || e.to_string().contains("not_found");
        let done = match command {
            "mute" => match call("GetParticipant", json!({"room": room, "identity": identity})).await {
                Ok(person) => {
                    let mut muted = 0;
                    for track in person.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default() {
                        // TrackType AUDIO is the enum's first value: protojson may leave it out.
                        let audio = matches!(track.get("type"), None | Some(Value::Null)) || track["type"] == json!("AUDIO") || track["type"] == json!(0);
                        if audio && track["muted"] != json!(true) {
                            let body = json!({"room": room, "identity": identity, "track_sid": track["sid"], "muted": true});
                            match call("MutePublishedTrack", body).await {
                                Ok(_) => muted += 1,
                                Err(e) if gone(&e) => {}
                                Err(e) => return Err(e),
                            }
                        }
                    }
                    json!({"muted": muted})
                }
                Err(e) if gone(&e) => json!({"gone": true}),
                Err(e) => return Err(e),
            },
            "remove" => match call("RemoveParticipant", json!({"room": room, "identity": identity})).await {
                Ok(_) => json!({"removed": true}),
                Err(e) if gone(&e) => json!({"gone": true}),
                Err(e) => return Err(e),
            },
            "end" => match call("DeleteRoom", json!({"room": room})).await {
                Ok(_) => json!({"ended": true}),
                Err(e) if gone(&e) => json!({"gone": true}),
                Err(e) => return Err(e),
            },
            other => return Err(Error::invalid(format!("unknown meeting command {other}"))),
        };
        Ok(done)
    }
}
