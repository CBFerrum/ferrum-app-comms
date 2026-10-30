//! iCalendar (RFC 5545) text: writing invitations and feeds (TEXT escaping, 75-octet line
//! folding, CRLF) and a tolerant VEVENT parser for imports and calendar apps (TZID through the IANA
//! database, all-day dates, DURATION, EXDATE, RRULE, RECURRENCE-ID, ORGANIZER, ATTENDEE, VALARM
//! triggers). Components it has no use for (VTIMEZONE, VTODO) are skipped without their
//! properties leaking into the event.

use crate::recur::{self, Exception};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};

/// Escapes a TEXT value: backslash, semicolon, comma and line breaks.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str("\\n");
            }
            '\n' => out.push_str("\\n"),
            c if c.is_control() && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// Folds a content line so no physical line exceeds 75 octets (continuations start with a space
/// that counts towards the limit); never splits a UTF-8 character. No trailing CRLF.
pub fn fold(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + line.len() / 70 * 3);
    let mut used = 0;
    for c in line.chars() {
        let n = c.len_utf8();
        if used + n > 75 {
            out.push_str("\r\n ");
            used = 1;
        }
        out.push(c);
        used += n;
    }
    out
}

fn line(out: &mut String, s: &str) {
    out.push_str(&fold(s));
    out.push_str("\r\n");
}

/// A parameter value, quoted when it holds characters with a meaning in content lines.
fn param(v: &str) -> String {
    let clean: String = v.chars().filter(|c| *c != '"' && !c.is_control()).collect();
    if clean.contains([';', ':', ',']) { format!("\"{clean}\"") } else { clean }
}

fn utc(t: DateTime<Utc>) -> String {
    t.format("%Y%m%dT%H%M%SZ").to_string()
}

fn date(d: NaiveDate) -> String {
    d.format("%Y%m%d").to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attendee {
    pub email: String,
    pub name: Option<String>,
    /// RFC 5545 PARTSTAT: NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE.
    pub partstat: String,
}

#[derive(Debug, Clone)]
pub struct VEvent {
    pub uid: String,
    pub sequence: i64,
    pub stamp: DateTime<Utc>,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub url: Option<String>,
    /// CONFIRMED, TENTATIVE or CANCELLED.
    pub status: String,
    pub private: bool,
    pub categories: Option<String>,
    pub rrule: Option<String>,
    pub exceptions: Vec<Exception>,
    pub organizer: Option<(Option<String>, String)>,
    pub attendees: Vec<Attendee>,
    /// Reminders as minutes before the start (VALARM DISPLAY).
    pub alarms: Vec<i64>,
}

fn write_event(out: &mut String, e: &VEvent) {
    line(out, "BEGIN:VEVENT");
    line(out, &format!("UID:{}", escape(&e.uid)));
    line(out, &format!("SEQUENCE:{}", e.sequence.max(0)));
    line(out, &format!("DTSTAMP:{}", utc(e.stamp)));
    if e.all_day {
        let end = e.end.date_naive().max(e.start.date_naive().succ_opt().unwrap_or(e.start.date_naive()));
        line(out, &format!("DTSTART;VALUE=DATE:{}", date(e.start.date_naive())));
        line(out, &format!("DTEND;VALUE=DATE:{}", date(end)));
    } else {
        line(out, &format!("DTSTART:{}", utc(e.start)));
        line(out, &format!("DTEND:{}", utc(e.end.max(e.start))));
    }
    line(out, &format!("SUMMARY:{}", escape(&e.summary)));
    for (name, v) in [("DESCRIPTION", &e.description), ("LOCATION", &e.location), ("CATEGORIES", &e.categories)] {
        if let Some(v) = v.as_deref().filter(|v| !v.trim().is_empty()) {
            line(out, &format!("{name}:{}", escape(v)));
        }
    }
    if let Some(u) = e.url.as_deref().filter(|u| !u.trim().is_empty()) {
        line(out, &format!("URL:{}", u.trim()));
    }
    line(out, &format!("STATUS:{}", e.status));
    line(out, &format!("CLASS:{}", if e.private { "PRIVATE" } else { "PUBLIC" }));
    line(out, &format!("TRANSP:{}", if e.status == "CANCELLED" { "TRANSPARENT" } else { "OPAQUE" }));
    if let Some(r) = &e.rrule {
        line(out, &format!("RRULE:{r}"));
    }
    for x in &e.exceptions {
        match (x, e.all_day) {
            (Exception::Day(d), true) => line(out, &format!("EXDATE;VALUE=DATE:{}", date(*d))),
            (Exception::Day(d), false) => line(out, &format!("EXDATE:{}", utc(d.and_time(e.start.time()).and_utc()))),
            (Exception::At(t), true) => line(out, &format!("EXDATE;VALUE=DATE:{}", date(t.date_naive()))),
            (Exception::At(t), false) => line(out, &format!("EXDATE:{}", utc(*t))),
        }
    }
    if let Some((name, email)) = &e.organizer {
        let cn = name.as_deref().map(|n| format!(";CN={}", param(n))).unwrap_or_default();
        line(out, &format!("ORGANIZER{cn}:mailto:{email}"));
    }
    for a in &e.attendees {
        let cn = a.name.as_deref().filter(|n| !n.trim().is_empty()).map(|n| format!(";CN={}", param(n))).unwrap_or_default();
        line(out, &format!("ATTENDEE{cn};ROLE=REQ-PARTICIPANT;PARTSTAT={};RSVP=TRUE:mailto:{}", a.partstat, a.email));
    }
    for m in &e.alarms {
        line(out, "BEGIN:VALARM");
        line(out, "ACTION:DISPLAY");
        line(out, &format!("DESCRIPTION:{}", escape(&e.summary)));
        line(out, &format!("TRIGGER:-PT{}M", m.max(&0)));
        line(out, "END:VALARM");
    }
    line(out, "END:VEVENT");
}

/// A VCALENDAR with `events`; `method` is REQUEST/CANCEL for invitations, `None` for feeds.
pub fn calendar(method: Option<&str>, name: Option<&str>, events: &[VEvent]) -> String {
    let mut out = String::new();
    line(&mut out, "BEGIN:VCALENDAR");
    line(&mut out, "VERSION:2.0");
    line(&mut out, "PRODID:-//Ferrum//Communication//EN");
    line(&mut out, "CALSCALE:GREGORIAN");
    if let Some(m) = method {
        line(&mut out, &format!("METHOD:{m}"));
    }
    if let Some(n) = name {
        line(&mut out, &format!("X-WR-CALNAME:{}", escape(n)));
    }
    for e in events {
        write_event(&mut out, e);
    }
    line(&mut out, "END:VCALENDAR");
    out
}

// ───────────────────────────── parsing ─────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEvent {
    pub uid: Option<String>,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub url: Option<String>,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    /// Canonical RRULE text (validated).
    pub rrule: Option<String>,
    pub exceptions: Vec<Exception>,
    /// CONFIRMED, TENTATIVE or CANCELLED.
    pub status: Option<String>,
    /// CLASS: `Some(false)` for PUBLIC, `Some(true)` otherwise, `None` without one.
    pub private: Option<bool>,
    pub sequence: i64,
    pub categories: Option<String>,
    /// RECURRENCE-ID: this VEVENT changes one occurrence of the series with its UID.
    pub recurrence_id: Option<(DateTime<Utc>, bool)>,
    /// ORGANIZER's address (lower case).
    pub organizer: Option<String>,
    pub attendees: Vec<Attendee>,
    /// VALARM triggers before the start, in minutes.
    pub alarms: Vec<i64>,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub method: Option<String>,
    pub events: Vec<ParsedEvent>,
    /// Problems that did not stop the import (unknown time zones, unsupported rules...).
    pub warnings: Vec<String>,
}

/// Joins folded lines (a line break followed by a space or tab continues the previous line).
pub fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(rest) = l.strip_prefix([' ', '\t'])
            && let Some(last) = out.last_mut()
        {
            last.push_str(rest);
            continue;
        }
        if !l.is_empty() {
            out.push(l.to_string());
        }
    }
    out
}

/// `NAME;PARAM=VALUE;...:value` → upper-cased name, params (upper-cased keys, unquoted values), value.
fn content_line(l: &str) -> Option<(String, Vec<(String, String)>, String)> {
    let mut in_quotes = false;
    let mut split = None;
    for (i, c) in l.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                split = Some(i);
                break;
            }
            _ => {}
        }
    }
    let i = split?;
    let (head, value) = (&l[..i], &l[i + 1..]);
    let mut parts = Vec::new();
    let (mut cur, mut quoted) = (String::new(), false);
    for c in head.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            ';' if !quoted => parts.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    parts.push(cur);
    let name = parts.first()?.trim().to_ascii_uppercase();
    let params =
        parts[1..].iter().filter_map(|p| p.split_once('=')).map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string())).collect();
    Some((name, params, value.to_string()))
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(x @ (',' | ';' | '\\' | ':' | '"')) => out.push(x),
            Some(x) => {
                out.push('\\');
                out.push(x);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn get<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// Windows zone names Outlook writes in TZID, mapped to IANA names.
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("UTC", "UTC"),
    ("GMT Standard Time", "Europe/London"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("Central European Standard Time", "Europe/Warsaw"),
    ("Romance Standard Time", "Europe/Paris"),
    ("E. Europe Standard Time", "Europe/Bucharest"),
    ("FLE Standard Time", "Europe/Kiev"),
    ("Russian Standard Time", "Europe/Moscow"),
    ("Eastern Standard Time", "America/New_York"),
    ("Central Standard Time", "America/Chicago"),
    ("Mountain Standard Time", "America/Denver"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Arabian Standard Time", "Asia/Dubai"),
    ("Singapore Standard Time", "Asia/Singapore"),
    ("China Standard Time", "Asia/Shanghai"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
    ("Korea Standard Time", "Asia/Seoul"),
    ("AUS Eastern Standard Time", "Australia/Sydney"),
    ("New Zealand Standard Time", "Pacific/Auckland"),
    ("South Africa Standard Time", "Africa/Johannesburg"),
    ("E. South America Standard Time", "America/Sao_Paulo"),
];

/// An IANA (or common Windows) zone name.
pub fn zone(name: &str) -> Option<chrono_tz::Tz> {
    let n = name.trim().trim_start_matches('/');
    n.parse::<chrono_tz::Tz>()
        .ok()
        .or_else(|| WINDOWS_ZONES.iter().find(|(w, _)| w.eq_ignore_ascii_case(n)).and_then(|(_, iana)| iana.parse().ok()))
        .or_else(|| n.rsplit_once('/').and_then(|(_, tail)| tail.parse().ok()))
}

/// A DATE or DATE-TIME value as a UTC instant; `true` when it is a date.
fn when(value: &str, params: &[(String, String)], warnings: &mut Vec<String>) -> Result<(DateTime<Utc>, bool), String> {
    let v = value.trim();
    if get(params, "VALUE").is_some_and(|x| x.eq_ignore_ascii_case("DATE")) || (v.len() == 8 && !v.contains('T')) {
        let d = NaiveDate::parse_from_str(&v[..v.len().min(8)], "%Y%m%d").map_err(|_| format!("'{v}' is not a date"))?;
        return Ok((d.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc(), true));
    }
    let naive = NaiveDateTime::parse_from_str(v.trim_end_matches(['Z', 'z']), "%Y%m%dT%H%M%S").map_err(|_| format!("'{v}' is not a date-time"))?;
    if v.ends_with(['Z', 'z']) {
        return Ok((naive.and_utc(), false));
    }
    let Some(tzid) = get(params, "TZID") else {
        return Ok((naive.and_utc(), false));
    };
    let Some(tz) = zone(tzid) else {
        let w = format!("unknown time zone '{tzid}', read as UTC");
        if !warnings.contains(&w) {
            warnings.push(w);
        }
        return Ok((naive.and_utc(), false));
    };
    // A wall-clock time skipped by a daylight-saving jump is read as the time an hour later.
    let local = tz.from_local_datetime(&naive).earliest().or_else(|| tz.from_local_datetime(&(naive + Duration::hours(1))).earliest());
    local.map(|t| (t.with_timezone(&Utc), false)).ok_or_else(|| format!("'{v}' does not exist in {tzid}"))
}

/// `P1W`, `P2D`, `PT1H30M`, `-PT15M`...
pub fn duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix(['P', 'p'])?;
    let (mut total, mut num, mut in_time, mut any) = (0i64, String::new(), false, false);
    for c in s.chars() {
        match c.to_ascii_uppercase() {
            'T' => in_time = true,
            d if d.is_ascii_digit() => num.push(d),
            unit => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                any = true;
                total += n * match (unit, in_time) {
                    ('W', false) => 7 * 86_400,
                    ('D', false) => 86_400,
                    ('H', true) => 3_600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
            }
        }
    }
    (any && num.is_empty()).then(|| Duration::seconds(if neg { -total } else { total }))
}

#[derive(Default)]
struct Draft {
    uid: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    url: Option<String>,
    start: Option<(DateTime<Utc>, bool)>,
    end: Option<DateTime<Utc>>,
    duration: Option<Duration>,
    rrule: Option<String>,
    exceptions: Vec<Exception>,
    status: Option<String>,
    private: Option<bool>,
    sequence: i64,
    categories: Option<String>,
    recurrence_id: Option<(DateTime<Utc>, bool)>,
    organizer: Option<String>,
    attendees: Vec<Attendee>,
    alarms: Vec<i64>,
}

impl Draft {
    fn finish(self, warnings: &mut Vec<String>) -> Option<ParsedEvent> {
        let label = self.summary.clone().or(self.uid.clone()).unwrap_or_else(|| "(untitled)".into());
        let Some((start, all_day)) = self.start else {
            warnings.push(format!("event '{label}' has no start (DTSTART) and was skipped"));
            return None;
        };
        let end = match (self.end, self.duration) {
            (Some(e), _) => e,
            (None, Some(d)) => start + d,
            (None, None) if all_day => start + Duration::days(1),
            (None, None) => start,
        };
        let rrule = match self.rrule.as_deref().map(recur::parse) {
            Some(Ok(r)) => Some(r.to_string()),
            Some(Err(e)) => {
                warnings.push(format!("event '{label}': recurrence not imported ({e})"));
                None
            }
            None => None,
        };
        Some(ParsedEvent {
            uid: self.uid,
            summary: self.summary.unwrap_or_else(|| "(no title)".into()),
            description: self.description,
            location: self.location,
            url: self.url,
            start,
            end: end.max(start),
            all_day,
            rrule,
            exceptions: self.exceptions,
            status: self.status,
            private: self.private,
            sequence: self.sequence,
            categories: self.categories,
            recurrence_id: self.recurrence_id,
            organizer: self.organizer,
            attendees: self.attendees,
            alarms: self.alarms,
        })
    }
}

/// `mailto:Ana@Example.com` → `ana@example.com`.
fn mailto(value: &str) -> Option<String> {
    let v = value.trim();
    let v = if v.len() > 7 && v[..7].eq_ignore_ascii_case("mailto:") { &v[7..] } else { v };
    Some(v.trim().to_lowercase()).filter(|e| e.contains('@') && !e.contains(char::is_whitespace))
}

/// Changes to single occurrences (VEVENTs with a RECURRENCE-ID) become events of their own and
/// leave their series, as Ferrum has no changes to single occurrences; a cancelled occurrence only
/// leaves it. The detached event's UID is `{uid}-{occurrence}`, so reading the same text again finds
/// the same events.
pub fn detach_overrides(events: Vec<ParsedEvent>) -> Vec<ParsedEvent> {
    let (overrides, mut out): (Vec<ParsedEvent>, Vec<ParsedEvent>) = events.into_iter().partition(|e| e.recurrence_id.is_some());
    for mut o in overrides {
        let Some((at, is_date)) = o.recurrence_id.take() else { continue };
        let x = if is_date { Exception::Day(at.date_naive()) } else { Exception::At(at) };
        if let Some(series) = out.iter_mut().find(|m| m.rrule.is_some() && m.uid.is_some() && m.uid == o.uid)
            && !series.exceptions.contains(&x)
        {
            series.exceptions.push(x);
        }
        if o.status.as_deref() == Some("CANCELLED") {
            continue;
        }
        let stamp = if is_date { at.format("%Y%m%d").to_string() } else { at.format("%Y%m%dT%H%M%SZ").to_string() };
        o.uid = o.uid.map(|u| format!("{u}-{stamp}"));
        o.rrule = None;
        o.exceptions.clear();
        out.push(o);
    }
    out
}

/// Parses every VEVENT of an iCalendar text.
pub fn parse(text: &str) -> Result<Parsed, String> {
    let lines = unfold(text);
    if !lines.first().is_some_and(|l| l.trim().eq_ignore_ascii_case("BEGIN:VCALENDAR")) {
        return Err("not an iCalendar file (it must start with BEGIN:VCALENDAR)".into());
    }
    let mut out = Parsed::default();
    let mut stack: Vec<String> = Vec::new();
    let mut draft: Option<Draft> = None;
    for l in &lines {
        let Some((name, params, value)) = content_line(l) else { continue };
        match name.as_str() {
            "BEGIN" => {
                let comp = value.trim().to_ascii_uppercase();
                if comp == "VEVENT" && stack.last().map(String::as_str) == Some("VCALENDAR") {
                    draft = Some(Draft::default());
                }
                stack.push(comp);
                continue;
            }
            "END" => {
                let comp = value.trim().to_ascii_uppercase();
                if stack.last() == Some(&comp) {
                    stack.pop();
                }
                if comp == "VEVENT"
                    && let Some(d) = draft.take()
                    && let Some(e) = d.finish(&mut out.warnings)
                {
                    out.events.push(e);
                }
                continue;
            }
            _ => {}
        }
        match stack.last().map(String::as_str) {
            Some("VCALENDAR") if name == "METHOD" => out.method = Some(value.trim().to_ascii_uppercase()),
            Some("VEVENT") => {
                let Some(d) = draft.as_mut() else { continue };
                let text = || Some(unescape(&value)).filter(|s| !s.trim().is_empty());
                match name.as_str() {
                    "UID" => d.uid = text(),
                    "SUMMARY" => d.summary = text(),
                    "DESCRIPTION" => d.description = text(),
                    "LOCATION" => d.location = text(),
                    "URL" => d.url = Some(value.trim().to_string()).filter(|s| !s.is_empty()),
                    "CATEGORIES" => d.categories = text(),
                    "STATUS" => d.status = Some(value.trim().to_ascii_uppercase()),
                    "CLASS" => d.private = Some(!value.trim().eq_ignore_ascii_case("PUBLIC")),
                    "SEQUENCE" => d.sequence = value.trim().parse().unwrap_or(0),
                    "RRULE" => d.rrule = Some(value.trim().to_string()),
                    "DTSTART" => d.start = Some(when(&value, &params, &mut out.warnings)?),
                    "RECURRENCE-ID" => d.recurrence_id = Some(when(&value, &params, &mut out.warnings)?),
                    "ORGANIZER" => d.organizer = mailto(&value),
                    "ATTENDEE" => {
                        if let Some(email) = mailto(&value) {
                            let name = get(&params, "CN").map(str::trim).filter(|n| !n.is_empty() && !n.eq_ignore_ascii_case(&email)).map(str::to_string);
                            let partstat = get(&params, "PARTSTAT").unwrap_or("NEEDS-ACTION").to_ascii_uppercase();
                            d.attendees.push(Attendee { email, name, partstat });
                        }
                    }
                    "DTEND" => d.end = Some(when(&value, &params, &mut out.warnings)?.0),
                    "DURATION" => d.duration = duration(&value),
                    "EXDATE" => {
                        for v in value.split(',').filter(|v| !v.trim().is_empty()) {
                            let (t, is_date) = when(v, &params, &mut out.warnings)?;
                            d.exceptions.push(if is_date { Exception::Day(t.date_naive()) } else { Exception::At(t) });
                        }
                    }
                    _ => {}
                }
            }
            // A reminder relative to the start; absolute ones and those after the start are not kept.
            Some("VALARM") if name == "TRIGGER" && stack.get(stack.len().wrapping_sub(2)).map(String::as_str) == Some("VEVENT") => {
                let related_start = get(&params, "RELATED").is_none_or(|r| r.eq_ignore_ascii_case("START"));
                if let (Some(d), true, Some(before)) = (draft.as_mut(), related_start, duration(&value).filter(|t| *t <= Duration::zero())) {
                    let minutes = (-before).num_minutes();
                    if minutes <= 40_320 && !d.alarms.contains(&minutes) {
                        d.alarms.push(minutes);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn text_escaping() {
        assert_eq!(escape("Budget, Q3; review\\notes\r\nline 2\nline 3"), "Budget\\, Q3\\; review\\\\notes\\nline 2\\nline 3");
        assert_eq!(unescape(&escape("a,b;c\\d\ne")), "a,b;c\\d\ne");
        assert_eq!(param("Rao, Priya"), "\"Rao, Priya\"");
        assert_eq!(param("Sam \"The\" Man"), "Sam The Man");
    }

    #[test]
    fn folding_at_75_octets_keeps_characters_whole() {
        let ascii = format!("DESCRIPTION:{}", "x".repeat(200));
        let multi = format!("SUMMARY:{}", "Réunion 日本語 ✓ ".repeat(12));
        for src in [ascii, multi] {
            let folded = fold(&src);
            for (i, physical) in folded.split("\r\n").enumerate() {
                assert!(physical.len() <= 75, "line {i} is {} octets", physical.len());
                assert!(i == 0 || physical.starts_with(' '));
            }
            assert_eq!(unfold(&folded), vec![src.clone()]);
        }
        assert_eq!(fold("SHORT:line"), "SHORT:line");
    }

    fn sample_event() -> VEvent {
        VEvent {
            uid: "abc@ferrum".into(),
            sequence: 2,
            stamp: t("2026-10-29T10:00:00Z"),
            start: t("2026-11-02T09:00:00Z"),
            end: t("2026-11-02T10:30:00Z"),
            all_day: false,
            summary: "Q3 review: budget, hiring; plans".into(),
            description: Some("Agenda:\n1. Budget\n2. Hiring".into()),
            location: Some("Room 4, Pune".into()),
            url: Some("https://meet.example.com/q3".into()),
            status: "CONFIRMED".into(),
            private: false,
            categories: None,
            rrule: Some("FREQ=WEEKLY;BYDAY=MO;COUNT=4".into()),
            exceptions: vec![Exception::Day(NaiveDate::from_ymd_opt(2026, 11, 9).unwrap())],
            organizer: Some((Some("Asha Rao".into()), "asha@acme.test".into())),
            attendees: vec![Attendee { email: "guest@partner.test".into(), name: Some("Guest, External".into()), partstat: "NEEDS-ACTION".into() }],
            alarms: vec![15],
        }
    }

    #[test]
    fn writes_invitations_and_reads_them_back() {
        let ics = calendar(Some("REQUEST"), None, &[sample_event()]);
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
        assert!(ics.ends_with("END:VCALENDAR\r\n"));
        assert!(ics.contains("\r\nMETHOD:REQUEST\r\n"));
        assert!(ics.contains("SUMMARY:Q3 review: budget\\, hiring\\; plans\r\n"));
        assert!(ics.contains("LOCATION:Room 4\\, Pune\r\n"));
        assert!(ics.contains("ORGANIZER;CN=Asha Rao:mailto:asha@acme.test\r\n"));
        let lines = unfold(&ics);
        assert!(lines.iter().any(|l| l == "ATTENDEE;CN=\"Guest, External\";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:guest@partner.test"));
        assert!(ics.contains("EXDATE:20261109T090000Z\r\n"));
        assert!(ics.contains("TRIGGER:-PT15M\r\n"));
        assert!(ics.split("\r\n").all(|l| l.len() <= 75));
        let parsed = parse(&ics).unwrap();
        assert_eq!(parsed.method.as_deref(), Some("REQUEST"));
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        let e = &parsed.events[0];
        assert_eq!(e.uid.as_deref(), Some("abc@ferrum"));
        assert_eq!(e.summary, "Q3 review: budget, hiring; plans");
        assert_eq!(e.description.as_deref(), Some("Agenda:\n1. Budget\n2. Hiring"));
        assert_eq!((e.start, e.end, e.all_day), (t("2026-11-02T09:00:00Z"), t("2026-11-02T10:30:00Z"), false));
        assert_eq!(e.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO;COUNT=4"));
        assert_eq!(e.exceptions, vec![Exception::At(t("2026-11-09T09:00:00Z"))]);
        assert_eq!(e.sequence, 2);
        // The VALARM's DESCRIPTION did not overwrite the event's.
        assert_eq!(parsed.events.len(), 1);
    }

    #[test]
    fn all_day_events_use_dates() {
        let mut e = sample_event();
        e.all_day = true;
        e.start = t("2026-12-24T00:00:00Z");
        e.end = t("2026-12-26T00:00:00Z");
        e.rrule = None;
        e.exceptions.clear();
        let ics = calendar(None, Some("Holidays"), &[e]);
        assert!(ics.contains("DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226\r\n"));
        assert!(ics.contains("X-WR-CALNAME:Holidays\r\n"));
        let back = &parse(&ics).unwrap().events[0];
        assert!(back.all_day);
        assert_eq!((back.start, back.end), (t("2026-12-24T00:00:00Z"), t("2026-12-26T00:00:00Z")));
    }

    #[test]
    fn reads_real_world_invitations() {
        // Shaped like a Google Calendar invitation: VTIMEZONE, TZID times, folded text, VALARM.
        let google = "BEGIN:VCALENDAR\r\nPRODID:-//Google Inc//Google Calendar 70.9054//EN\r\nVERSION:2.0\r\nCALSCALE:GREGORIAN\r\nMETHOD:REQUEST\r\n\
BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nTZNAME:EST\r\nDTSTART:19701101T020000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nDTSTART;TZID=America/New_York:20261110T090000\r\nDTEND;TZID=America/New_York:20261110T093000\r\n\
RRULE:FREQ=WEEKLY;WKST=SU;COUNT=6;BYDAY=TU\r\nEXDATE;TZID=America/New_York:20261117T090000,20261124T090000\r\n\
DTSTAMP:20261029T120000Z\r\nORGANIZER;CN=Pat Lee:mailto:pat@example.com\r\nUID:7kukuqrfedlm2f9t2vt1bk3q4d@google.com\r\n\
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=asha@acme.test;X-NUM-GUESTS=0:mailto:asha@acme.test\r\n\
DESCRIPTION:Weekly sync\\, see https://docs.example.com/notes?a=1&b=2 for the agen\r\n da.\\nBring numbers.\r\n\
LOCATION:\"Room \\\"Blue\\\"\"\r\nSEQUENCE:0\r\nSTATUS:CONFIRMED\r\nSUMMARY:Partner sync\r\nTRANSP:OPAQUE\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:This is an event reminder\r\nTRIGGER:-P0DT0H10M0S\r\nEND:VALARM\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261126\r\nSUMMARY:Thanksgiving\r\nUID:holiday-1@example.com\r\nCLASS:PRIVATE\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nSUMMARY:Broken\r\nUID:x@y\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let p = parse(google).unwrap();
        assert_eq!(p.events.len(), 2);
        let sync = &p.events[0];
        assert_eq!(sync.summary, "Partner sync");
        assert_eq!(sync.start, t("2026-11-10T14:00:00Z"), "09:00 in New York in November is 14:00 UTC");
        assert_eq!(sync.end - sync.start, Duration::minutes(30));
        assert_eq!(sync.description.as_deref(), Some("Weekly sync, see https://docs.example.com/notes?a=1&b=2 for the agenda.\nBring numbers."));
        assert_eq!(sync.exceptions, vec![Exception::At(t("2026-11-17T14:00:00Z")), Exception::At(t("2026-11-24T14:00:00Z"))]);
        assert_eq!(sync.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;COUNT=6;WKST=SU"));
        let holiday = &p.events[1];
        assert!(holiday.all_day && holiday.private == Some(true));
        assert_eq!(holiday.end - holiday.start, Duration::days(1));
        assert!(p.warnings.iter().any(|w| w.contains("Broken")), "{:?}", p.warnings);
        // Outlook writes Windows zone names; unknown zones fall back to UTC with a warning.
        let outlook = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=India Standard Time:20261102T100000\nDURATION:PT1H30M\nSUMMARY:Call\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART;TZID=Mars/Olympus:20261102T100000\nSUMMARY:Odd\nEND:VEVENT\nEND:VCALENDAR\n";
        let p = parse(outlook).unwrap();
        assert_eq!(p.events[0].start, t("2026-11-02T04:30:00Z"));
        assert_eq!(p.events[0].end, t("2026-11-02T06:00:00Z"));
        assert_eq!(p.events[1].start, t("2026-11-02T10:00:00Z"));
        assert!(p.warnings.iter().any(|w| w.contains("Mars/Olympus")));
        assert!(parse("hello").is_err());
        assert_eq!(duration("-P1DT2H"), Some(-Duration::hours(26)));
        assert_eq!(duration("P2W"), Some(Duration::days(14)));
        assert_eq!(duration("PT"), None);
    }

    #[test]
    fn calendar_app_uploads() {
        // Shaped like Apple Calendar's: a weekly series with one occurrence moved and one cancelled,
        // guests and an alert.
        let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 19//EN\r\n\
BEGIN:VTIMEZONE\r\nTZID:Asia/Kolkata\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nDTSTART:19451015T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n\
BEGIN:VEVENT\r\nUID:5D3A-11\r\nDTSTART;TZID=Asia/Kolkata:20261102T100000\r\nDTEND;TZID=Asia/Kolkata:20261102T103000\r\nSUMMARY:Stand-up\r\n\
RRULE:FREQ=WEEKLY;COUNT=4\r\nORGANIZER;CN=Ana Rao:mailto:Ana@acme.test\r\n\
ATTENDEE;CN=Ana Rao;PARTSTAT=ACCEPTED:mailto:ana@acme.test\r\nATTENDEE;CN=\"Bo, Lee\";PARTSTAT=TENTATIVE:MAILTO:bo@partner.test\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nTRIGGER;VALUE=DATE-TIME:20261101T000000Z\r\nEND:VALARM\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:5D3A-11\r\nRECURRENCE-ID;TZID=Asia/Kolkata:20261109T100000\r\nDTSTART;TZID=Asia/Kolkata:20261109T120000\r\n\
DTEND;TZID=Asia/Kolkata:20261109T123000\r\nSUMMARY:Stand-up (moved)\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:5D3A-11\r\nRECURRENCE-ID;TZID=Asia/Kolkata:20261116T100000\r\nDTSTART;TZID=Asia/Kolkata:20261116T100000\r\n\
SUMMARY:Stand-up\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let parsed = parse(text).unwrap();
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        let series = &parsed.events[0];
        assert_eq!(series.organizer.as_deref(), Some("ana@acme.test"));
        assert_eq!(
            series.attendees.iter().map(|a| (a.email.as_str(), a.name.as_deref(), a.partstat.as_str())).collect::<Vec<_>>(),
            vec![("ana@acme.test", Some("Ana Rao"), "ACCEPTED"), ("bo@partner.test", Some("Bo, Lee"), "TENTATIVE")]
        );
        assert_eq!(series.alarms, vec![15], "the alert relative to the start; the absolute one is not kept");
        assert_eq!(parsed.events[1].recurrence_id, Some((t("2026-11-09T04:30:00Z"), false)));

        let events = detach_overrides(parsed.events);
        assert_eq!(events.len(), 2, "the series and the moved occurrence; the cancelled one only leaves the series");
        assert_eq!(events[0].exceptions, vec![Exception::At(t("2026-11-09T04:30:00Z")), Exception::At(t("2026-11-16T04:30:00Z"))]);
        let moved = &events[1];
        assert_eq!((moved.uid.as_deref(), moved.start, moved.rrule.as_ref()), (Some("5D3A-11-20261109T043000Z"), t("2026-11-09T06:30:00Z"), None));
        assert_eq!(detach_overrides(parse(text).unwrap().events)[1].uid, moved.uid, "the same text detaches the same event");
    }
}
