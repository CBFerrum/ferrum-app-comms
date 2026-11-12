//! Calendar: events with attendees — colleagues (matched by sign-in email) are notified in the
//! app, outside guests get invitation emails carrying an iCalendar REQUEST (CANCEL when the event
//! is cancelled or deleted) — recurrence, reminders (in-app, once per occurrence), my calendar
//! for a range, free/busy, RSVP, a personal ICS feed and ICS import. Times are UTC.

use crate::calendars::Level;
use crate::ics::{self, Attendee, VEvent};
use crate::recur::{self, Exception, Series};
use crate::util::{self, b, id, int, rows, s};
use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use ferrum_kernel::{Action, Ctx, Doc, DocHook, Error, FieldError, HookCtx, Kernel, Result, SiteRequest, SiteResponse, Tx, notify};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(crate) const ATTENDEES: &str = "e_calendar_event__attendees";
pub(crate) const REMINDERS: &str = "e_calendar_event__reminders";
/// Changing one of these is a new version of the invitation (SEQUENCE + 1).
const SIGNIFICANT: &[&str] =
    &["subject", "starts_at", "ends_at", "all_day", "timezone", "location", "meeting_link", "recurrence", "recurrence_exceptions", "status", "description"];
const MAX_RANGE_DAYS: i64 = 400;
const MAX_REMINDER_MINUTES: i64 = 40_320;

/// The event's occurrence pattern (an invalid stored rule repeats nothing).
pub fn series(doc: &Doc) -> Option<Series> {
    let start = util::time(doc, "starts_at")?;
    let end = util::time(doc, "ends_at").unwrap_or(start).max(start);
    let rule = s(doc, "recurrence").and_then(|r| recur::parse(r).ok());
    let exceptions = doc
        .get("recurrence_exceptions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).filter_map(|x| Exception::parse(x).ok()).collect())
        .unwrap_or_default();
    // All-day events are dates (UTC midnights); timed ones repeat at their wall-clock time.
    let zone = if b(doc, "all_day") { None } else { s(doc, "timezone").and_then(ics::zone) };
    Some(Series { start, end, rule, exceptions, zone })
}

fn lower(v: Option<&str>) -> String {
    v.unwrap_or_default().trim().to_lowercase()
}

pub(crate) fn attendees(doc: &Doc) -> Vec<(String, Option<String>, String)> {
    rows(doc, "attendees")
        .iter()
        .filter_map(|r| {
            Some((s(r, "email")?.to_lowercase(), s(r, "attendee_name").map(str::to_string), s(r, "response").unwrap_or("Needs Action").to_string()))
        })
        .collect()
}

fn partstat(response: &str) -> String {
    match response {
        "Accepted" => "ACCEPTED",
        "Declined" => "DECLINED",
        "Tentative" => "TENTATIVE",
        _ => "NEEDS-ACTION",
    }
    .into()
}

/// "Mon 2 Nov 2026, 09:00–10:00 (Asia/Kolkata)", in the event's time zone when it has one.
pub fn when(doc: &Doc) -> String {
    let (Some(start), end) = (util::time(doc, "starts_at"), util::time(doc, "ends_at")) else { return String::new() };
    let end = end.unwrap_or(start);
    let tz = s(doc, "timezone").and_then(ics::zone);
    let label = tz.map(|z| z.name().to_string()).unwrap_or_else(|| "UTC".into());
    if b(doc, "all_day") {
        let last = (end - Duration::days(1)).max(start);
        return if last.date_naive() == start.date_naive() {
            format!("{} (all day)", start.format("%a %-d %b %Y"))
        } else {
            format!("{} – {} (all day)", start.format("%a %-d %b %Y"), last.format("%a %-d %b %Y"))
        };
    }
    let fmt = |t: DateTime<Utc>, f: &str| match tz {
        Some(z) => t.with_timezone(&z).format(f).to_string(),
        None => t.format(f).to_string(),
    };
    let same_day = fmt(start, "%F") == fmt(end, "%F");
    let tail = if same_day { fmt(end, "%H:%M") } else { fmt(end, "%a %-d %b %Y, %H:%M") };
    format!("{}–{tail} ({label})", fmt(start, "%a %-d %b %Y, %H:%M"))
}

pub(crate) async fn display_name(tx: &mut Tx, tenant: Uuid, email: &str) -> Result<Option<String>> {
    Ok(util::users(tx, tenant, &[email.to_string()]).await?.into_iter().next().map(|u| u.full_name).filter(|n| !n.trim().is_empty()))
}

/// The event as an iCalendar VEVENT.
pub fn vevent(doc: &Doc, organizer_name: Option<String>, cancelled: bool, alarms: bool) -> Option<VEvent> {
    let sr = series(doc)?;
    let status = if cancelled || s(doc, "status") == Some("Cancelled") {
        "CANCELLED"
    } else if s(doc, "status") == Some("Tentative") {
        "TENTATIVE"
    } else {
        "CONFIRMED"
    };
    Some(VEvent {
        uid: s(doc, "ical_uid").map(str::to_string).unwrap_or_else(|| format!("{}@ferrum", s(doc, "id").unwrap_or_default())),
        sequence: int(doc, "sequence"),
        stamp: util::now(),
        start: sr.start,
        end: sr.end,
        all_day: b(doc, "all_day"),
        summary: s(doc, "subject").unwrap_or("(no title)").to_string(),
        description: s(doc, "description").map(str::to_string),
        location: s(doc, "location").map(str::to_string),
        url: s(doc, "meeting_link").map(str::to_string),
        status: status.into(),
        private: s(doc, "visibility") != Some("Public"),
        categories: s(doc, "category").map(str::to_string),
        // A repeating timed event is written in its zone (DTSTART;TZID=), so other calendars
        // repeat it at the same wall-clock time as Ferrum does.
        tzid: sr.zone.filter(|_| sr.rule.is_some()),
        rrule: sr.rule.as_ref().map(|r| r.exported(sr.zone, b(doc, "all_day")).to_string()),
        exceptions: sr.exceptions.iter().map(|x| sr.excluded(x).map(Exception::At).unwrap_or(*x)).collect(),
        organizer: s(doc, "owner").map(|o| (organizer_name, o.to_string())),
        attendees: attendees(doc).into_iter().map(|(email, name, response)| Attendee { email, name, partstat: partstat(&response) }).collect(),
        alarms: if alarms { rows(doc, "reminders").iter().map(|r| int(r, "minutes_before")).collect() } else { vec![] },
    })
}

/// Queues an invitation (REQUEST) or cancellation (CANCEL) email to one outside guest.
async fn queue_invitation(hc: &mut HookCtx<'_>, doc: &Doc, to: &str, method: &str, updated: bool) -> Result<()> {
    let organizer = s(doc, "owner").map(str::to_string);
    let organizer_name = match &organizer {
        Some(o) => display_name(hc.tx, hc.ctx.tenant, o).await?,
        None => None,
    };
    let Some(mut ev) = vevent(doc, organizer_name.clone(), method == "CANCEL", false) else { return Ok(()) };
    // The event's meeting here: this guest's own link to it, as they cannot sign in.
    let mut join = s(doc, "meeting_link").map(str::to_string);
    if method != "CANCEL"
        && let (Some(link), Some(event)) = (&join, util::id(doc, "id"))
        && let Some(own) = crate::meet::invitation_link(hc.kernel, hc.tx, hc.ctx.tenant, event, link, to).await?
    {
        ev.url = Some(own.clone());
        join = Some(own);
    }
    let subject = s(doc, "subject").unwrap_or("(no title)");
    let when = when(doc);
    let title = match (method, updated) {
        ("CANCEL", _) => format!("Cancelled: {subject} @ {when}"),
        (_, true) => format!("Updated invitation: {subject} @ {when}"),
        _ => format!("Invitation: {subject} @ {when}"),
    };
    let e = util::html_escape;
    let mut html = format!("<p><strong>{}</strong></p><p>{}</p>", e(subject), e(&when));
    if let Some(l) = s(doc, "location") {
        html.push_str(&format!("<p>Where: {}</p>", e(l)));
    }
    if let Some(l) = &join {
        html.push_str(&format!("<p>Join: <a href=\"{0}\">{0}</a></p>", e(l)));
    }
    // Someone outside the workspace answers from the invitation itself, with no account.
    if method != "CANCEL"
        && let Some(base) = answer_link(hc.kernel, hc.tx, hc.ctx.tenant, doc, to).await?
    {
        html.push_str(&format!(
            "<p>Will you come? <a href=\"{0}?r=yes\">Yes</a> · <a href=\"{0}?r=maybe\">Maybe</a> · <a href=\"{0}?r=no\">No</a></p>",
            e(&base)
        ));
    }
    if let Some(d) = s(doc, "description") {
        html.push_str(&format!("<p>{}</p>", e(d).replace('\n', "<br>")));
    }
    if let Some(o) = &organizer {
        html.push_str(&format!("<p>Organizer: {} &lt;{}&gt;</p>", e(organizer_name.as_deref().unwrap_or(o)), e(o)));
    }
    if method == "CANCEL" {
        html.push_str("<p>This event was cancelled.</p>");
    }
    let mail = util::obj(json!({
        "channel": "Email",
        "direction": "Sent",
        "subject": util::cut(&title, 990),
        "recipients": to,
        "content": html,
        "reference_entity": "CalendarEvent",
        "reference_id": s(doc, "id"),
        "ics": ics::calendar(Some(method), None, &[ev]),
    }));
    hc.kernel.insert_tx(&util::sys(hc.ctx), hc.tx, "Communication", mail).await?;
    Ok(())
}

pub struct EventHook;

fn is_organizer(ctx: &Ctx, doc: &Doc) -> bool {
    ctx.is_system || ctx.is_admin || lower(s(doc, "owner")) == ctx.email.to_lowercase()
}

#[async_trait]
impl DocHook for EventHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let event = id(doc, "id");
        // Canonical forms first, so an unchanged event never looks changed.
        if b(doc, "all_day")
            && let Some(start) = util::time(doc, "starts_at")
        {
            let day = start.date_naive();
            let end = util::time(doc, "ends_at").map(|e| {
                let d = e.date_naive();
                if e.time() == chrono::NaiveTime::MIN { d } else { d + Duration::days(1) }
            });
            let end = end.filter(|e| *e > day).unwrap_or(day + Duration::days(1));
            doc.insert("starts_at".into(), json!(util::ts(day.and_time(chrono::NaiveTime::MIN).and_utc())));
            doc.insert("ends_at".into(), json!(util::ts(end.and_time(chrono::NaiveTime::MIN).and_utc())));
        }
        if let Some(rule) = s(doc, "recurrence").and_then(|r| recur::parse(r).ok()) {
            doc.insert("recurrence".into(), json!(rule.to_string()));
        }
        if !doc.contains_key("created_at") {
            if (s(doc, "owner").is_none() || !hc.ctx.is_system) && !hc.ctx.user.is_nil() {
                doc.insert("owner".into(), json!(hc.ctx.email.to_lowercase()));
            }
            if s(doc, "ical_uid").is_none() || !hc.ctx.is_system {
                doc.insert("ical_uid".into(), json!(event.map(|i| format!("{i}@ferrum"))));
            }
            if !hc.ctx.is_system {
                doc.insert("sequence".into(), json!(0));
            }
        } else if let Some(event) = event
            && let Ok(old) = hc.kernel.get_tx(&util::sys(hc.ctx), hc.tx, "CalendarEvent", event, false).await
            && SIGNIFICANT.iter().any(|f| old.get(*f) != doc.get(*f))
        {
            // What attendees see changed: a new version of the invitation.
            doc.insert("sequence".into(), json!(int(&old, "sequence") + 1));
        }
        // Every event is in one of its organizer's calendars.
        crate::calendars::place_event(hc.kernel, hc.tx, hc.ctx, doc).await?;
        // Guests away then who chose so decline at once, with their message.
        crate::hours::decline_away(hc.tx, hc.ctx.tenant, doc).await?;
        let missing: Vec<String> = attendees(doc).into_iter().filter(|a| a.1.is_none()).map(|a| a.0).collect();
        if !missing.is_empty() {
            let names: BTreeMap<String, String> = util::users(hc.tx, hc.ctx.tenant, &missing).await?.into_iter().map(|u| (u.email, u.full_name)).collect();
            if let Some(Value::Array(list)) = doc.get_mut("attendees") {
                for r in list.iter_mut().filter_map(Value::as_object_mut) {
                    if s(r, "attendee_name").is_none()
                        && let Some(n) = s(r, "email").and_then(|e| names.get(&e.to_lowercase())).filter(|n| !n.trim().is_empty())
                    {
                        r.insert("attendee_name".into(), json!(n));
                    }
                }
            }
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let mut errors = Vec::new();
        if let (Some(start), Some(end)) = (util::time(doc, "starts_at"), util::time(doc, "ends_at"))
            && end < start
        {
            errors.push(FieldError::new("ends_at", "the event ends before it starts"));
        }
        if let Some(tz) = s(doc, "timezone")
            && ics::zone(tz).is_none()
        {
            errors.push(FieldError::new("timezone", format!("{tz} is not a time zone name (e.g. Asia/Kolkata)")));
        }
        if let Some(r) = s(doc, "recurrence")
            && let Err(m) = recur::parse(r)
        {
            errors.push(FieldError::new("recurrence", m));
        }
        match doc.get("recurrence_exceptions") {
            None | Some(Value::Null) => {}
            Some(Value::Array(list)) => {
                for x in list {
                    if let Err(m) = x.as_str().ok_or_else(|| "each exception is a date or date-time string".to_string()).and_then(Exception::parse) {
                        errors.push(FieldError::new("recurrence_exceptions", m));
                    }
                }
            }
            Some(_) => errors.push(FieldError::new("recurrence_exceptions", "must be a list of dates or date-times")),
        }
        let emails: Vec<String> = attendees(doc).into_iter().map(|a| a.0).collect();
        if emails.iter().collect::<BTreeSet<_>>().len() != emails.len() {
            errors.push(FieldError::new("attendees", "each person can be invited once"));
        }
        if emails.len() > 200 {
            errors.push(FieldError::new("attendees", "at most 200 attendees"));
        }
        if rows(doc, "reminders").len() > 5 {
            errors.push(FieldError::new("reminders", "at most 5 reminders"));
        }
        if !errors.is_empty() {
            return Err(Error::Validation(errors));
        }
        if doc.contains_key("created_at") && !is_organizer(hc.ctx, doc) {
            return Err(Error::Forbidden("only the organizer can change this event; attendees answer with RSVP".into()));
        }
        if !hc.ctx.is_system
            && let (Some(e), Some(r)) = (s(doc, "reference_entity"), id(doc, "reference_id"))
            && hc.kernel.get_tx(hc.ctx, hc.tx, e, r, false).await.is_err()
        {
            return Err(Error::field("reference_id", "the record does not exist or you cannot access it"));
        }
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, old: Option<&Doc>) -> Result<()> {
        let event = util::doc_id(doc)?;
        let subject = s(doc, "subject").unwrap_or("(no title)").to_string();
        let cancelled = s(doc, "status") == Some("Cancelled");
        let cancelled_now = cancelled && old.is_some_and(|o| s(o, "status") != Some("Cancelled"));
        let changed = old.is_some_and(|o| int(doc, "sequence") > int(o, "sequence"));
        let before: BTreeSet<String> = old.map(|o| attendees(o).into_iter().map(|a| a.0).collect()).unwrap_or_default();
        let list = attendees(doc);
        let emails: Vec<String> = list.iter().map(|a| a.0.clone()).collect();
        let colleagues: BTreeMap<String, Uuid> = util::users(hc.tx, hc.ctx.tenant, &emails).await?.into_iter().map(|u| (u.email, u.id)).collect();
        let me = hc.ctx.email.to_lowercase();
        let owner = lower(s(doc, "owner"));
        let when = when(doc);
        for (email, _, _) in &list {
            let invited = !before.contains(email);
            let title = if cancelled_now {
                format!("Cancelled: {subject}")
            } else if invited && !cancelled {
                format!("Invitation: {subject}")
            } else if changed && !cancelled {
                format!("Updated: {subject}")
            } else {
                continue;
            };
            match colleagues.get(email) {
                Some(user) if *email != me && *email != owner => {
                    notify::send_kind(
                        hc.tx,
                        hc.ctx.tenant,
                        *user,
                        "comms.invitation",
                        "inapp",
                        &util::cut(&title, 200),
                        Some(&when),
                        Some("CalendarEvent"),
                        Some(event),
                    )
                    .await?;
                }
                Some(_) => {}
                None => queue_invitation(hc, doc, email, if cancelled_now { "CANCEL" } else { "REQUEST" }, !invited).await?,
            }
        }
        // People taken off the guest list hear that it is off for them.
        if let Some(o) = old
            && !cancelled
        {
            for (email, _, _) in attendees(o).into_iter().filter(|a| !emails.contains(&a.0)) {
                if util::users(hc.tx, hc.ctx.tenant, std::slice::from_ref(&email)).await?.is_empty() {
                    queue_invitation(hc, o, &email, "CANCEL", false).await?;
                }
            }
        }
        Ok(())
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if !is_organizer(hc.ctx, doc) {
            return Err(Error::Forbidden("only the organizer can delete this event".into()));
        }
        if s(doc, "status") == Some("Cancelled") || series(doc).is_none_or(|sr| sr.rule.is_none() && sr.end < util::now()) {
            return Ok(());
        }
        let event = util::doc_id(doc)?;
        let subject = s(doc, "subject").unwrap_or("(no title)").to_string();
        let list = attendees(doc);
        let emails: Vec<String> = list.iter().map(|a| a.0.clone()).collect();
        let colleagues: BTreeMap<String, Uuid> = util::users(hc.tx, hc.ctx.tenant, &emails).await?.into_iter().map(|u| (u.email, u.id)).collect();
        let me = hc.ctx.email.to_lowercase();
        for email in emails {
            match colleagues.get(&email) {
                Some(user) if email != me => {
                    notify::send_kind(
                        hc.tx,
                        hc.ctx.tenant,
                        *user,
                        "comms.invitation",
                        "inapp",
                        &util::cut(&format!("Cancelled: {subject}"), 200),
                        Some(&when(doc)),
                        None,
                        Some(event),
                    )
                    .await?;
                }
                Some(_) => {}
                None => queue_invitation(hc, doc, &email, "CANCEL", false).await?,
            }
        }
        Ok(())
    }
}

// ───────────────────────────── queries ─────────────────────────────

/// Events of `who` (organizer or attendee who has not declined) that may overlap the range.
async fn events_of(
    tx: &mut Tx,
    tenant: Uuid,
    who: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    include_public: bool,
    include_declined: bool,
    shared: &[Uuid],
) -> Result<Vec<(Doc, Option<String>)>> {
    let sql = format!(
        "select to_jsonb(e) || jsonb_build_object('attendees', (select coalesce(jsonb_agg(to_jsonb(a) order by a.idx), '[]') from {ATTENDEES} a \
            where a.tenant_id = e.tenant_id and a.parent_id = e.id), 'reminders', (select coalesce(jsonb_agg(to_jsonb(r) order by r.idx), '[]') \
            from {REMINDERS} r where r.tenant_id = e.tenant_id and r.parent_id = e.id)), \
         (select a.response from {ATTENDEES} a where a.tenant_id = e.tenant_id and a.parent_id = e.id and a.email = $2 limit 1) \
         from e_calendar_event e where e.tenant_id = $1 \
         and (e.owner = $2 or ($5 and e.visibility = 'Public') or e.calendar = any($7) or exists (select 1 from {ATTENDEES} a where a.tenant_id = e.tenant_id \
              and a.parent_id = e.id and a.email = $2 and ($6 or a.response <> 'Declined'))) \
         and e.starts_at < $4 and (e.recurrence is not null or e.ends_at > $3 or (e.ends_at = e.starts_at and e.starts_at >= $3)) \
         order by e.starts_at limit 5000"
    );
    let rows: Vec<(Value, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(tenant)
        .bind(who.to_lowercase())
        .bind(from)
        .bind(to)
        .bind(include_public)
        .bind(include_declined)
        .bind(shared)
        .fetch_all(&mut **tx)
        .await?;
    Ok(rows.into_iter().map(|(v, r)| (normalize(util::obj(v)), r)).collect())
}

/// Raw rows carry Postgres date-time text; the API speaks RFC 3339 UTC.
pub(crate) fn normalize(mut d: Doc) -> Doc {
    for k in ["starts_at", "ends_at", "created_at", "updated_at"] {
        if let Some(t) = util::time(&d, k) {
            d.insert(k.into(), json!(util::ts(t)));
        }
    }
    d.remove("tenant_id");
    d.remove("ext");
    d
}

/// A `from`/`to` range (dates or RFC 3339 date-times), positive and at most a year and a bit.
fn range(from: Option<&str>, to: Option<&str>) -> Result<(DateTime<Utc>, DateTime<Utc>)> {
    let at = |k: &str, v: Option<&str>| -> Result<DateTime<Utc>> {
        let v = v.map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| Error::field(k, "is required"))?;
        if let Ok(d) = NaiveDate::parse_from_str(v, "%Y-%m-%d") {
            return Ok(d.and_time(chrono::NaiveTime::MIN).and_utc());
        }
        util::parse_ts(v).ok_or_else(|| Error::field(k, "use YYYY-MM-DD or an RFC 3339 date-time"))
    };
    let (from, to) = (at("from", from)?, at("to", to)?);
    if to <= from || to - from > Duration::days(MAX_RANGE_DAYS) {
        return Err(Error::invalid(format!("the range must be positive and at most {MAX_RANGE_DAYS} days")));
    }
    Ok((from, to))
}

/// `GET /calendar/events?from=&to=`: my calendar (events I organize or am invited to, plus
/// public ones), recurring events expanded into occurrences.
async fn my_calendar(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let (from, to) = range(util::param(req, "from"), util::param(req, "to"))?;
    let q = util::param(req, "q").map(str::trim).filter(|q| !q.is_empty()).map(|q| util::cut(q, 200));
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let shared = crate::calendars::shared_with(&mut tx, ctx.tenant, &me).await?;
    let ids: Vec<Uuid> = shared.keys().copied().collect();
    let events = events_of(&mut tx, ctx.tenant, &me, from, to, true, true, &ids).await?;
    tx.commit().await?;
    let mut out = Vec::new();
    for (doc, response) in events {
        let level = crate::calendars::level(&me, &doc, &shared);
        if level == Level::None {
            continue;
        }
        // A search: only what I may read of the event (never the title behind a free/busy share).
        if q.as_deref().is_some_and(|q| level < Level::Details || !found(&doc, q)) {
            continue;
        }
        let Some(sr) = series(&doc) else { continue };
        let recurring = sr.rule.is_some();
        for (start, end) in recur::occurrences(&sr, from, to) {
            out.push(json!({
                "id": format!("{}/{}", s(&doc, "id").unwrap_or_default(), util::ts(start)),
                "event": doc.get("id"),
                "start": util::ts(start),
                "end": util::ts(end),
                "all_day": b(&doc, "all_day"),
                "subject": doc.get("subject"),
                "location": doc.get("location"),
                "meeting_link": doc.get("meeting_link"),
                "description": doc.get("description"),
                "status": doc.get("status"),
                "visibility": doc.get("visibility"),
                "category": doc.get("category"),
                "color": doc.get("color"),
                "timezone": doc.get("timezone"),
                "owner": doc.get("owner"),
                "is_organizer": lower(s(&doc, "owner")) == me,
                "my_response": response,
                "recurring": recurring,
                "reference_entity": doc.get("reference_entity"),
                "reference_id": doc.get("reference_id"),
                "calendar": doc.get("calendar"),
                "level": level.word(),
            }));
            if level == Level::FreeBusy
                && let Some(Value::Object(o)) = out.last_mut()
            {
                crate::calendars::redact(o);
            }
        }
        if out.len() > 10_000 {
            break;
        }
    }
    // My time away, as a bar across its days (not an event: it is changed in my working hours).
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let mine = crate::hours::of(&mut tx, ctx.tenant, std::slice::from_ref(&me)).await?.remove(&me);
    tx.commit().await?;
    if let Some((a, b)) = mine.as_ref().and_then(|h| Some((h.away_from?, h.away_to?)))
        && q.is_none()
    {
        let (start, end) = (a.and_time(chrono::NaiveTime::MIN).and_utc(), (b + Duration::days(1)).and_time(chrono::NaiveTime::MIN).and_utc());
        if start < to && end > from {
            out.push(json!({"id": format!("away/{a}"), "event": null, "kind": "away", "start": util::ts(start), "end": util::ts(end), "all_day": true,
                "subject": "Out of office", "description": mine.as_ref().and_then(|h| h.away_message.clone()), "status": "Confirmed", "is_organizer": false}));
        }
    }
    out.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
    Ok(json!({"from": util::ts(from), "to": util::ts(to), "q": q, "occurrences": out}))
}

/// How far ahead Home's My work looks for invitations to answer.
const INVITATIONS_DAYS: i64 = 60;

/// `GET /calendar/invitations`: events I am invited to and have not answered, from now to
/// [`INVITATIONS_DAYS`] ahead, each with its next occurrence: what Home's My work shows from
/// Calendar (`shell.work`). `{items: [{title, subtitle, url, due, updated_at}]}`.
async fn invitations(k: &Kernel, ctx: &Ctx) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let (from, to) = (Utc::now(), Utc::now() + Duration::days(INVITATIONS_DAYS));
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let events = events_of(&mut tx, ctx.tenant, &me, from, to, false, false, &[]).await?;
    let mut items = Vec::new();
    for (doc, response) in events {
        if response.as_deref() != Some("Needs Action") || lower(s(&doc, "owner")) == me || s(&doc, "status") == Some("Cancelled") {
            continue;
        }
        let Some(sr) = series(&doc) else { continue };
        let Some((start, end)) = recur::occurrences(&sr, from, to).into_iter().next() else { continue };
        let owner = s(&doc, "owner").unwrap_or_default().to_string();
        let by = display_name(&mut tx, ctx.tenant, &owner).await?.unwrap_or(owner);
        let mut at = doc.clone();
        at.insert("starts_at".into(), json!(util::ts(start)));
        at.insert("ends_at".into(), json!(util::ts(end)));
        // The date as the event's own time zone has it (UTC without one).
        let tz = s(&doc, "timezone").and_then(ics::zone);
        let day = tz.map(|z| start.with_timezone(&z).date_naive()).unwrap_or_else(|| start.date_naive());
        items.push(json!({
            "title": s(&doc, "subject").filter(|t| !t.trim().is_empty()).unwrap_or("(no subject)"),
            "subtitle": format!("{} · from {by}", when(&at)),
            "url": format!("/calendar/?event={}&at={}", s(&doc, "id").unwrap_or_default(), util::ts(start)),
            "due": day.to_string(),
            "updated_at": doc.get("updated_at"),
        }));
        if items.len() >= 50 {
            break;
        }
    }
    tx.commit().await?;
    Ok(json!({"items": items}))
}

/// Merges overlapping intervals.
fn merge(mut v: Vec<(DateTime<Utc>, DateTime<Utc>)>) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    v.sort();
    let mut out: Vec<(DateTime<Utc>, DateTime<Utc>)> = Vec::new();
    for (s, e) in v {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

/// `POST /calendar/freebusy` `{users: [emails], from, to, exclude?: event}`: busy intervals only, no details.
async fn free_busy(k: &Kernel, ctx: &Ctx, body: Map<String, Value>) -> Result<Value> {
    let users: Vec<String> =
        body.get("users").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|e| e.trim().to_lowercase()).collect()).unwrap_or_default();
    if users.is_empty() || users.len() > 50 {
        return Err(Error::field("users", "give 1 to 50 emails"));
    }
    let (from, to) = range(body.get("from").and_then(Value::as_str), body.get("to").and_then(Value::as_str))?;
    // An event being edited does not count against its own time.
    let exclude: Option<Uuid> = body.get("exclude").and_then(Value::as_str).and_then(|e| e.parse().ok());
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    // Working hours and time away of those who set them (what colleagues may see of them).
    let hours: Map<String, Value> = crate::hours::of(&mut tx, ctx.tenant, &users).await?.into_iter().map(|(p, h)| (p, h.public())).collect();
    let mut busy = Map::new();
    for u in users {
        let mut intervals = Vec::new();
        for (doc, _) in events_of(&mut tx, ctx.tenant, &u, from, to, false, false, &[]).await? {
            if s(&doc, "status") == Some("Cancelled") || (exclude.is_some() && id(&doc, "id") == exclude) {
                continue;
            }
            if let Some(sr) = series(&doc) {
                intervals.extend(recur::occurrences(&sr, from, to).into_iter().map(|(a, b)| (a.max(from), b.min(to))));
            }
        }
        busy.insert(u, json!(merge(intervals).into_iter().map(|(a, b)| json!({"start": util::ts(a), "end": util::ts(b)})).collect::<Vec<_>>()));
    }
    tx.commit().await?;
    Ok(json!({"from": util::ts(from), "to": util::ts(to), "busy": busy, "hours": hours}))
}

/// The words an organizer reads for an answer.
fn answered(response: &str) -> &'static str {
    match response {
        "Accepted" => "accepted",
        "Declined" => "declined",
        "Tentative" => "might attend",
        _ => "has not decided on",
    }
}

/// Writes one attendee's answer (and a note that came with it) on the event, and tells its
/// organizer. `write` is who changes the event (the person, or the system for someone answering
/// from a link); `who` is how the organizer should read the name.
pub(crate) async fn record_answer(
    k: &Kernel,
    tx: &mut Tx,
    tenant: Uuid,
    write: &Ctx,
    doc: &Doc,
    email: &str,
    response: &str,
    note: Option<&str>,
    who: &str,
) -> Result<()> {
    let event = util::doc_id(doc)?;
    let mut list: Vec<Value> = doc.get("attendees").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(row) = list.iter_mut().find(|r| r.get("email").and_then(Value::as_str).is_some_and(|e| e.eq_ignore_ascii_case(email))) else {
        return Err(Error::NotFound("Event".into()));
    };
    row["response"] = json!(response);
    if let Some(note) = note {
        row["comment"] = if note.is_empty() { Value::Null } else { json!(note) };
    }
    let mut patch = Doc::new();
    patch.insert("attendees".into(), Value::Array(list));
    k.update_tx(write, tx, "CalendarEvent", event, patch, None).await?;
    if let Some(owner) = s(doc, "owner").filter(|o| !o.eq_ignore_ascii_case(email))
        && let Some(user) = util::user_id(tx, tenant, owner).await?
    {
        let title = util::cut(&format!("{who} {}: {}", answered(response), s(doc, "subject").unwrap_or_default()), 200);
        notify::send_kind(tx, tenant, user, "comms.rsvp", "inapp", &title, note.filter(|n| !n.is_empty()), Some("CalendarEvent"), Some(event)).await?;
    }
    Ok(())
}

const RESPONSES: &[&str] = &["Accepted", "Declined", "Tentative", "Needs Action"];

/// `POST /calendar/events/{id}/rsvp` `{response: Accepted|Declined|Tentative|Needs Action, note?}`.
pub(crate) async fn rsvp(k: &Kernel, ctx: &Ctx, event: Uuid, body: Map<String, Value>) -> Result<Value> {
    let response = body.get("response").and_then(Value::as_str).unwrap_or_default().to_string();
    if !RESPONSES.contains(&response.as_str()) {
        return Err(Error::field("response", "must be Accepted, Declined, Tentative or Needs Action"));
    }
    let note = body.get("note").and_then(Value::as_str).map(|n| util::clean_line(n, 500));
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(&util::sys(ctx), &mut tx, "CalendarEvent", event, true).await.map_err(|_| Error::NotFound("Event".into()))?;
    if !attendees(&doc).iter().any(|a| a.0 == me) {
        return Err(if lower(s(&doc, "owner")) == me || s(&doc, "visibility") == Some("Public") {
            Error::invalid("you are not on this event's guest list")
        } else {
            Error::NotFound("Event".into())
        });
    }
    let who = if ctx.full_name.trim().is_empty() { ctx.email.clone() } else { ctx.full_name.clone() };
    record_answer(k, &mut tx, ctx.tenant, &util::elevated(ctx), &doc, &me, &response, note.as_deref(), &who).await?;
    tx.commit().await?;
    Ok(json!({"event": event, "response": response}))
}

/// `GET /calendar/events/{id}`: who is invited and what each answered (with their notes, for the
/// organizer), for the organizer and the guests. Anyone else who may see the event gets no list.
async fn event_detail(k: &Kernel, ctx: &Ctx, event: Uuid) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(&util::sys(ctx), &mut tx, "CalendarEvent", event, false).await.map_err(|_| Error::NotFound("Event".into()))?;
    let organizer = lower(s(&doc, "owner")) == me;
    let shared = crate::calendars::shared_with(&mut tx, ctx.tenant, &me).await?;
    let level = crate::calendars::level(&me, &doc, &shared);
    if level < Level::Details {
        return Err(Error::NotFound("Event".into()));
    }
    // Guests are seen by the organizer, the guests and those the calendar is shared with; not for a public event.
    let guests: Vec<Value> = if level != Level::Details
        || attendees(&doc).iter().any(|a| a.0 == me)
        || shared.contains_key(&id(&doc, "calendar").unwrap_or_default())
    {
        rows(&doc, "attendees")
            .iter()
            .map(|a| json!({"email": a.get("email"), "name": a.get("attendee_name"), "response": a.get("response"), "comment": if organizer { a.get("comment").cloned() } else { None }}))
            .collect()
    } else {
        vec![]
    };
    let owner = lower(s(&doc, "owner"));
    let owner_name = display_name(&mut tx, ctx.tenant, &owner).await?;
    tx.commit().await?;
    Ok(
        json!({"id": event, "version": doc.get("version"), "attendees": guests, "owner": owner, "owner_name": owner_name, "level": level.word(), "calendar": doc.get("calendar")}),
    )
}

// ───────────────────────────── answering from the invitation ─────────────────────────────

/// What an answer link stands for: the event, and the address the invitation went to.
fn answer_claim(event: Uuid, email: &str) -> String {
    format!("rsvp|{event}|{}", email.to_lowercase())
}

/// The token in an answer link: only the invitation's recipient has it, and it works for no other event or address.
fn answer_token(key: &[u8], event: Uuid, email: &str) -> String {
    let email = email.to_lowercase();
    format!("r.{}.{}.{}", event.simple(), URL_SAFE_NO_PAD.encode(&email), util::sign(key, &answer_claim(event, &email)))
}

/// The address of Calendar's page for answering an invitation (`/calendar/rsvp/{workspace}/{token}`),
/// when the workspace's public address is known.
async fn answer_link(k: &Kernel, tx: &mut Tx, tenant: Uuid, doc: &Doc, email: &str) -> Result<Option<String>> {
    let Some(event) = id(doc, "id") else { return Ok(None) };
    let base = util::settings(tx, tenant).await?.public_url.or_else(|| k.settings.public_url.clone().map(|u| u.trim_end_matches('/').to_string()));
    let Some(base) = base else { return Ok(None) };
    let key = util::signing_key(k, tenant).await?;
    Ok(Some(format!("{base}/calendar/rsvp/{}/{}", util::slug(tx, tenant).await?, answer_token(&key, event, email))))
}

/// The event and the address an answer link is for, when the link is genuine and the person is
/// still invited.
async fn open_answer(k: &Kernel, tenant: Uuid, token: &str) -> Result<(Doc, String)> {
    let gone = || Error::invalid("This link no longer works. Ask the person who invited you to send it again.");
    let parts: Vec<&str> = token.split('.').collect();
    let [kind, event, email, signature] = parts.as_slice() else { return Err(gone()) };
    let (event, email) = match (*kind, event.parse::<Uuid>(), URL_SAFE_NO_PAD.decode(email).ok().and_then(|e| String::from_utf8(e).ok())) {
        ("r", Ok(event), Some(email)) => (event, email),
        _ => return Err(gone()),
    };
    if !util::verify(&util::signing_key(k, tenant).await?, &answer_claim(event, &email), signature) {
        return Err(gone());
    }
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    let mut tx = k.db.tenant_tx(tenant).await?;
    let doc = k.get_tx(&sys, &mut tx, "CalendarEvent", event, false).await.map_err(|_| gone())?;
    tx.commit().await?;
    if !attendees(&doc).iter().any(|a| a.0 == email.to_lowercase()) {
        return Err(gone());
    }
    Ok((doc, email.to_lowercase()))
}

/// `GET /api/site/{workspace}/comms/rsvp?token=` (public): what the invitation is for, to show on the page that takes the answer.
pub async fn answer_info(k: &Kernel, tenant: Uuid, token: &str) -> Result<Value> {
    let (doc, email) = open_answer(k, tenant, token).await?;
    let mine = attendees(&doc).into_iter().find(|a| a.0 == email);
    let mut tx = k.db.tenant_tx(tenant).await?;
    let owner = lower(s(&doc, "owner"));
    let by = display_name(&mut tx, tenant, &owner).await?.unwrap_or_else(|| owner.clone());
    tx.commit().await?;
    Ok(json!({
        "subject": s(&doc, "subject"), "when": when(&doc), "where": s(&doc, "location"), "description": s(&doc, "description"),
        "organizer": by, "guest": {"email": email, "name": mine.as_ref().and_then(|m| m.1.clone())},
        "response": mine.map(|m| m.2).unwrap_or_else(|| "Needs Action".into()),
        "cancelled": s(&doc, "status") == Some("Cancelled"),
    }))
}

/// `POST /api/site/{workspace}/comms/rsvp {token, response: Accepted|Tentative|Declined, note?}` (public).
pub async fn answer(k: &Kernel, tenant: Uuid, client: &str, body: &Map<String, Value>) -> Result<Value> {
    k.rate_limit(&format!("comms-rsvp|{tenant}|{client}"), std::time::Duration::from_secs(60), 20, "Too many answers from here. Try again in a minute.")
        .await?;
    let response = body.get("response").and_then(Value::as_str).unwrap_or_default();
    if !["Accepted", "Tentative", "Declined"].contains(&response) {
        return Err(Error::field("response", "must be Accepted, Tentative or Declined"));
    }
    let (doc, email) = open_answer(k, tenant, body.get("token").and_then(Value::as_str).unwrap_or_default()).await?;
    if s(&doc, "status") == Some("Cancelled") {
        return Err(Error::invalid("this event was cancelled"));
    }
    let note = body.get("note").and_then(Value::as_str).map(|n| util::clean_line(n, 500));
    let name = attendees(&doc).into_iter().find(|a| a.0 == email).and_then(|a| a.1).unwrap_or_else(|| email.clone());
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    let mut tx = k.db.tenant_tx(tenant).await?;
    // Read again inside the transaction that changes it, so two answers at once do not undo each other.
    let current = k.get_tx(&sys, &mut tx, "CalendarEvent", util::doc_id(&doc)?, true).await?;
    record_answer(k, &mut tx, tenant, &sys, &current, &email, response, note.as_deref(), &name).await?;
    tx.commit().await?;
    Ok(json!({"response": response}))
}

// ───────────────────────────── feed and import ─────────────────────────────

/// The caller's calendar feed record (its `token` is a secret field).
async fn feed_record(tx: &mut Tx, ctx: &Ctx) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar("select id from e_calendar_feed where tenant_id = $1 and person = $2")
        .bind(ctx.tenant)
        .bind(ctx.email.to_lowercase())
        .fetch_optional(&mut **tx)
        .await?)
}

/// `GET|POST|DELETE /calendar/feed`: whether I have a feed URL / a new one (shown once) / none.
async fn feed_token(k: &Kernel, ctx: &Ctx, method: &str) -> Result<Value> {
    let sys = util::sys(ctx);
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let feed = feed_record(&mut tx, ctx).await?;
    let out = match (method, feed) {
        ("GET", Some(f)) => json!({"active": k.secret(&mut tx, ctx.tenant, "CalendarFeed", f, "token").await?.is_some()}),
        ("GET", None) => json!({"active": false}),
        ("POST", _) => {
            let secret = util::new_token();
            let mut values = Doc::new();
            values.insert("token".into(), json!(secret));
            let f = match feed {
                Some(f) => {
                    k.update_tx(&sys, &mut tx, "CalendarFeed", f, values, None).await?;
                    f
                }
                None => {
                    values.insert("person".into(), json!(ctx.email.to_lowercase()));
                    util::doc_id(&k.insert_tx(&sys, &mut tx, "CalendarFeed", values).await?)?
                }
            };
            let token = util::record_token(f, &secret);
            let (path, url) = util::public_url(&mut tx, ctx.tenant, &format!("/calendar/{token}.ics")).await?;
            json!({"active": true, "token": token, "path": path, "url": url})
        }
        ("DELETE", f) => {
            if let Some(f) = f {
                k.delete_tx(&sys, &mut tx, "CalendarFeed", f, None).await?;
            }
            json!({"active": false})
        }
        _ => return Err(Error::NotFound("calendar endpoint".into())),
    };
    tx.commit().await?;
    Ok(out)
}

/// `GET /calendar/{token}.ics` (public): the token owner's events as an iCalendar feed.
pub async fn feed(k: &Kernel, tenant: Uuid, token: &str) -> Result<SiteResponse> {
    let feed = util::check_token(k, tenant, "CalendarFeed", "token", token).await?.ok_or_else(|| Error::NotFound("calendar".into()))?;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<(String, String)> = sqlx::query_as(
        "select u.email::text, u.full_name from e_calendar_feed f join app_user u on u.tenant_id = f.tenant_id and lower(u.email::text) = f.person \
         where f.tenant_id = $1 and f.id = $2 and u.is_active",
    )
    .bind(tenant)
    .bind(feed)
    .fetch_optional(&mut *tx)
    .await?;
    let (email, name) = row.ok_or_else(|| Error::NotFound("calendar".into()))?;
    let text = ics_of(&mut tx, tenant, &email, &name).await?;
    tx.commit().await?;
    let mut r = SiteResponse::text(200, "text/calendar; charset=utf-8", text);
    r.headers.push(("cache-control".into(), "private, max-age=300".into()));
    Ok(r)
}

/// A person's calendar as iCalendar text: their events and invitations from 180 days back to ten
/// years on (what the secret feed and an export carry).
async fn ics_of(tx: &mut Tx, tenant: Uuid, email: &str, name: &str) -> Result<String> {
    let from = util::now() - Duration::days(180);
    // My own events and invitations only: a feed never carries calendars shared with me.
    let events = events_of(tx, tenant, email, from, util::now() + Duration::days(3660), false, false, &[]).await?;
    let mut organizers: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut list = Vec::new();
    for (doc, _) in &events {
        let owner = lower(s(doc, "owner"));
        if !organizers.contains_key(&owner) {
            let n = display_name(tx, tenant, &owner).await?;
            organizers.insert(owner.clone(), n);
        }
        list.extend(vevent(doc, organizers.get(&owner).cloned().flatten(), false, true));
    }
    let label = if name.trim().is_empty() { email } else { name };
    Ok(ics::calendar(None, Some(label), &list))
}

/// `GET /calendar/export`: my calendar as an `.ics` file to save.
async fn export(k: &Kernel, ctx: &Ctx) -> Result<SiteResponse> {
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let name = display_name(&mut tx, ctx.tenant, &me).await?.unwrap_or_default();
    let text = ics_of(&mut tx, ctx.tenant, &me, &name).await?;
    tx.commit().await?;
    let mut r = SiteResponse::text(200, "text/calendar; charset=utf-8", text);
    r.headers.push(("content-disposition".into(), "attachment; filename=\"calendar.ics\"".into()));
    r.headers.push(("cache-control".into(), "no-store".into()));
    Ok(r)
}

/// Whether every word of `q` is in the event's title, place, notes, organizer or guests (any case).
fn found(doc: &Doc, q: &str) -> bool {
    let mut hay = ["subject", "location", "description", "owner"].iter().filter_map(|f| s(doc, f)).collect::<Vec<_>>().join(" ");
    for (email, name, _) in attendees(doc) {
        hay.push(' ');
        hay.push_str(&email);
        hay.push(' ');
        hay.push_str(name.as_deref().unwrap_or_default());
    }
    let hay = hay.to_lowercase();
    q.split_whitespace().all(|w| hay.contains(&w.to_lowercase()))
}

/// An event's own fields from iCalendar, for imports and calendar apps.
pub(crate) fn event_fields(e: &ics::ParsedEvent) -> Doc {
    let mut doc = event_fields_without_zone(e);
    // The zone its times were written in (kept when the app sent UTC times).
    if let Some(z) = e.tzid.as_deref().filter(|_| !e.all_day) {
        doc.insert("timezone".into(), json!(z));
    }
    doc
}

fn event_fields_without_zone(e: &ics::ParsedEvent) -> Doc {
    let status = match e.status.as_deref() {
        Some("CANCELLED") => "Cancelled",
        Some("TENTATIVE") => "Tentative",
        _ => "Confirmed",
    };
    let exceptions: Vec<String> = e
        .exceptions
        .iter()
        .map(|x| match x {
            Exception::Day(d) => d.format("%Y-%m-%d").to_string(),
            Exception::At(t) => util::ts(*t),
        })
        .collect();
    util::obj(json!({
        "subject": util::clean_line(&e.summary, 990),
        "starts_at": util::ts(e.start),
        "ends_at": util::ts(e.end),
        "all_day": e.all_day,
        "description": e.description,
        "location": e.location.as_deref().map(|l| util::clean_line(l, 990)),
        "meeting_link": e.url.as_deref().filter(|u| u.starts_with("https://") || u.starts_with("http://")),
        "category": e.categories.as_deref().map(|c| util::clean_line(c, 990)),
        "status": status,
        "recurrence": e.rrule,
        "recurrence_exceptions": exceptions,
        "sequence": e.sequence,
    }))
}

/// `POST /calendar/import`: an iCalendar file (raw `text/calendar`, or JSON `{ics}`) becomes my
/// events; events imported before (same UID) are updated.
async fn import(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    ctx.require("CalendarEvent", Action::Create)?;
    let json_body = util::header(req, "content-type").is_some_and(|c| c.to_ascii_lowercase().contains("json"));
    let text = if json_body {
        util::body_json(req)?.get("ics").and_then(Value::as_str).map(str::to_string).ok_or_else(|| Error::field("ics", "is required"))?
    } else {
        String::from_utf8(req.body.clone()).map_err(|_| Error::invalid("the calendar file must be UTF-8"))?
    };
    let parsed = ics::parse(&text).map_err(Error::invalid)?;
    if parsed.events.len() > 1000 {
        return Err(Error::invalid("import at most 1000 events at a time"));
    }
    let me = ctx.email.to_lowercase();
    let acting = util::elevated(ctx);
    let (mut created, mut updated, mut failed) = (0, 0, Vec::new());
    for e in ics::detach_overrides(parsed.events) {
        let uid = e.uid.clone().unwrap_or_else(|| format!("{}@import.ferrum", Uuid::now_v7()));
        let mut doc = event_fields(&e);
        doc.insert("ical_uid".into(), json!(util::cut(&uid, 990)));
        doc.insert("owner".into(), json!(me));
        // Taken from someone else's invitation: who sent it, the only one whose CANCEL counts (itip.rs).
        if let Some(o) = e.organizer.as_deref().filter(|o| *o != me) {
            doc.insert("organizer".into(), json!(o));
        }
        let result = async {
            let mut tx = k.db.tenant_tx(ctx.tenant).await?;
            let existing: Option<Uuid> = sqlx::query_scalar("select id from e_calendar_event where tenant_id = $1 and owner = $2 and ical_uid = $3")
                .bind(ctx.tenant)
                .bind(&me)
                .bind(util::cut(&uid, 990))
                .fetch_optional(&mut *tx)
                .await?;
            let was_new = existing.is_none();
            match existing {
                Some(id) => k.update_tx(&acting, &mut tx, "CalendarEvent", id, doc, None).await?,
                None => k.insert_tx(&acting, &mut tx, "CalendarEvent", doc).await?,
            };
            tx.commit().await?;
            Ok::<_, Error>(was_new)
        }
        .await;
        match result {
            Ok(true) => created += 1,
            Ok(false) => updated += 1,
            Err(err) => failed.push(json!({"uid": uid, "subject": e.summary, "error": err.to_string()})),
        }
    }
    Ok(json!({"created": created, "updated": updated, "failed": failed, "warnings": parsed.warnings}))
}

// ───────────────────────────── reminders ─────────────────────────────

/// Announces due reminders in the app: each (event, occurrence, offset) once, to the organizer
/// and colleagues who have not declined, while the occurrence has not started (5 minutes grace).
pub async fn fire_reminders(k: &Kernel, tenant: Uuid) -> Result<usize> {
    let now = util::now();
    let grace = Duration::minutes(5);
    let horizon = now + Duration::minutes(MAX_REMINDER_MINUTES) + grace;
    let sql = format!(
        "select to_jsonb(e) || jsonb_build_object('attendees', (select coalesce(jsonb_agg(to_jsonb(a) order by a.idx), '[]') from {ATTENDEES} a \
            where a.tenant_id = e.tenant_id and a.parent_id = e.id)), \
         (select array_agg(distinct r.minutes_before) from {REMINDERS} r where r.tenant_id = e.tenant_id and r.parent_id = e.id) \
         from e_calendar_event e where e.tenant_id = $1 and e.status <> 'Cancelled' \
         and exists (select 1 from {REMINDERS} r where r.tenant_id = e.tenant_id and r.parent_id = e.id) \
         and e.starts_at <= $2 and (e.recurrence is not null or e.starts_at > $3) limit 2000"
    );
    let mut tx = k.db.tenant_tx(tenant).await?;
    let events: Vec<(Value, Option<Vec<i64>>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(tenant).bind(horizon).bind(now - grace).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut fired = 0;
    for (doc, minutes) in events {
        let doc = normalize(util::obj(doc));
        let Some(sr) = series(&doc) else { continue };
        let event = util::doc_id(&doc)?;
        for (start, _) in recur::occurrences(&sr, now - grace, horizon) {
            for m in minutes.iter().flatten() {
                if start - Duration::minutes(*m) > now || start < now - grace {
                    continue;
                }
                let mut tx = k.db.tenant_tx(tenant).await?;
                // An occurrence whose instant moved (repeating events follow their zone's clock
                // since 0.16) and was reminded at its old instant on the same local day counts as
                // reminded.
                let near: Vec<DateTime<Utc>> = sqlx::query_scalar(
                    "select occurrence_start from comms_reminder_log where tenant_id = $1 and event_id = $2 and minutes_before = $3 \
                     and occurrence_start between $4 and $5 and occurrence_start <> $6",
                )
                .bind(tenant)
                .bind(event)
                .bind(*m as i32)
                .bind(start - Duration::days(1))
                .bind(start + Duration::days(1))
                .bind(start)
                .fetch_all(&mut *tx)
                .await?;
                if reminded_that_day(start, &near, sr.zone) {
                    tx.commit().await?;
                    continue;
                }
                let first = sqlx::query(
                    "insert into comms_reminder_log (tenant_id, event_id, occurrence_start, minutes_before) values ($1, $2, $3, $4) on conflict do nothing",
                )
                .bind(tenant)
                .bind(event)
                .bind(start)
                .bind(*m as i32)
                .execute(&mut *tx)
                .await?
                .rows_affected()
                    == 1;
                if first {
                    let mut people: Vec<String> = attendees(&doc).into_iter().filter(|a| a.2 != "Declined").map(|a| a.0).collect();
                    people.extend(s(&doc, "owner").map(str::to_lowercase));
                    people.sort();
                    people.dedup();
                    let mut occurrence = doc.clone();
                    occurrence.insert("starts_at".into(), json!(util::ts(start)));
                    occurrence.insert("ends_at".into(), json!(util::ts(start + (sr.end - sr.start))));
                    let title = util::cut(&format!("Reminder: {}", s(&doc, "subject").unwrap_or("(no title)")), 200);
                    for u in util::users(&mut tx, tenant, &people).await? {
                        notify::send_kind(
                            &mut tx,
                            tenant,
                            u.id,
                            "comms.reminder",
                            "inapp",
                            &title,
                            Some(&when(&occurrence)),
                            Some("CalendarEvent"),
                            Some(event),
                        )
                        .await?;
                    }
                    fired += 1;
                }
                tx.commit().await?;
            }
        }
    }
    Ok(fired)
}

/// `PATCH /calendar/events/{id}`: a change by someone the event's calendar is shared with at
/// "make changes" (its organizer changes it through the records API). Times, title, place and notes.
async fn shared_edit(k: &Kernel, ctx: &Ctx, event: Uuid, body: Map<String, Value>) -> Result<Value> {
    const FIELDS: &[&str] = &["subject", "starts_at", "ends_at", "all_day", "timezone", "location", "description", "recurrence", "recurrence_exceptions"];
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(&util::sys(ctx), &mut tx, "CalendarEvent", event, false).await.map_err(|_| Error::NotFound("Event".into()))?;
    let shared = crate::calendars::shared_with(&mut tx, ctx.tenant, &me).await?;
    match crate::calendars::level(&me, &doc, &shared) {
        Level::None | Level::FreeBusy => return Err(Error::NotFound("Event".into())),
        Level::Details => return Err(Error::Forbidden("you may see this calendar, not change it".into())),
        Level::Edit | Level::Owner => {}
    }
    if let Some(k) = body.keys().find(|k| !FIELDS.contains(&k.as_str())) {
        return Err(Error::field(k, "cannot be changed here"));
    }
    let version = doc.get("version").and_then(Value::as_i64);
    let saved = k.update_tx(&util::sys(ctx), &mut tx, "CalendarEvent", event, body, version).await?;
    tx.commit().await?;
    Ok(Value::Object(saved))
}

/// Whether a reminder for the occurrence at `start` already went out for one at another instant of
/// the same local day (in the event's zone): the same occurrence, moved by a change of clocks.
fn reminded_that_day(start: DateTime<Utc>, fired: &[DateTime<Utc>], zone: Option<chrono_tz::Tz>) -> bool {
    let day = recur::wall(start, zone).date();
    fired.iter().any(|f| *f != start && recur::wall(*f, zone).date() == day)
}

/// `GET /calendar/search?q=`: the bar's search provider (`shell.search`): events I can see (mine,
/// those I am invited to, public ones) whose title, place, notes, organizer or guests match, from
/// half a year back to a year on, each opening at its next occurrence (or its last one).
async fn search(k: &Kernel, ctx: &Ctx, req: &SiteRequest) -> Result<Value> {
    let q = util::param(req, "q").map(str::trim).unwrap_or_default();
    if q.chars().count() < 2 {
        return Err(Error::field("q", "type at least two characters"));
    }
    let q = util::cut(q, 200);
    let limit: usize = util::param(req, "limit").and_then(|l| l.parse().ok()).unwrap_or(20).clamp(1, 50);
    let now = util::now();
    let (from, to) = (now - Duration::days(180), now + Duration::days(215));
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let shared = crate::calendars::shared_with(&mut tx, ctx.tenant, &me).await?;
    let ids: Vec<Uuid> = shared.keys().copied().collect();
    let events = events_of(&mut tx, ctx.tenant, &me, from, to, true, false, &ids).await?;
    tx.commit().await?;
    let mut results: Vec<(i64, Value)> = Vec::new();
    // Only what the access rule lets me read is searched: a free/busy share never matches a title.
    for (doc, _) in events.iter().filter(|(d, _)| crate::calendars::level(&me, d, &shared) >= Level::Details && found(d, &q)) {
        let Some(sr) = series(doc) else { continue };
        let all = recur::occurrences(&sr, from, to);
        let Some((start, end)) = all.iter().find(|(s, _)| *s >= now).or(all.last()).copied() else { continue };
        let mut at = doc.clone();
        at.insert("starts_at".into(), json!(util::ts(start)));
        at.insert("ends_at".into(), json!(util::ts(end)));
        let id = s(doc, "id").unwrap_or_default();
        results.push((
            (start - now).num_seconds().abs(),
            json!({"title": s(doc, "subject").unwrap_or("(no title)"), "subtitle": when(&at), "url": format!("/calendar/?event={id}&at={}", util::ts(start)),
                "icon": "calendar", "updated_at": doc.get("updated_at")}),
        ));
    }
    // Nearest to now first.
    results.sort_by_key(|(d, _)| *d);
    Ok(json!({"results": results.into_iter().take(limit).map(|(_, v)| v).collect::<Vec<_>>()}))
}

fn uuid(seg: &str) -> Result<Uuid> {
    seg.parse().map_err(|_| Error::NotFound("record".into()))
}

/// Routes `/calendar/...` for signed-in users.
pub async fn handle(k: &Kernel, ctx: &Ctx, req: &SiteRequest, path: &[&str]) -> Result<SiteResponse> {
    let out = match (req.method.as_str(), path) {
        ("GET", ["events"]) => my_calendar(k, ctx, req).await?,
        ("GET", ["invitations"]) => invitations(k, ctx).await?,
        ("POST", ["freebusy"]) => free_busy(k, ctx, util::body_json(req)?).await?,
        ("GET", ["events", e]) => event_detail(k, ctx, uuid(e)?).await?,
        ("POST", ["events", e, "rsvp"]) => rsvp(k, ctx, uuid(e)?, util::body_json(req)?).await?,
        (m, ["feed"]) => feed_token(k, ctx, m).await?,
        ("POST", ["import"]) => import(k, ctx, req).await?,
        ("GET", ["export"]) => return export(k, ctx).await,
        ("GET", ["search"]) => search(k, ctx, req).await?,
        ("GET", ["calendars"]) => crate::calendars::list(k, ctx).await?,
        ("POST", ["calendars"]) => crate::calendars::change(k, ctx, "POST", None, util::body_json(req)?, None).await?,
        (m @ ("PATCH" | "DELETE"), ["calendars", c]) => {
            let body = if m == "PATCH" { util::body_json(req)? } else { Map::new() };
            crate::calendars::change(k, ctx, m, Some(uuid(c)?), body, util::param(req, "events")).await?
        }
        ("PATCH", ["events", e]) => shared_edit(k, ctx, uuid(e)?, util::body_json(req)?).await?,
        ("GET", ["hours"]) => crate::hours::handle(k, ctx, "GET", None).await?,
        ("PUT", ["hours"]) => crate::hours::handle(k, ctx, "PUT", Some(util::body_json(req)?)).await?,
        _ => return Err(Error::NotFound("calendar endpoint".into())),
    };
    Ok(util::ok(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(v: Value) -> Doc {
        util::obj(v)
    }

    #[test]
    fn display_times_and_ics_of_an_event() {
        let d = event(json!({"id": "0192d3b1-0000-7000-8000-000000000001", "subject": "Board meeting", "starts_at": "2026-11-02T03:30:00.000Z",
            "ends_at": "2026-11-02T05:00:00.000Z", "timezone": "Asia/Kolkata", "owner": "asha@acme.test", "status": "Confirmed", "sequence": 3,
            "visibility": "Private", "recurrence": "FREQ=WEEKLY;COUNT=2", "recurrence_exceptions": ["2026-11-09"],
            "attendees": [{"email": "guest@partner.test", "attendee_name": "Guest", "response": "Accepted"}], "reminders": [{"minutes_before": 10}]}));
        assert_eq!(when(&d), "Mon 2 Nov 2026, 09:00–10:30 (Asia/Kolkata)");
        let ev = vevent(&d, Some("Asha".into()), false, true).unwrap();
        assert_eq!(ev.uid, "0192d3b1-0000-7000-8000-000000000001@ferrum");
        assert_eq!((ev.sequence, ev.status.as_str(), ev.private), (3, "CONFIRMED", true));
        assert_eq!(ev.attendees[0].partstat, "ACCEPTED");
        assert_eq!(ev.alarms, vec![10]);
        // The date exception is written as the occurrence it removes, in the event's zone.
        assert_eq!(ev.exceptions, vec![Exception::At("2026-11-09T03:30:00Z".parse().unwrap())]);
        assert_eq!((ev.tzid.map(|z| z.name()), ev.rrule.as_deref()), (Some("Asia/Kolkata"), Some("FREQ=WEEKLY;COUNT=2")));
        let all_day = event(json!({"subject": "Offsite", "starts_at": "2026-12-24T00:00:00Z", "ends_at": "2026-12-26T00:00:00Z", "all_day": true}));
        assert_eq!(when(&all_day), "Thu 24 Dec 2026 – Fri 25 Dec 2026 (all day)");
        // A reminder at 08:00 UTC for a London 09:00 that is now 09:00 UTC (after the clocks went back) was that day's.
        let at = |v: &str| v.parse::<DateTime<Utc>>().unwrap();
        let london = ics::zone("Europe/London");
        assert!(reminded_that_day(at("2026-11-02T09:00:00Z"), &[at("2026-11-02T08:00:00Z")], london));
        assert!(!reminded_that_day(at("2026-11-02T09:00:00Z"), &[at("2026-10-26T09:00:00Z"), at("2026-11-02T09:00:00Z")], london));
        // Kolkata 00:30 is 19:00 UTC the day before: the day is the event's own.
        assert!(reminded_that_day(at("2026-11-01T19:00:00Z"), &[at("2026-11-01T18:30:00Z")], ics::zone("Asia/Kolkata")));
        assert!(!reminded_that_day(at("2026-11-02T03:30:00Z"), &[at("2026-11-01T03:30:00Z")], ics::zone("Asia/Kolkata")));
        assert!(found(&d, "board ASHA") && found(&d, "guest@partner") && found(&d, "Guest") && !found(&d, "board lunch"));
        assert_eq!(merge(vec![]), vec![]);
        let t = |h: u32| NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc();
        assert_eq!(merge(vec![(t(9), t(10)), (t(12), t(13)), (t(9), t(11))]), vec![(t(9), t(11)), (t(12), t(13))]);
    }
}
