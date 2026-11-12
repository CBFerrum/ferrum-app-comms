//! Rooms and resources: a calendar marked as a room or a resource (a projector, a car), with a
//! capacity, where it is, the hours it may be booked and who may book it (everyone, or named people
//! and groups). Comms Managers keep them (`/calendar/rooms`). A room is added to an event like a
//! guest, by its address (`…@rooms.ferrum.invalid`: a reserved name no mail is ever sent to), and
//! answers at once, inside the transaction that saves the event: Accepted when it is free then,
//! inside its hours and the organizer may book it; Declined with the reason otherwise. The room's
//! row is locked while it answers, so two people booking it for the same time at once get one
//! Accepted and one Declined, never two Accepted.
//!
//! Everyone sees when a room is busy (free/busy and Find a time take its address like a person's);
//! those who may book it also see what each booking is and who made it, unless the event is "busy only".

use crate::calendar;
use crate::hours::Hours;
use crate::ics;
use crate::recur;
use crate::util::{self, s};
use chrono::{DateTime, Datelike, Duration, NaiveTime, Utc};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, SiteRequest, Tx};
use serde_json::{Map, Value, json};
use uuid::Uuid;

/// Where rooms' addresses live: `.invalid` is reserved (RFC 2606), so nothing is ever mailed there.
pub const DOMAIN: &str = "rooms.ferrum.invalid";
/// How far ahead a repeating booking is checked against others.
const HORIZON_DAYS: i64 = 400;

pub fn is_room(email: &str) -> bool {
    email.to_ascii_lowercase().ends_with(&format!("@{DOMAIN}"))
}

#[derive(Debug, Clone)]
pub(crate) struct Room {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub address: String,
    pub capacity: Option<i64>,
    pub place: Option<String>,
    pub hours: Option<Hours>,
    /// Who may book it: (person, group); empty is everyone.
    pub bookers: Vec<(Option<String>, Option<String>)>,
}

impl Room {
    fn json(&self, manager: bool, may_book: bool) -> Value {
        json!({"id": self.id, "name": self.name, "kind": self.kind, "address": self.address, "capacity": self.capacity, "place": self.place,
            "hours": self.hours.as_ref().map(Hours::public), "may_book": may_book, "everyone": self.bookers.is_empty(),
            "bookers": if manager { Value::Array(self.bookers.iter().map(|(p, g)| match g { Some(g) => json!({"role": g}), None => json!({"person": p}) }).collect()) } else { json!([]) }})
    }
}

/// Rooms and resources, all of them or those with these addresses.
pub(crate) async fn rooms(tx: &mut Tx, tenant: Uuid, only: Option<&[String]>) -> Result<Vec<Room>> {
    let rows: Vec<(Uuid, String, Option<String>, String, Option<i64>, Option<String>, Option<Value>, Value)> = sqlx::query_as(
        "select c.id, c.calendar_name, c.kind, c.owner, c.capacity, c.place, c.bookable, \
           (select coalesce(jsonb_agg(jsonb_build_object('person', b.person, 'role', b.role) order by b.idx), '[]') from e_calendar__bookers b \
            where b.tenant_id = c.tenant_id and b.parent_id = c.id) \
         from e_calendar c where c.tenant_id = $1 and c.kind in ('Room', 'Resource') and ($2::text[] is null or c.owner = any($2)) order by c.calendar_name",
    )
    .bind(tenant)
    .bind(only)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, kind, address, capacity, place, hours, bookers)| Room {
            id,
            name,
            kind: kind.unwrap_or_else(|| "Room".into()),
            address,
            capacity,
            place,
            hours: hours.and_then(|h| serde_json::from_value(h).ok()),
            bookers: bookers
                .as_array()
                .into_iter()
                .flatten()
                .map(|b| (b["person"].as_str().map(str::to_lowercase), b["role"].as_str().map(str::to_string)))
                .collect(),
        })
        .collect())
}

/// Whether `who` may book `room`: everyone may when it names nobody; else named, or in a named group now.
pub(crate) async fn may_book(tx: &mut Tx, tenant: Uuid, room: &Room, who: &str) -> Result<bool> {
    if room.bookers.is_empty() {
        return Ok(true);
    }
    let who = who.to_lowercase();
    if room.bookers.iter().any(|(p, _)| p.as_deref() == Some(who.as_str())) {
        return Ok(true);
    }
    let groups: Vec<String> = room.bookers.iter().filter_map(|(_, g)| g.clone()).collect();
    if groups.is_empty() {
        return Ok(false);
    }
    Ok(sqlx::query_scalar(
        "select exists (select 1 from user_role ur join app_user u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.is_active \
         where ur.tenant_id = $1 and lower(u.email::text) = $2 and ur.role = any($3) and (ur.expires_at is null or ur.expires_at > now()))",
    )
    .bind(tenant)
    .bind(&who)
    .bind(&groups)
    .fetch_one(&mut **tx)
    .await?)
}

fn clock(v: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(v.trim(), "%H:%M").ok()
}

/// Whether an occurrence is inside bookable hours: on one of its days, between its times, in its zone.
pub(crate) fn within(h: &Hours, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
    let zone = h.timezone.as_deref().and_then(ics::zone);
    let (a, b) = (recur::wall(start, zone), recur::wall(end, zone));
    let (Some(from), Some(to)) = (clock(&h.from), clock(&h.to)) else { return true };
    a.date() == b.date() && h.days.contains(&(a.weekday().num_days_from_sunday() as u8)) && a.time() >= from && b.time() <= to
}

/// "Mon–Fri 08:00–18:00 (Europe/London)", for a reason.
fn hours_words(h: &Hours) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let days: Vec<&str> = h.days.iter().filter_map(|d| DAYS.get(*d as usize).copied()).collect();
    format!("{} {}–{}{}", days.join(", "), h.from, h.to, h.timezone.as_deref().map(|z| format!(" ({z})")).unwrap_or_default())
}

/// "Tue 9 Mar 2027, 09:30 (Europe/London)": a moment on the room's clock (UTC when it has none).
fn moment(room: &Room, at: DateTime<Utc>) -> String {
    match room.hours.as_ref().and_then(|h| h.timezone.as_deref()).and_then(ics::zone) {
        Some(z) => format!("{} ({})", at.with_timezone(&z).format("%a %-d %b %Y, %H:%M"), z.name()),
        None => format!("{} (UTC)", at.format("%a %-d %b %Y, %H:%M")),
    }
}

/// The occurrences of an event a booking covers (a repeating one up to [`HORIZON_DAYS`] on).
fn covered(doc: &Doc) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let Some(sr) = calendar::series(doc) else { return vec![] };
    let (from, to) = (sr.start, sr.start + Duration::days(HORIZON_DAYS));
    recur::occurrences(&sr, from, to).into_iter().take(1000).collect()
}

/// Before an event is saved: every room or resource on it answers (in this transaction, its row locked).
pub(crate) async fn answer(tx: &mut Tx, tenant: Uuid, doc: &mut Doc) -> Result<()> {
    let wanted: Vec<String> = calendar::attendees(doc).into_iter().map(|a| a.0).filter(|e| is_room(e)).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let organizer = s(doc, "owner").unwrap_or_default().to_lowercase();
    let event = util::id(doc, "id");
    let cancelled = s(doc, "status") == Some("Cancelled");
    let mine = covered(doc);
    let list = rooms(tx, tenant, Some(&wanted)).await?;
    let mut answers: Vec<(String, &'static str, Option<String>)> = Vec::new();
    for room in &list {
        // One booking of this room at a time: the second waits here for the first to commit.
        sqlx::query("select 1 from e_calendar where tenant_id = $1 and id = $2 for update").bind(tenant).bind(room.id).execute(&mut **tx).await?;
        let reason = if cancelled {
            None
        } else if !may_book(tx, tenant, room, &organizer).await? {
            Some(format!("{} may not book {}", if organizer.is_empty() { "the organizer" } else { &organizer }, room.name))
        } else if let Some(h) = room.hours.as_ref().filter(|h| mine.iter().any(|(a, b)| !within(h, *a, *b))) {
            Some(format!("outside the hours it can be booked: {}", hours_words(h)))
        } else {
            clash(tx, tenant, room, event, &mine).await?.map(|at| format!("already booked at {}", moment(room, at)))
        };
        answers.push((room.address.clone(), if reason.is_none() { "Accepted" } else { "Declined" }, reason));
    }
    if let Some(Value::Array(rows)) = doc.get_mut("attendees") {
        for r in rows.iter_mut().filter_map(Value::as_object_mut) {
            let email = s(r, "email").unwrap_or_default().to_lowercase();
            if let Some((_, response, reason)) = answers.iter().find(|a| a.0 == email) {
                r.insert("response".into(), json!(response));
                r.insert("comment".into(), json!(reason.as_ref().map(|x| util::cut(x, 500))));
                if let Some(room) = list.iter().find(|x| x.address == email) {
                    r.insert("attendee_name".into(), json!(room.name));
                }
            } else if is_room(&email) {
                // Not a room (any more): it cannot come.
                r.insert("response".into(), json!("Declined"));
                r.insert("comment".into(), json!("there is no such room"));
            }
        }
    }
    Ok(())
}

/// The first of `mine` that another accepted booking of the room overlaps.
async fn clash(tx: &mut Tx, tenant: Uuid, room: &Room, event: Option<Uuid>, mine: &[(DateTime<Utc>, DateTime<Utc>)]) -> Result<Option<DateTime<Utc>>> {
    let (Some(first), Some(last)) = (mine.iter().map(|m| m.0).min(), mine.iter().map(|m| m.1).max()) else { return Ok(None) };
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(e) from e_calendar_event e where e.tenant_id = $1 and e.status <> 'Cancelled' and ($2::uuid is null or e.id <> $2) \
         and e.starts_at < $4 and (e.recurrence is not null or e.ends_at > $3) \
         and exists (select 1 from {} a where a.tenant_id = e.tenant_id and a.parent_id = e.id and a.email = $5 and a.response = 'Accepted')",
        calendar::ATTENDEES
    )))
    .bind(tenant)
    .bind(event)
    .bind(first)
    .bind(last)
    .bind(&room.address)
    .fetch_all(&mut **tx)
    .await?;
    for other in rows.into_iter().map(|v| calendar::normalize(util::obj(v))) {
        let Some(sr) = calendar::series(&other) else { continue };
        for (a, b) in recur::occurrences(&sr, first, last) {
            if let Some((at, _)) = mine.iter().find(|(x, y)| *x < b && a < *y) {
                return Ok(Some(*at));
            }
        }
    }
    Ok(None)
}

fn manager(ctx: &Ctx) -> bool {
    ctx.is_admin || ctx.roles.iter().any(|r| r == "Comms Manager")
}

/// A room's fields as a Comms Manager sent them, checked.
fn fields(body: &Map<String, Value>, creating: bool) -> Result<Doc> {
    let mut doc = Doc::new();
    match body.get("name").and_then(Value::as_str).map(str::trim) {
        Some("") => return Err(Error::field("name", "give it a name")),
        Some(n) => {
            doc.insert("calendar_name".into(), json!(util::cut(n, 100)));
        }
        None if creating => return Err(Error::field("name", "give it a name")),
        None => {}
    }
    if let Some(k) = body.get("kind").and_then(Value::as_str) {
        if !["Room", "Resource"].contains(&k) {
            return Err(Error::field("kind", "Room or Resource"));
        }
        doc.insert("kind".into(), json!(k));
    }
    if let Some(c) = body.get("capacity") {
        match c {
            Value::Null => doc.insert("capacity".into(), Value::Null),
            v => match v.as_i64().filter(|n| (1..=10_000).contains(n)) {
                Some(n) => doc.insert("capacity".into(), json!(n)),
                None => return Err(Error::field("capacity", "a number of people, 1 or more")),
            },
        };
    }
    if let Some(p) = body.get("place") {
        doc.insert("place".into(), json!(p.as_str().map(|p| util::cut(p.trim(), 200)).filter(|p| !p.is_empty())));
    }
    if let Some(h) = body.get("hours") {
        let hours = match h {
            Value::Null => Value::Null,
            Value::Object(m) => {
                let mut m = m.clone();
                for k in ["away_from", "away_to", "away_message"] {
                    m.entry(k).or_insert(Value::Null);
                }
                m.entry("away_decline").or_insert(json!(false));
                serde_json::to_value(Hours::from_body(&m)?).unwrap_or_default()
            }
            _ => return Err(Error::field("hours", "{days, from, to, timezone} or null for any time")),
        };
        doc.insert("bookable".into(), hours);
    }
    if let Some(list) = body.get("bookers") {
        let list = list.as_array().ok_or_else(|| Error::field("bookers", "a list of {person} or {role}"))?;
        let mut rows = Vec::new();
        for b in list {
            match (b.get("person").and_then(Value::as_str), b.get("role").and_then(Value::as_str)) {
                (_, Some(g)) if !g.trim().is_empty() => rows.push(json!({"role": g.trim()})),
                (Some(p), _) if p.contains('@') => rows.push(json!({"person": p.trim().to_lowercase()})),
                _ => return Err(Error::field("bookers", "each names a person by email, or a group")),
            }
        }
        doc.insert("bookers".into(), Value::Array(rows));
    }
    Ok(doc)
}

/// A room's address: its name in letters and digits, and a short random part.
fn address(name: &str) -> String {
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let slug = slug.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let slug = if slug.is_empty() { "room".to_string() } else { util::cut(&slug, 40) };
    format!("{slug}-{}@{DOMAIN}", &Uuid::now_v7().simple().to_string()[24..])
}

/// `GET|POST /calendar/rooms`, `PATCH|DELETE /calendar/rooms/{id}`, `GET /calendar/rooms/suggest`, `GET /calendar/rooms/{id}/events`.
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let out = match (req.method.as_str(), path) {
        ("GET", []) => {
            let mut out = Vec::new();
            for r in rooms(&mut tx, ctx.tenant, None).await? {
                let may = may_book(&mut tx, ctx.tenant, &r, &me).await?;
                out.push(r.json(manager(ctx), may));
            }
            json!({"rooms": out, "manager": manager(ctx)})
        }
        ("GET", ["suggest"]) => suggest(&mut tx, ctx, req).await?,
        ("GET", [id, "events"]) => schedule(&mut tx, ctx, id.parse().map_err(|_| Error::NotFound("room".into()))?, req).await?,
        (m, rest) if ["POST", "PATCH", "DELETE"].contains(&m) => {
            if !manager(ctx) {
                return Err(Error::Forbidden("rooms and resources are kept by Comms Managers".into()));
            }
            let sys = util::sys(ctx);
            match (m, rest) {
                ("POST", []) => {
                    let body = util::body_json(req)?;
                    let mut doc = fields(&body, true)?;
                    let name = s(&doc, "calendar_name").unwrap_or("room").to_string();
                    doc.entry("kind").or_insert(json!("Room"));
                    doc.insert("owner".into(), json!(address(&name)));
                    doc.insert("tone".into(), json!("neutral"));
                    let made = k.insert_tx(&sys, &mut tx, "Calendar", doc).await?;
                    let id = util::doc_id(&made)?;
                    let r = rooms(&mut tx, ctx.tenant, None).await?.into_iter().find(|r| r.id == id).ok_or_else(|| Error::NotFound("room".into()))?;
                    r.json(true, true)
                }
                ("PATCH", [id]) => {
                    let id: Uuid = id.parse().map_err(|_| Error::NotFound("room".into()))?;
                    rooms(&mut tx, ctx.tenant, None).await?.into_iter().find(|r| r.id == id).ok_or_else(|| Error::NotFound("room".into()))?;
                    let doc = fields(&util::body_json(req)?, false)?;
                    k.update_tx(&sys, &mut tx, "Calendar", id, doc, None).await?;
                    let r = rooms(&mut tx, ctx.tenant, None).await?.into_iter().find(|r| r.id == id).ok_or_else(|| Error::NotFound("room".into()))?;
                    r.json(true, true)
                }
                ("DELETE", [id]) => {
                    let id: Uuid = id.parse().map_err(|_| Error::NotFound("room".into()))?;
                    rooms(&mut tx, ctx.tenant, None).await?.into_iter().find(|r| r.id == id).ok_or_else(|| Error::NotFound("room".into()))?;
                    // Its bookings stay on their events; it answers no more (a room that is gone declines).
                    k.delete_tx(&sys, &mut tx, "Calendar", id, None).await?;
                    json!({"deleted": id})
                }
                _ => return Err(Error::NotFound("calendar endpoint".into())),
            }
        }
        _ => return Err(Error::NotFound("calendar endpoint".into())),
    };
    tx.commit().await?;
    Ok(out)
}

fn range(req: &SiteRequest) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let at = |k: &str| util::param(req, k).and_then(util::parse_ts).ok_or_else(|| Error::field(k, "an RFC 3339 date-time"));
    let (from, to) = (at("from")?, at("to")?);
    if to <= from || to - from > Duration::days(62) {
        return Err(Error::invalid("the range must be positive and at most 62 days"));
    }
    Ok((from, to))
}

/// `GET /calendar/rooms/suggest?from=&to=&people=`: rooms I may book, free then, inside their hours,
/// with room for that many (resources, which hold nobody, are left out), smallest first.
async fn suggest(tx: &mut Tx, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let (from, to) = range(req)?;
    let people: i64 = util::param(req, "people").and_then(|p| p.parse().ok()).unwrap_or(1).max(1);
    let exclude: Option<Uuid> = util::param(req, "exclude").and_then(|e| e.parse().ok());
    let me = ctx.email.to_lowercase();
    let mut out = Vec::new();
    for r in rooms(tx, ctx.tenant, None).await? {
        if r.kind != "Room" || r.capacity.is_some_and(|c| c < people) || !may_book(tx, ctx.tenant, &r, &me).await? {
            continue;
        }
        if r.hours.as_ref().is_some_and(|h| !within(h, from, to)) {
            continue;
        }
        if clash(tx, ctx.tenant, &r, exclude, &[(from, to)]).await?.is_some() {
            continue;
        }
        out.push(r.json(false, true));
    }
    out.sort_by_key(|r| r["capacity"].as_i64().unwrap_or(i64::MAX));
    Ok(json!({"rooms": out}))
}

/// `GET /calendar/rooms/{id}/events?from=&to=`: the room's bookings. Everyone sees when; those who
/// may book it also what and by whom (not for a "busy only" event).
async fn schedule(tx: &mut Tx, ctx: &Ctx, id: Uuid, req: &SiteRequest) -> Result<Value> {
    let (from, to) = range(req)?;
    let room = rooms(tx, ctx.tenant, None).await?.into_iter().find(|r| r.id == id).ok_or_else(|| Error::NotFound("room".into()))?;
    let details = may_book(tx, ctx.tenant, &room, &ctx.email).await?;
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(e) from e_calendar_event e where e.tenant_id = $1 and e.status <> 'Cancelled' and e.starts_at < $3 \
         and (e.recurrence is not null or e.ends_at > $2) and exists (select 1 from {} a where a.tenant_id = e.tenant_id and a.parent_id = e.id \
         and a.email = $4 and a.response = 'Accepted') order by e.starts_at limit 2000",
        calendar::ATTENDEES
    )))
    .bind(ctx.tenant)
    .bind(from)
    .bind(to)
    .bind(&room.address)
    .fetch_all(&mut **tx)
    .await?;
    let mut out = Vec::new();
    for doc in rows.into_iter().map(|v| calendar::normalize(util::obj(v))) {
        let Some(sr) = calendar::series(&doc) else { continue };
        let shown = details && s(&doc, "visibility") != Some(crate::calendars::BUSY_ONLY);
        for (a, b) in recur::occurrences(&sr, from, to) {
            out.push(if shown {
                json!({"start": util::ts(a), "end": util::ts(b), "subject": doc.get("subject"), "owner": doc.get("owner")})
            } else {
                json!({"start": util::ts(a), "end": util::ts(b), "subject": "Busy"})
            });
        }
    }
    out.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
    Ok(json!({"room": room.json(manager(ctx), details), "bookings": out}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookable_hours_are_read_on_the_rooms_clock() {
        let h = Hours { days: vec![1, 2, 3, 4, 5], from: "08:00".into(), to: "18:00".into(), timezone: Some("Europe/London".into()), ..Hours::default() };
        let t = |v: &str| v.parse::<DateTime<Utc>>().unwrap();
        // Monday 15 March 2027, 09:00–10:00 London is 09:00 UTC (clocks change on the 28th).
        assert!(within(&h, t("2027-03-15T09:00:00Z"), t("2027-03-15T10:00:00Z")));
        assert!(!within(&h, t("2027-03-15T17:30:00Z"), t("2027-03-15T18:30:00Z")), "past six");
        assert!(!within(&h, t("2027-03-13T09:00:00Z"), t("2027-03-13T10:00:00Z")), "a Saturday");
        // After the change of clocks 07:30 UTC is 08:30 in London: inside.
        assert!(within(&h, t("2027-03-29T07:30:00Z"), t("2027-03-29T08:30:00Z")));
        assert!(!within(&h, t("2027-03-15T09:00:00Z"), t("2027-03-16T10:00:00Z")), "over two days");
        assert_eq!(hours_words(&h), "Mon, Tue, Wed, Thu, Fri 08:00–18:00 (Europe/London)");
        assert!(is_room("Board-1a2b@rooms.ferrum.invalid") && !is_room("ana@acme.test"));
        let a = address("Board room (3rd floor)");
        assert!(a.starts_with("board-room-3rd-floor-") && a.ends_with("@rooms.ferrum.invalid"), "{a}");
        assert!(fields(&util::obj(json!({"name": "A", "capacity": 0})), true).is_err());
        assert!(fields(&util::obj(json!({"name": "A", "kind": "Car"})), true).is_err());
        let f = fields(&util::obj(json!({"name": "A", "hours": {"days": [1], "from": "09:00", "to": "17:00", "timezone": "Europe/London"}, "bookers": [{"role": "Sales"}, {"person": "Bo@x.test"}]})), true).unwrap();
        assert_eq!(f["bookers"], json!([{"role": "Sales"}, {"person": "bo@x.test"}]));
        assert_eq!(f["bookable"]["from"], json!("09:00"));
    }
}
