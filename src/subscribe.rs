//! Subscribing to an outside calendar by its address (an `.ics` feed: public holidays, a team's
//! published calendar, someone's calendar on another service). The subscription is a calendar of
//! the person's, marked `is_subscription`, whose events are copies of the feed's, read-only, and
//! never invite, export or (unless the person turns `remind` on) remind.
//!
//! The maintenance step fetches each due feed through the platform's egress-safe client: HTTPS
//! only, private and loopback addresses refused after resolving the name, no redirects, a time
//! limit, at most [`MAX_FEED`]; with `If-None-Match` / `If-Modified-Since`; at most hourly, and after
//! failures later each time, up to a day. The feed's events replace the calendar's as a set, keyed
//! by UID (an event gone from the feed goes from the calendar), with their zones. The address may
//! carry a secret token: it is kept as a secret field, shown afterwards only as its host, and never
//! logged or put in a message (an error names what went wrong, never the address).

use crate::calendar;
use crate::ics;
use crate::util::{self, s};
use chrono::Duration;
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

/// The largest feed read.
pub const MAX_FEED: usize = 5 << 20;
/// The most events one feed may bring.
const MAX_EVENTS: usize = 5000;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// How often a feed that works is fetched.
const EVERY: Duration = Duration::hours(1);

/// An address as given (`webcal://` is read as `https://`), checked: HTTPS (plain HTTP only for a
/// test's stand-in), a host, no credentials in it.
pub fn address(raw: &str, allow_http: bool) -> Result<String> {
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let url = if let Some(rest) = lower.strip_prefix("webcals://").or_else(|| lower.strip_prefix("webcal://")) {
        format!("https://{}", &raw[raw.len() - rest.len()..])
    } else {
        raw.to_string()
    };
    if url.len() > 2000 {
        return Err(Error::field("url", "the address is too long"));
    }
    let plain = allow_http && url.to_ascii_lowercase().starts_with("http://");
    if !url.to_ascii_lowercase().starts_with("https://") && !plain {
        return Err(Error::field("url", "the address must start with https:// or webcal://"));
    }
    let after = if plain { &url[7..] } else { &url[8..] };
    let host = host(&format!("https://{after}")).ok_or_else(|| Error::field("url", "the address has no host"))?;
    if host.contains('@') || after.split('/').next().is_some_and(|a| a.contains('@')) {
        return Err(Error::field("url", "an address with a name and password in it is not taken"));
    }
    Ok(url)
}

/// The host of an `https://` address: what is shown of it afterwards.
pub fn host(url: &str) -> Option<String> {
    let rest = url.get(8..)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// What a fetch brought.
#[derive(Debug, PartialEq)]
pub enum Fetched {
    /// The feed says it has not changed since the validators sent.
    Same,
    Body {
        text: String,
        etag: Option<String>,
        modified: Option<String>,
    },
}

/// Fetches a feed (`allow_private` only in tests, for a stand-in on this machine). The error is
/// what the person reads: it never contains the address.
pub async fn fetch(k: &Kernel, url: &str, allow_private: bool, etag: Option<&str>, modified: Option<&str>) -> std::result::Result<Fetched, String> {
    let (client, parsed) = k.vetted_client(url, allow_private, TIMEOUT, "Ferrum Calendar").await.map_err(|e| {
        let e = e.to_string();
        if e.contains("private address") {
            "its address is on a private network".to_string()
        } else if e.contains("must use https") {
            "the address is not HTTPS".to_string()
        } else if e.contains("does not resolve") {
            "its server's name is not known".to_string()
        } else {
            "its server could not be reached".to_string()
        }
    })?;
    let mut req = client.get(parsed).header("accept", "text/calendar, */*;q=0.5");
    if let Some(e) = etag {
        req = req.header("if-none-match", e);
    }
    if let Some(m) = modified {
        req = req.header("if-modified-since", m);
    }
    let mut res = req
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "its server did not answer in time".to_string() } else { "its server could not be reached".to_string() })?;
    let status = res.status().as_u16();
    if status == 304 {
        return Ok(Fetched::Same);
    }
    if (300..400).contains(&status) {
        return Err("it sends calendars elsewhere (a redirect); subscribe to the address it moved to".into());
    }
    if !(200..300).contains(&status) {
        return Err(format!("its server answered {status}"));
    }
    if res.content_length().is_some_and(|l| l as usize > MAX_FEED) {
        return Err(format!("it is larger than {} MB", MAX_FEED >> 20));
    }
    let (etag, modified) = {
        let h = res.headers();
        let get = |n: &str| h.get(n).and_then(|v| v.to_str().ok()).map(|v| util::cut(v, 200));
        (get("etag"), get("last-modified"))
    };
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "it stopped part way".to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_FEED {
            return Err(format!("it is larger than {} MB", MAX_FEED >> 20));
        }
    }
    let text = String::from_utf8(body).map_err(|_| "it is not text (UTF-8)".to_string())?;
    Ok(Fetched::Body { text, etag, modified })
}

/// The feed's events as the calendar keeps them: keyed by UID (one without gets a key from its
/// title and start), with no guests and no organizer (a subscription never invites), the feed's
/// reminders only when `remind`.
pub fn events_of(text: &str, calendar: Uuid, remind: bool) -> std::result::Result<BTreeMap<String, Doc>, String> {
    let parsed = ics::parse(text)?;
    let list = ics::detach_overrides(parsed.events);
    if list.len() > MAX_EVENTS {
        return Err(format!("it has more than {MAX_EVENTS} events"));
    }
    let mut out = BTreeMap::new();
    for e in list {
        let uid = e.uid.clone().unwrap_or_else(|| format!("{}-{}", util::cut(&e.summary, 100), e.start.format("%Y%m%dT%H%M%SZ")));
        let mut doc = calendar::event_fields(&e);
        // The feed's own link is kept only when it is a web address.
        doc.insert("ical_uid".into(), json!(format!("{}#{}", util::cut(&uid, 900), calendar.simple())));
        doc.insert("calendar".into(), json!(calendar));
        doc.insert("fetched".into(), json!(true));
        doc.insert("visibility".into(), json!("Private"));
        doc.insert("attendees".into(), json!([]));
        let alarms: Vec<Value> = if remind { e.alarms.iter().take(5).map(|m| json!({"minutes_before": m})).collect() } else { vec![] };
        doc.insert("reminders".into(), Value::Array(alarms));
        doc.remove("sequence");
        out.insert(uid, doc);
    }
    Ok(out)
}

/// Whether a stored event already says what the feed says (so nothing is written for it).
fn same(stored: &Doc, wanted: &Doc) -> bool {
    wanted.iter().all(|(k, v)| match k.as_str() {
        "starts_at" | "ends_at" => util::time(stored, k) == v.as_str().and_then(util::parse_ts),
        "attendees" | "reminders" => {
            let mine: Vec<i64> = util::rows(stored, k).iter().map(|r| util::int(r, "minutes_before")).collect();
            let theirs: Vec<i64> = v.as_array().into_iter().flatten().filter_map(|r| r.get("minutes_before").and_then(Value::as_i64)).collect();
            k == "attendees" || mine == theirs
        }
        "recurrence_exceptions" => stored.get(k).cloned().unwrap_or(json!([])) == *v,
        _ => stored.get(k).unwrap_or(&Value::Null) == v || (v.is_null() && stored.get(k).is_none()),
    })
}

/// Replaces a subscription's events with the feed's, as a set, in `tx`. Returns (added or changed, removed).
pub async fn replace(k: &Kernel, tx: &mut Tx, tenant: Uuid, calendar: Uuid, owner: &str, feed: BTreeMap<String, Doc>) -> Result<(usize, usize)> {
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(e) || jsonb_build_object('reminders', (select coalesce(jsonb_agg(to_jsonb(r) order by r.idx), '[]') from {} r \
            where r.tenant_id = e.tenant_id and r.parent_id = e.id)) from e_calendar_event e where e.tenant_id = $1 and e.calendar = $2",
        calendar::REMINDERS
    )))
    .bind(tenant)
    .bind(calendar)
    .fetch_all(&mut **tx)
    .await?;
    let mut stored: BTreeMap<String, Doc> = BTreeMap::new();
    for r in rows {
        let d = calendar::normalize(util::obj(r));
        if let Some(uid) = s(&d, "ical_uid").map(str::to_string) {
            stored.insert(uid, d);
        }
    }
    let (mut changed, mut removed) = (0, 0);
    let wanted: BTreeMap<String, Doc> = feed.into_values().map(|d| (s(&d, "ical_uid").unwrap_or_default().to_string(), d)).collect();
    for (uid, doc) in &stored {
        if !wanted.contains_key(uid)
            && let Some(id) = util::id(doc, "id")
        {
            k.delete_tx(&sys, tx, "CalendarEvent", id, None).await?;
            removed += 1;
        }
    }
    for (uid, mut doc) in wanted {
        match stored.get(&uid) {
            Some(old) if same(old, &doc) => {}
            Some(old) => {
                doc.remove("ical_uid");
                k.update_tx(&sys, tx, "CalendarEvent", util::doc_id(old)?, doc, None).await?;
                changed += 1;
            }
            None => {
                doc.insert("owner".into(), json!(owner));
                k.insert_tx(&sys, tx, "CalendarEvent", doc).await?;
                changed += 1;
            }
        }
    }
    Ok((changed, removed))
}

/// The wait before the next fetch after `failures` failed ones in a row: an hour, then twice as
/// long each time, up to a day.
pub fn backoff(failures: i64) -> Duration {
    if failures <= 0 { EVERY } else { (EVERY * 2i32.saturating_pow((failures - 1).clamp(0, 6) as u32)).min(Duration::days(1)) }
}

/// What a subscription's last fetch says, for the side panel.
fn outcome(changed: usize, removed: usize, total: usize) -> String {
    match (changed, removed) {
        (0, 0) => format!("up to date ({total} events)"),
        _ => format!("{total} events ({changed} new or changed, {removed} removed)"),
    }
}

/// Fetches one subscription now and applies what it brings; records the outcome either way.
/// `Err` only for a fault of this server (the database); a feed's failure is recorded and returned as `Ok(Err(..))`.
pub async fn refresh(k: &Kernel, tenant: Uuid, calendar: Uuid, allow_private: bool) -> Result<std::result::Result<String, String>> {
    let mut tx = k.db.tenant_tx(tenant).await?;
    let row: Option<(String, Option<bool>, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as("select owner, remind, fetch_etag, fetch_modified, fetch_failures from e_calendar where tenant_id = $1 and id = $2 and is_subscription")
            .bind(tenant)
            .bind(calendar)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((owner, remind, etag, modified, failures)) = row else { return Err(Error::NotFound("Calendar".into())) };
    let url = k.secret(&mut tx, tenant, "Calendar", calendar, "feed_url").await?.unwrap_or_default();
    tx.commit().await?;
    let got = fetch(k, &url, allow_private, etag.as_deref(), modified.as_deref()).await;
    let mut tx = k.db.tenant_tx(tenant).await?;
    let result = match got {
        Ok(Fetched::Same) => Ok(None),
        Ok(Fetched::Body { text, etag, modified }) => match events_of(&text, calendar, remind.unwrap_or(false)) {
            Ok(feed) => {
                let total = feed.len();
                let (changed, removed) = replace(k, &mut tx, tenant, calendar, &owner, feed).await?;
                Ok(Some((outcome(changed, removed, total), etag, modified)))
            }
            Err(e) => Err(format!("it is not a calendar that can be read: {}", util::cut(&e, 200))),
        },
        Err(e) => Err(e),
    };
    let now = util::now();
    let said = match &result {
        Ok(found) => {
            let (text, etag, modified) = match found {
                Some((t, e, m)) => (Some(t.clone()), e.clone(), m.clone()),
                None => (None, etag, modified),
            };
            sqlx::query(
                "update e_calendar set fetched_at = $3, fetch_result = coalesce($4, fetch_result), fetch_failures = 0, next_fetch_at = $5, \
                 fetch_etag = $6, fetch_modified = $7 where tenant_id = $1 and id = $2",
            )
            .bind(tenant)
            .bind(calendar)
            .bind(now)
            .bind(&text)
            .bind(now + EVERY)
            .bind(etag)
            .bind(modified)
            .execute(&mut *tx)
            .await?;
            Ok(text.unwrap_or_else(|| "up to date".into()))
        }
        Err(e) => {
            let n = failures.unwrap_or(0) + 1;
            sqlx::query("update e_calendar set fetch_result = $3, fetch_failures = $4, next_fetch_at = $5 where tenant_id = $1 and id = $2")
                .bind(tenant)
                .bind(calendar)
                .bind(format!("failed: {e}"))
                .bind(n)
                .bind(now + backoff(n))
                .execute(&mut *tx)
                .await?;
            Err(e.clone())
        }
    };
    tx.commit().await?;
    Ok(said)
}

/// From maintenance: every subscription that is due, soonest first, while `budget` lasts.
pub async fn run(k: &Kernel, tenant: Uuid, budget: std::time::Duration) -> Result<usize> {
    let started = std::time::Instant::now();
    let mut tx = k.db.tenant_tx(tenant).await?;
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_calendar where tenant_id = $1 and is_subscription and (next_fetch_at is null or next_fetch_at <= now()) \
         order by next_fetch_at nulls first limit 100",
    )
    .bind(tenant)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut n = 0;
    for id in due {
        if started.elapsed() >= budget {
            break;
        }
        // The outcome is recorded on the calendar; the address never reaches the log.
        if let Err(e) = refresh(k, tenant, id, false).await? {
            tracing::info!(%tenant, calendar = %id, "calendar subscription not fetched: {e}");
        }
        n += 1;
    }
    Ok(n)
}

/// `POST /calendar/subscriptions {url, name?, tone?, remind?}`: a new subscription, made only once
/// its address gave a calendar (a wrong address is said at once, not left as a broken calendar).
pub async fn subscribe(k: &Kernel, ctx: &Ctx, body: Map<String, Value>, allow_private: bool) -> Result<Value> {
    ctx.require("CalendarEvent", ferrum_kernel::Action::Create)?;
    let url = address(body.get("url").and_then(Value::as_str).unwrap_or_default(), allow_private)?;
    let label = host(&url.replacen("http://", "https://", 1)).unwrap_or_default();
    let remind = body.get("remind").and_then(Value::as_bool).unwrap_or(false);
    let tone = body.get("tone").and_then(Value::as_str).filter(|t| crate::calendars::TONES.contains(t)).unwrap_or("purple");
    let name = body.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(|n| util::cut(n, 100)).unwrap_or_else(|| label.clone());
    let (text, etag, modified) = match fetch(k, &url, allow_private, None, None).await {
        Ok(Fetched::Body { text, etag, modified }) => (text, etag, modified),
        Ok(Fetched::Same) => return Err(Error::invalid("the calendar could not be read: its server sent nothing")),
        Err(e) => return Err(Error::invalid(format!("the calendar could not be read: {e}"))),
    };
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    crate::calendars::ensure_default(k, &mut tx, ctx, &me).await?;
    let doc =
        util::obj(json!({"calendar_name": name, "owner": me, "tone": tone, "is_subscription": true, "feed_url": url, "feed_label": label, "remind": remind}));
    let made = k.insert_tx(&util::sys(ctx), &mut tx, "Calendar", doc).await?;
    let id = util::doc_id(&made)?;
    let feed = events_of(&text, id, remind)
        .map_err(|e| Error::invalid(format!("the calendar could not be read: it is not a calendar that can be read: {}", util::cut(&e, 200))))?;
    let total = feed.len();
    let (changed, removed) = replace(k, &mut tx, ctx.tenant, id, &me, feed).await?;
    let now = util::now();
    sqlx::query(
        "update e_calendar set fetched_at = $3, fetch_result = $4, fetch_failures = 0, next_fetch_at = $5, fetch_etag = $6, fetch_modified = $7 \
         where tenant_id = $1 and id = $2",
    )
    .bind(ctx.tenant)
    .bind(id)
    .bind(now)
    .bind(outcome(changed, removed, total))
    .bind(now + EVERY)
    .bind(etag)
    .bind(modified)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"id": id, "name": name, "events": total, "label": label}))
}

/// A subscription as its owner reads it: where from (the host only), when it last worked, and what happened.
pub fn summary(doc: &Doc) -> Value {
    json!({"label": doc.get("feed_label"), "fetched_at": util::time(doc, "fetched_at").map(util::ts), "result": doc.get("fetch_result"),
        "failures": util::int(doc, "fetch_failures"), "remind": util::b(doc, "remind")})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_https_and_shown_by_host() {
        assert_eq!(address(" webcal://example.org/cal.ics ", false).unwrap(), "https://example.org/cal.ics");
        assert_eq!(address("WEBCAL://Example.org/A.ics", false).unwrap(), "https://Example.org/A.ics");
        assert_eq!(address("webcals://example.org/x", false).unwrap(), "https://example.org/x");
        assert!(address("http://example.org/cal.ics", false).is_err(), "plain HTTP");
        assert!(address("ftp://example.org/cal.ics", false).is_err());
        assert!(address("https://user:pass@example.org/cal.ics", false).is_err(), "credentials in the address");
        assert!(address("https:///x", false).is_err());
        assert_eq!(address("http://127.0.0.1:9/x.ics", true).unwrap(), "http://127.0.0.1:9/x.ics", "a test's stand-in only");
        let secret = "https://calendar.google.com/calendar/ical/ana%40acme.test/private-0123456789abcdef/basic.ics";
        assert_eq!(host(secret).as_deref(), Some("calendar.google.com"), "only the host is shown again");
    }

    #[test]
    fn a_feed_becomes_events_without_guests_or_reminders() {
        let feed = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:h1@feed\r\nDTSTART;VALUE=DATE:20270317\r\nDTEND;VALUE=DATE:20270318\r\nSUMMARY:St Patrick's Day\r\n\
            ORGANIZER:mailto:o@feed.example\r\nATTENDEE:mailto:ana@acme.test\r\nBEGIN:VALARM\r\nTRIGGER:-PT30M\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\n\
            BEGIN:VEVENT\r\nDTSTART;TZID=America/New_York:20270310T090000\r\nDTEND;TZID=America/New_York:20270310T100000\r\nSUMMARY:No uid\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let cal: Uuid = "0192d3b1-0000-7000-8000-0000000000c1".parse().unwrap();
        let got = events_of(feed, cal, false).unwrap();
        assert_eq!(got.len(), 2);
        let h = &got["h1@feed"];
        assert_eq!((h["subject"].as_str(), h["all_day"].as_bool(), h["fetched"].as_bool()), (Some("St Patrick's Day"), Some(true), Some(true)));
        assert_eq!((h["attendees"].clone(), h["reminders"].clone()), (json!([]), json!([])));
        assert_eq!(h["ical_uid"], json!(format!("h1@feed#{}", cal.simple())));
        assert!(h.get("organizer").is_none());
        // The zone it was written in is kept: 09:00 New York is 14:00 UTC on 10 March 2027 (before its clocks change on the 14th).
        let n = got.values().find(|d| d["subject"] == json!("No uid")).unwrap();
        assert_eq!((n["starts_at"].as_str(), n["timezone"].as_str()), (Some("2027-03-10T14:00:00.000Z"), Some("America/New_York")));
        assert_eq!(events_of(feed, cal, true).unwrap()["h1@feed"]["reminders"], json!([{"minutes_before": 30}]), "reminders only when asked");
        assert!(events_of("<html>nope</html>", cal, false).is_err());
        assert!(same(
            &util::obj(json!({"subject": "A", "starts_at": "2027-03-10T13:00:00Z", "reminders": []})),
            &util::obj(json!({"subject": "A", "starts_at": "2027-03-10T13:00:00.000Z", "reminders": []}))
        ));
        assert!(!same(&util::obj(json!({"subject": "A"})), &util::obj(json!({"subject": "B"}))));
    }

    #[test]
    fn failures_wait_longer_each_time_up_to_a_day() {
        let h = |n| backoff(n).num_hours();
        assert_eq!((h(0), h(1), h(2), h(3), h(5), h(6), h(40)), (1, 1, 2, 4, 16, 24, 24));
    }
}
