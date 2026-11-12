//! Proposing another time for an event (iTIP COUNTER, RFC 5546 §3.2.7): a guest answers with the time
//! that suits them, from Calendar (`POST /calendar/events/{id}/propose`) or by mail (a COUNTER that
//! arrives is recorded by `itip.rs`, with the same sender checks as a REPLY). The organizer sees the
//! proposals on the event, and only they do; nothing moves until they accept (the event moves, or
//! for one occurrence of a series that occurrence becomes an event of its own, and the guests hear
//! of it as of any change) or decline (the guest is told: in the app, or by a DECLINECOUNTER mail).

use crate::calendar;
use crate::calendars::Level;
use crate::ics;
use crate::recur;
use crate::util::{self, s};
use chrono::{DateTime, Duration, Utc};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx, notify};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// A proposal as it is kept.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Proposal {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    /// The occurrence of a series it is for (its start); none for the whole event.
    pub occurrence: Option<DateTime<Utc>>,
    pub note: Option<String>,
}

/// A proposal made sense of: a positive length of at most two weeks, and for a repeating event an
/// occurrence that is one of its own.
pub(crate) fn checked(doc: &Doc, p: Proposal) -> Result<Proposal> {
    if p.end <= p.start || p.end - p.start > Duration::days(14) {
        return Err(Error::field("end", "the proposed time must end after it starts, within two weeks"));
    }
    let Some(sr) = calendar::series(doc) else { return Err(Error::NotFound("Event".into())) };
    let occurrence = match (sr.rule.is_some(), p.occurrence) {
        (false, _) | (true, None) => None,
        (true, Some(at)) => {
            let found = recur::occurrences(&sr, at - Duration::seconds(1), at + Duration::seconds(1)).into_iter().any(|(s, _)| s == at);
            if !found {
                return Err(Error::field("occurrence", "that is not one of this event's occurrences"));
            }
            Some(at)
        }
    };
    let note = p.note.map(|n| util::clean_line(&n, 500)).filter(|n| !n.is_empty());
    Ok(Proposal { occurrence, note, ..p })
}

/// Keeps a guest's proposal (replacing theirs for the same occurrence) and tells the organizer.
/// `Ok(false)` when they had proposed exactly this already.
pub(crate) async fn record(tx: &mut Tx, tenant: Uuid, doc: &Doc, email: &str, name: Option<&str>, p: &Proposal, by_mail: bool) -> Result<bool> {
    let event = util::doc_id(doc)?;
    let email = email.to_lowercase();
    let same: bool = sqlx::query_scalar(
        "select exists (select 1 from comms_event_proposal where tenant_id = $1 and event_id = $2 and email = $3 and occurrence is not distinct from $4 \
         and starts_at = $5 and ends_at = $6 and note is not distinct from $7)",
    )
    .bind(tenant)
    .bind(event)
    .bind(&email)
    .bind(p.occurrence)
    .bind(p.start)
    .bind(p.end)
    .bind(&p.note)
    .fetch_one(&mut **tx)
    .await?;
    if same {
        return Ok(false);
    }
    sqlx::query("delete from comms_event_proposal where tenant_id = $1 and event_id = $2 and email = $3 and occurrence is not distinct from $4")
        .bind(tenant)
        .bind(event)
        .bind(&email)
        .bind(p.occurrence)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "insert into comms_event_proposal (tenant_id, id, event_id, email, guest_name, starts_at, ends_at, occurrence, note, by_mail) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(tenant)
    .bind(Uuid::now_v7())
    .bind(event)
    .bind(&email)
    .bind(name)
    .bind(p.start)
    .bind(p.end)
    .bind(p.occurrence)
    .bind(&p.note)
    .bind(by_mail)
    .execute(&mut **tx)
    .await?;
    if let Some(owner) = s(doc, "owner")
        && let Some(user) = util::user_id(tx, tenant, owner).await?
    {
        let mut at = doc.clone();
        at.insert("starts_at".into(), json!(util::ts(p.start)));
        at.insert("ends_at".into(), json!(util::ts(p.end)));
        let who = name.filter(|n| !n.trim().is_empty()).unwrap_or(&email);
        let title = util::cut(&format!("{who} proposed a new time: {}", s(doc, "subject").unwrap_or_default()), 200);
        let body = match &p.note {
            Some(n) => format!("{} · {n}", calendar::when(&at)),
            None => calendar::when(&at),
        };
        notify::send_kind(tx, tenant, user, "comms.rsvp", "inapp", &title, Some(&body), Some("CalendarEvent"), Some(event)).await?;
    }
    Ok(true)
}

/// The proposals on an event, for its organizer.
pub(crate) async fn list(tx: &mut Tx, tenant: Uuid, event: Uuid) -> Result<Vec<Value>> {
    let rows: Vec<(Uuid, String, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "select id, email, guest_name, starts_at, ends_at, occurrence, note, created_at from comms_event_proposal \
         where tenant_id = $1 and event_id = $2 order by occurrence nulls first, created_at",
    )
    .bind(tenant)
    .bind(event)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, email, name, start, end, occurrence, note, at)| {
            json!({"id": id, "email": email, "name": name, "start": util::ts(start), "end": util::ts(end),
                "occurrence": occurrence.map(util::ts), "note": note, "created_at": util::ts(at)})
        })
        .collect())
}

/// The occurrences of these events that have a proposal (`None`: the whole event), for the organizer's calendar.
pub(crate) async fn pending(tx: &mut Tx, tenant: Uuid, events: &[Uuid]) -> Result<Vec<(Uuid, Option<DateTime<Utc>>)>> {
    if events.is_empty() {
        return Ok(vec![]);
    }
    Ok(sqlx::query_as("select distinct event_id, occurrence from comms_event_proposal where tenant_id = $1 and event_id = any($2)")
        .bind(tenant)
        .bind(events)
        .fetch_all(&mut **tx)
        .await?)
}

fn time(body: &Map<String, Value>, k: &str) -> Result<Option<DateTime<Utc>>> {
    match body.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) => util::parse_ts(v).map(Some).ok_or_else(|| Error::field(k, "an RFC 3339 date-time")),
    }
}

/// `POST /calendar/events/{id}/propose {start, end, occurrence?, note?}`: a guest's proposal.
pub(crate) async fn propose(k: &Kernel, ctx: &Ctx, event: Uuid, body: Map<String, Value>) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let (start, end) =
        (time(&body, "start")?.ok_or_else(|| Error::field("start", "is required"))?, time(&body, "end")?.ok_or_else(|| Error::field("end", "is required"))?);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(&util::sys(ctx), &mut tx, "CalendarEvent", event, true).await.map_err(|_| Error::NotFound("Event".into()))?;
    let guest = calendar::attendees(&doc).into_iter().find(|a| a.0 == me);
    let Some((_, name, _)) = guest else {
        return Err(if s(&doc, "owner").is_some_and(|o| o.eq_ignore_ascii_case(&me)) {
            Error::invalid("you organize this event: change its time instead")
        } else {
            Error::NotFound("Event".into())
        });
    };
    if s(&doc, "status") == Some("Cancelled") {
        return Err(Error::invalid("this event was cancelled"));
    }
    let p = checked(&doc, Proposal { start, end, occurrence: time(&body, "occurrence")?, note: body.get("note").and_then(Value::as_str).map(str::to_string) })?;
    let shown = if ctx.full_name.trim().is_empty() { name } else { Some(ctx.full_name.clone()) };
    record(&mut tx, ctx.tenant, &doc, &me, shown.as_deref(), &p, false).await?;
    tx.commit().await?;
    Ok(json!({"event": event, "start": util::ts(p.start), "end": util::ts(p.end), "occurrence": p.occurrence.map(util::ts)}))
}

/// `POST /calendar/events/{id}/proposals/{proposal} {action: accept|decline}`: the organizer's answer.
pub(crate) async fn decide(k: &Kernel, ctx: &Ctx, event: Uuid, proposal: Uuid, body: Map<String, Value>) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let action = body.get("action").and_then(Value::as_str).unwrap_or_default();
    if !["accept", "decline"].contains(&action) {
        return Err(Error::field("action", "accept or decline"));
    }
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(&util::sys(ctx), &mut tx, "CalendarEvent", event, true).await.map_err(|_| Error::NotFound("Event".into()))?;
    let shared = crate::calendars::shared_with(&mut tx, ctx.tenant, &me).await?;
    // The organizer only: proposals are theirs to see and answer.
    if crate::calendars::level(&me, &doc, &shared) != Level::Owner {
        return Err(Error::NotFound("Event".into()));
    }
    let row: Option<(String, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<DateTime<Utc>>, bool)> = sqlx::query_as(
        "select email, guest_name, starts_at, ends_at, occurrence, by_mail from comms_event_proposal where tenant_id = $1 and event_id = $2 and id = $3",
    )
    .bind(ctx.tenant)
    .bind(event)
    .bind(proposal)
    .fetch_optional(&mut *tx)
    .await?;
    let (email, _name, start, end, occurrence, by_mail) = row.ok_or_else(|| Error::NotFound("proposal".into()))?;
    let moved_to = if action == "accept" {
        let made = match occurrence {
            // The whole event moves: its guests are told of the new time as of any change.
            None => {
                let patch = util::obj(json!({"starts_at": util::ts(start), "ends_at": util::ts(end)}));
                k.update_tx(ctx, &mut tx, "CalendarEvent", event, patch, doc.get("version").and_then(Value::as_i64)).await?;
                event
            }
            // One occurrence: it leaves the series and becomes an event of its own at the new time.
            Some(at) => {
                let copy = detached(&doc, start, end);
                let made = util::doc_id(&k.insert_tx(ctx, &mut tx, "CalendarEvent", copy).await?)?;
                let mut skip: Vec<Value> = doc.get("recurrence_exceptions").and_then(Value::as_array).cloned().unwrap_or_default();
                skip.push(json!(util::ts(at)));
                k.update_tx(ctx, &mut tx, "CalendarEvent", event, util::obj(json!({"recurrence_exceptions": skip})), None).await?;
                made
            }
        };
        // Every proposal for what was moved is answered by the move.
        sqlx::query("delete from comms_event_proposal where tenant_id = $1 and event_id = $2 and occurrence is not distinct from $3")
            .bind(ctx.tenant)
            .bind(event)
            .bind(occurrence)
            .execute(&mut *tx)
            .await?;
        Some(made)
    } else {
        sqlx::query("delete from comms_event_proposal where tenant_id = $1 and id = $2").bind(ctx.tenant).bind(proposal).execute(&mut *tx).await?;
        let subject = s(&doc, "subject").unwrap_or("(no title)");
        match util::user_id(&mut tx, ctx.tenant, &email).await? {
            Some(user) => {
                let title = util::cut(&format!("Your proposed time was not taken: {subject}"), 200);
                notify::send_kind(
                    &mut tx,
                    ctx.tenant,
                    user,
                    "comms.invitation",
                    "inapp",
                    &title,
                    Some(&calendar::when(&doc)),
                    Some("CalendarEvent"),
                    Some(event),
                )
                .await?;
            }
            None if by_mail => decline_by_mail(k, &mut tx, ctx, &doc, &email).await?,
            None => {}
        }
        None
    };
    tx.commit().await?;
    Ok(json!({"action": action, "event": moved_to.unwrap_or(event)}))
}

/// The occurrence's event of its own: the series' details and guests (with their answers), at the new time.
fn detached(doc: &Doc, start: DateTime<Utc>, end: DateTime<Utc>) -> Doc {
    let mut out = Doc::new();
    for f in [
        "subject",
        "all_day",
        "timezone",
        "location",
        "meeting_link",
        "description",
        "visibility",
        "category",
        "color",
        "status",
        "calendar",
        "reference_entity",
        "reference_id",
    ] {
        if let Some(v) = doc.get(f).filter(|v| !v.is_null()) {
            out.insert(f.into(), v.clone());
        }
    }
    let guests: Vec<Value> = util::rows(doc, "attendees")
        .iter()
        .map(|a| json!({"email": a.get("email"), "attendee_name": a.get("attendee_name"), "response": a.get("response").cloned().unwrap_or(json!("Needs Action"))}))
        .collect();
    let reminders: Vec<Value> = util::rows(doc, "reminders").iter().map(|r| json!({"minutes_before": r.get("minutes_before")})).collect();
    out.insert("attendees".into(), Value::Array(guests));
    out.insert("reminders".into(), Value::Array(reminders));
    out.insert("starts_at".into(), json!(util::ts(start)));
    out.insert("ends_at".into(), json!(util::ts(end)));
    out
}

/// DECLINECOUNTER to a guest outside the workspace who proposed by mail: the event as it stands, and them.
async fn decline_by_mail(k: &Kernel, tx: &mut Tx, ctx: &Ctx, doc: &Doc, to: &str) -> Result<()> {
    let organizer = s(doc, "owner").map(str::to_lowercase).unwrap_or_default();
    let organizer_name = calendar::display_name(tx, ctx.tenant, &organizer).await?;
    let Some(mut ev) = calendar::vevent(doc, organizer_name, false, false) else { return Ok(()) };
    ev.attendees.retain(|a| a.email == to);
    let subject = s(doc, "subject").unwrap_or("(no title)");
    let e = util::html_escape;
    let html = format!("<p>Your proposed new time for <strong>{}</strong> was not taken. It stays at {}.</p>", e(subject), e(&calendar::when(doc)));
    let mail = util::obj(json!({
        "channel": "Email", "direction": "Sent", "subject": util::cut(&format!("New time not taken: {subject}"), 990), "recipients": to, "content": html,
        "reference_entity": "CalendarEvent", "reference_id": s(doc, "id"), "ics": ics::calendar(Some("DECLINECOUNTER"), None, &[ev]),
    }));
    k.insert_tx(&util::sys(ctx), tx, "Communication", mail).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proposal_is_a_real_time_and_names_a_real_occurrence() {
        let at = |v: &str| v.parse::<DateTime<Utc>>().unwrap();
        let weekly = util::obj(json!({"id": "0192d3b1-0000-7000-8000-000000000001", "starts_at": "2027-03-01T09:00:00Z", "ends_at": "2027-03-01T10:00:00Z",
            "timezone": "Europe/London", "recurrence": "FREQ=WEEKLY;COUNT=4"}));
        let p = |start: &str, end: &str, occ: Option<&str>| Proposal {
            start: at(start),
            end: at(end),
            occurrence: occ.map(at),
            note: Some("  Mondays are full \n".into()),
        };
        let ok = checked(&weekly, p("2027-03-09T09:00:00Z", "2027-03-09T10:00:00Z", Some("2027-03-08T09:00:00Z"))).unwrap();
        assert_eq!((ok.occurrence, ok.note.as_deref()), (Some(at("2027-03-08T09:00:00Z")), Some("Mondays are full")));
        assert!(checked(&weekly, p("2027-03-09T09:00:00Z", "2027-03-09T10:00:00Z", Some("2027-03-08T10:00:00Z"))).is_err(), "not an occurrence");
        assert!(checked(&weekly, p("2027-03-09T10:00:00Z", "2027-03-09T09:00:00Z", None)).is_err(), "ends before it starts");
        assert!(checked(&weekly, p("2027-03-09T10:00:00Z", "2027-04-09T09:00:00Z", None)).is_err(), "longer than two weeks");
        // After the clocks change (28 March) the London 09:00 is 08:00 UTC: that is the occurrence.
        assert!(checked(&weekly, p("2027-03-30T09:00:00Z", "2027-03-30T10:00:00Z", Some("2027-03-29T08:00:00Z"))).is_err(), "COUNT=4 ends on the 22nd");
        let single = util::obj(json!({"starts_at": "2027-03-01T09:00:00Z", "ends_at": "2027-03-01T10:00:00Z"}));
        assert_eq!(checked(&single, p("2027-03-02T09:00:00Z", "2027-03-02T10:00:00Z", Some("2027-03-01T09:00:00Z"))).unwrap().occurrence, None);
        let copy = detached(
            &util::obj(
                json!({"subject": "Sync", "calendar": "c1", "owner": "o@x", "recurrence": "FREQ=DAILY", "attendees": [{"email": "a@x", "response": "Accepted", "comment": "hi"}]}),
            ),
            at("2027-03-09T09:00:00Z"),
            at("2027-03-09T10:00:00Z"),
        );
        assert_eq!(copy["attendees"], json!([{"email": "a@x", "attendee_name": null, "response": "Accepted"}]));
        assert!(copy.get("recurrence").is_none() && copy.get("owner").is_none());
    }
}
