//! A person's working hours and time away (`comms_calendar_hours`): the days and hours they work,
//! in their zone, and an out-of-office period that shows on their calendar, can decline
//! invitations that fall in it (with their message) and is what the scheduling assistant shades.
//! Colleagues see someone's hours and when they are away (as Google Calendar shows them), never
//! more. `GET|PUT /calendar/hours`.

use crate::ics;
use crate::util::{self, s};
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use ferrum_kernel::{Ctx, Doc, Error, Kernel, Result, Tx};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hours {
    /// Working days, 0 Sunday … 6 Saturday.
    pub days: Vec<u8>,
    /// "09:00" and "17:00", on the clock of `timezone`.
    pub from: String,
    pub to: String,
    pub timezone: Option<String>,
    /// Out of office, both days included, in `timezone`.
    pub away_from: Option<NaiveDate>,
    pub away_to: Option<NaiveDate>,
    /// Decline invitations to events in the period, with `away_message`.
    pub away_decline: bool,
    pub away_message: Option<String>,
}

impl Default for Hours {
    fn default() -> Self {
        Hours {
            days: vec![1, 2, 3, 4, 5],
            from: "09:00".into(),
            to: "17:00".into(),
            timezone: None,
            away_from: None,
            away_to: None,
            away_decline: false,
            away_message: None,
        }
    }
}

fn clock(v: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(v.trim(), "%H:%M").ok()
}

impl Hours {
    /// Hours as a person sent them, checked.
    pub fn from_body(body: &Map<String, Value>) -> Result<Hours> {
        let mut h: Hours = serde_json::from_value(Value::Object(body.clone())).map_err(|e| Error::invalid(format!("working hours: {e}")))?;
        h.days.sort();
        h.days.dedup();
        if h.days.iter().any(|d| *d > 6) {
            return Err(Error::field("days", "use 0 (Sunday) to 6 (Saturday)"));
        }
        match (clock(&h.from), clock(&h.to)) {
            (Some(a), Some(b)) if a < b => {}
            (Some(_), Some(_)) => return Err(Error::field("to", "the working day must end after it starts")),
            _ => return Err(Error::field("from", "times are HH:MM, 24-hour")),
        }
        if let Some(z) = h.timezone.as_deref().filter(|z| !z.trim().is_empty()) {
            h.timezone = Some(ics::zone(z).ok_or_else(|| Error::field("timezone", format!("{z} is not a time zone name")))?.name().to_string());
        } else {
            h.timezone = None;
        }
        match (h.away_from, h.away_to) {
            (Some(a), Some(b)) if b < a => return Err(Error::field("away_to", "the time away must end after it starts")),
            (Some(_), None) | (None, Some(_)) => return Err(Error::field("away_to", "give both days of the time away, or neither")),
            _ => {}
        }
        h.away_message = h.away_message.map(|m| util::cut(m.trim(), 500)).filter(|m| !m.is_empty());
        Ok(h)
    }

    /// Whether an event from `start` to `end` touches a day of the time away (days in the person's zone).
    pub fn away_during(&self, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
        let (Some(a), Some(b)) = (self.away_from, self.away_to) else { return false };
        let day = |t: DateTime<Utc>| match self.timezone.as_deref().and_then(ics::zone) {
            Some(z) => t.with_timezone(&z).date_naive(),
            None => t.date_naive(),
        };
        let last = if end > start { end - chrono::Duration::seconds(1) } else { start };
        day(start) <= b && day(last) >= a
    }

    /// What colleagues see: the hours and the time away, not the message or the choice to decline.
    pub fn public(&self) -> Value {
        json!({"days": self.days, "from": self.from, "to": self.to, "timezone": self.timezone, "away_from": self.away_from, "away_to": self.away_to})
    }
}

/// Stored hours of these people (lower-case addresses); people without any are left out.
pub async fn of(tx: &mut Tx, tenant: Uuid, people: &[String]) -> Result<BTreeMap<String, Hours>> {
    let rows: Vec<(String, Value)> = sqlx::query_as("select person, hours from comms_calendar_hours where tenant_id = $1 and person = any($2)")
        .bind(tenant)
        .bind(people)
        .fetch_all(&mut **tx)
        .await?;
    Ok(rows.into_iter().filter_map(|(p, v)| Some((p, serde_json::from_value(v).ok()?))).collect())
}

/// `GET|PUT /calendar/hours`: mine (the defaults until I set them).
pub async fn handle(k: &Kernel, ctx: &Ctx, method: &str, body: Option<Map<String, Value>>) -> Result<Value> {
    let me = ctx.email.to_lowercase();
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let out = match (method, body) {
        ("PUT", Some(body)) => {
            let h = Hours::from_body(&body)?;
            sqlx::query(
                "insert into comms_calendar_hours (tenant_id, person, hours, updated_at) values ($1, $2, $3, now()) \
                 on conflict (tenant_id, person) do update set hours = excluded.hours, updated_at = now()",
            )
            .bind(ctx.tenant)
            .bind(&me)
            .bind(serde_json::to_value(&h).map_err(|e| Error::invalid(e.to_string()))?)
            .execute(&mut *tx)
            .await?;
            serde_json::to_value(h).unwrap_or_default()
        }
        ("GET", _) => {
            let mine = of(&mut tx, ctx.tenant, std::slice::from_ref(&me)).await?.remove(&me);
            json!({"saved": mine.is_some(), "hours": mine.unwrap_or_default()})
        }
        _ => return Err(Error::NotFound("calendar endpoint".into())),
    };
    tx.commit().await?;
    Ok(out)
}

/// Guests who are away when the event happens and chose to decline: their answer becomes
/// "Declined" with their message, unless they answered already. Returns who was declined.
pub async fn decline_away(tx: &mut Tx, tenant: Uuid, doc: &mut Doc) -> Result<Vec<String>> {
    let (Some(start), Some(end)) = (util::time(doc, "starts_at"), util::time(doc, "ends_at")) else { return Ok(vec![]) };
    let waiting: Vec<String> = util::rows(doc, "attendees")
        .iter()
        .filter(|r| s(r, "response").is_none_or(|x| x == "Needs Action") && s(r, "comment").is_none())
        .filter_map(|r| s(r, "email").map(str::to_lowercase))
        .collect();
    if waiting.is_empty() {
        return Ok(vec![]);
    }
    let away: BTreeMap<String, Hours> = of(tx, tenant, &waiting).await?.into_iter().filter(|(_, h)| h.away_decline && h.away_during(start, end)).collect();
    Ok(answer_for_away(doc, &away))
}

fn answer_for_away(doc: &mut Doc, away: &BTreeMap<String, Hours>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(Value::Array(list)) = doc.get_mut("attendees") {
        for r in list.iter_mut().filter_map(Value::as_object_mut) {
            let Some(email) = s(r, "email").map(str::to_lowercase) else { continue };
            if let Some(h) = away.get(&email)
                && s(r, "response").is_none_or(|x| x == "Needs Action")
            {
                r.insert("response".into(), json!("Declined"));
                let note = h.away_message.clone().unwrap_or_else(|| "Out of office".into());
                r.insert("comment".into(), json!(note));
                out.push(email);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn hours_are_checked() {
        let h = Hours::from_body(&body(json!({"days": [5, 1, 1, 2], "from": "08:30", "to": "16:30", "timezone": "india standard time", "away_from": null, "away_to": null, "away_decline": false, "away_message": "  "}))).unwrap();
        assert_eq!((h.days.clone(), h.timezone.as_deref(), h.away_message.as_deref()), (vec![1, 2, 5], Some("Asia/Kolkata"), None));
        for bad in [
            json!({"days": [7], "from": "09:00", "to": "17:00", "timezone": null, "away_from": null, "away_to": null, "away_decline": false, "away_message": null}),
            json!({"days": [1], "from": "17:00", "to": "09:00", "timezone": null, "away_from": null, "away_to": null, "away_decline": false, "away_message": null}),
            json!({"days": [1], "from": "9am", "to": "17:00", "timezone": null, "away_from": null, "away_to": null, "away_decline": false, "away_message": null}),
            json!({"days": [1], "from": "09:00", "to": "17:00", "timezone": "Mars/Base", "away_from": null, "away_to": null, "away_decline": false, "away_message": null}),
            json!({"days": [1], "from": "09:00", "to": "17:00", "timezone": null, "away_from": "2026-12-24", "away_to": null, "away_decline": false, "away_message": null}),
            json!({"days": [1], "from": "09:00", "to": "17:00", "timezone": null, "away_from": "2026-12-24", "away_to": "2026-12-20", "away_decline": false, "away_message": null}),
        ] {
            assert!(Hours::from_body(&body(bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn time_away_declines_invitations_in_it() {
        let t = |v: &str| DateTime::parse_from_rfc3339(v).unwrap().with_timezone(&Utc);
        let away = Hours {
            timezone: Some("Australia/Sydney".into()),
            away_from: NaiveDate::from_ymd_opt(2026, 12, 21),
            away_to: NaiveDate::from_ymd_opt(2027, 1, 1),
            away_decline: true,
            away_message: Some("Back on 4 January".into()),
            ..Hours::default()
        };
        // 20 Dec 22:00 UTC is 21 Dec 09:00 in Sydney: in. 1 Jan 13:00 UTC is 2 Jan in Sydney: out.
        assert!(away.away_during(t("2026-12-20T22:00:00Z"), t("2026-12-20T23:00:00Z")));
        assert!(!away.away_during(t("2027-01-01T13:00:00Z"), t("2027-01-01T14:00:00Z")));
        assert!(!away.away_during(t("2026-12-20T09:00:00Z"), t("2026-12-20T10:00:00Z")));
        let mut doc = util::obj(json!({"attendees": [
            {"email": "Ana@acme.test", "response": "Needs Action"},
            {"email": "bo@acme.test", "response": "Accepted"},
            {"email": "cy@acme.test", "response": "Needs Action"}
        ]}));
        let map: BTreeMap<String, Hours> = [("ana@acme.test".to_string(), away.clone()), ("bo@acme.test".to_string(), away)].into();
        assert_eq!(answer_for_away(&mut doc, &map), vec!["ana@acme.test"]);
        let rows = util::rows(&doc, "attendees");
        assert_eq!((s(&rows[0], "response"), s(&rows[0], "comment")), (Some("Declined"), Some("Back on 4 January")));
        assert_eq!(s(&rows[1], "response"), Some("Accepted"), "an answer given stays");
        assert_eq!(s(&rows[2], "response"), Some("Needs Action"));
    }
}
