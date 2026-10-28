//! Recurrence rules (an RRULE subset of RFC 5545) and occurrence expansion.
//!
//! `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL`, `BYDAY` (`MO`..`SU`; ordinals such as
//! `1MO` or `-1FR` with MONTHLY), `BYMONTHDAY` (MONTHLY; negative counts from the month's end),
//! `WKST`, and `COUNT` or `UNTIL`. Occurrences repeat at the start's UTC time of day (no
//! daylight-saving shifts); dates a month lacks (31 February) are skipped, as RFC 5545 says.
//! DTSTART is always the first occurrence and counts towards `COUNT`.

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc, Weekday};
use std::fmt;

/// Periods examined at most while expanding (daily for ~270 years); guards against runaway rules.
const MAX_PERIODS: i64 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: u32,
    /// Weekdays, with an ordinal within the month for MONTHLY (`Some(-1)` = last).
    pub by_day: Vec<(Option<i8>, Weekday)>,
    pub by_month_day: Vec<i8>,
    pub count: Option<u32>,
    /// Inclusive bound on occurrence starts.
    pub until: Option<DateTime<Utc>>,
    pub wkst: Weekday,
}

/// An occurrence to skip: an exact start, or every occurrence starting on that (UTC) day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exception {
    At(DateTime<Utc>),
    Day(NaiveDate),
}

/// What expansion needs to know about an event.
#[derive(Debug, Clone)]
pub struct Series {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub rule: Option<Rule>,
    pub exceptions: Vec<Exception>,
}

const DAYS: [(&str, Weekday); 7] =
    [("MO", Weekday::Mon), ("TU", Weekday::Tue), ("WE", Weekday::Wed), ("TH", Weekday::Thu), ("FR", Weekday::Fri), ("SA", Weekday::Sat), ("SU", Weekday::Sun)];

fn weekday(s: &str) -> Result<Weekday, String> {
    let up = s.trim().to_ascii_uppercase();
    DAYS.iter().find(|(n, _)| *n == up).map(|(_, d)| *d).ok_or_else(|| format!("'{s}' is not a weekday (MO, TU, WE, TH, FR, SA, SU)"))
}

fn day_name(d: Weekday) -> &'static str {
    DAYS.iter().find(|(_, x)| *x == d).map(|(n, _)| *n).unwrap_or("MO")
}

fn parse_by_day(s: &str) -> Result<(Option<i8>, Weekday), String> {
    let s = s.trim();
    if s.len() < 2 {
        return Err(format!("'{s}' is not a BYDAY value"));
    }
    let (ord, day) = s.split_at(s.len() - 2);
    let ord = match ord {
        "" => None,
        o => {
            let n: i8 = o.trim_start_matches('+').parse().map_err(|_| format!("'{s}' is not a BYDAY value"))?;
            if n == 0 || !(-5..=5).contains(&n) {
                return Err(format!("'{s}': the ordinal must be 1 to 5 or -1 to -5"));
            }
            Some(n)
        }
    };
    Ok((ord, weekday(day)?))
}

/// `UNTIL`: a UTC date-time (`Z`), a floating date-time (read as UTC) or a date (through its end).
fn parse_until(s: &str) -> Result<DateTime<Utc>, String> {
    let t = s.trim().trim_end_matches(['Z', 'z']);
    if let Ok(dt) = NaiveDateTime::parse_from_str(t, "%Y%m%dT%H%M%S") {
        return Ok(dt.and_utc());
    }
    if let Ok(d) = NaiveDate::parse_from_str(t, "%Y%m%d") {
        return Ok(d.and_time(NaiveTime::from_hms_opt(23, 59, 59).unwrap_or_default()).and_utc());
    }
    Err(format!("UNTIL '{s}' is not a date (YYYYMMDD) or UTC date-time (YYYYMMDDTHHMMSSZ)"))
}

/// Parses a rule; the optional `RRULE:` prefix is accepted.
pub fn parse(src: &str) -> Result<Rule, String> {
    let s = src.trim();
    let s = if s.len() >= 6 && s[..6].eq_ignore_ascii_case("RRULE:") { &s[6..] } else { s };
    let (mut freq, mut interval, mut count, mut until, mut wkst) = (None, 1u32, None, None, Weekday::Mon);
    let (mut by_day, mut by_month_day) = (Vec::new(), Vec::new());
    for part in s.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=').ok_or_else(|| format!("'{part}' is not KEY=VALUE"))?;
        let v = v.trim();
        match k.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    other => return Err(format!("FREQ={other} is not supported (use DAILY, WEEKLY, MONTHLY or YEARLY)")),
                })
            }
            "INTERVAL" => interval = v.parse::<u32>().ok().filter(|n| (1..=1000).contains(n)).ok_or("INTERVAL must be a number from 1 to 1000")?,
            "COUNT" => count = Some(v.parse::<u32>().ok().filter(|n| (1..=5000).contains(n)).ok_or("COUNT must be a number from 1 to 5000")?),
            "UNTIL" => until = Some(parse_until(v)?),
            "WKST" => wkst = weekday(v)?,
            "BYDAY" => {
                for d in v.split(',') {
                    by_day.push(parse_by_day(d)?);
                }
            }
            "BYMONTHDAY" => {
                for d in v.split(',') {
                    let n: i8 = d.trim().parse().map_err(|_| format!("BYMONTHDAY '{d}' is not a day number"))?;
                    if n == 0 || !(-31..=31).contains(&n) {
                        return Err(format!("BYMONTHDAY {n} must be 1 to 31 or -1 to -31"));
                    }
                    by_month_day.push(n);
                }
            }
            other => return Err(format!("{other} is not supported in recurrence rules")),
        }
    }
    let freq = freq.ok_or("the rule needs FREQ (DAILY, WEEKLY, MONTHLY or YEARLY)")?;
    if count.is_some() && until.is_some() {
        return Err("use COUNT or UNTIL, not both".into());
    }
    match freq {
        Freq::Daily | Freq::Weekly => {
            if by_day.iter().any(|(o, _)| o.is_some()) {
                return Err("ordinal BYDAY values (like 1MO) need FREQ=MONTHLY".into());
            }
            if !by_month_day.is_empty() {
                return Err("BYMONTHDAY needs FREQ=MONTHLY".into());
            }
        }
        Freq::Yearly if !by_day.is_empty() || !by_month_day.is_empty() => {
            return Err("FREQ=YEARLY repeats on the start date; BYDAY and BYMONTHDAY are not supported with it".into());
        }
        _ => {}
    }
    by_day.dedup();
    by_month_day.dedup();
    Ok(Rule { freq, interval, by_day, by_month_day, count, until, wkst })
}

impl fmt::Display for Rule {
    /// Canonical RRULE text (what is stored and exported).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let freq = match self.freq {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        };
        write!(f, "FREQ={freq}")?;
        if self.interval != 1 {
            write!(f, ";INTERVAL={}", self.interval)?;
        }
        if !self.by_day.is_empty() {
            let days: Vec<String> = self.by_day.iter().map(|(o, d)| format!("{}{}", o.map(|n| n.to_string()).unwrap_or_default(), day_name(*d))).collect();
            write!(f, ";BYDAY={}", days.join(","))?;
        }
        if !self.by_month_day.is_empty() {
            let days: Vec<String> = self.by_month_day.iter().map(|d| d.to_string()).collect();
            write!(f, ";BYMONTHDAY={}", days.join(","))?;
        }
        if let Some(c) = self.count {
            write!(f, ";COUNT={c}")?;
        }
        if let Some(u) = self.until {
            write!(f, ";UNTIL={}", u.format("%Y%m%dT%H%M%SZ"))?;
        }
        if self.wkst != Weekday::Mon {
            write!(f, ";WKST={}", day_name(self.wkst))?;
        }
        Ok(())
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1).and_then(|d| d.pred_opt()).map(|d| d.day()).unwrap_or(28)
}

impl Rule {
    /// Candidate days of the `k`-th period after the one containing `d0`: (period start, sorted days).
    fn period(&self, d0: NaiveDate, k: i64) -> Option<(NaiveDate, Vec<NaiveDate>)> {
        let step = k * self.interval as i64;
        let wanted = |d: NaiveDate| self.by_day.is_empty() || self.by_day.iter().any(|(_, w)| *w == d.weekday());
        let mut days = match self.freq {
            Freq::Daily => {
                let d = d0.checked_add_signed(Duration::days(step))?;
                return Some((d, if wanted(d) { vec![d] } else { vec![] }));
            }
            Freq::Weekly => {
                let back = d0.weekday().days_since(self.wkst) as i64;
                let start = d0.checked_add_signed(Duration::days(7 * step - back))?;
                let mut set: Vec<Weekday> = self.by_day.iter().map(|(_, d)| *d).collect();
                if set.is_empty() {
                    set.push(d0.weekday());
                }
                let days = set.iter().filter_map(|w| start.checked_add_signed(Duration::days(w.days_since(self.wkst) as i64))).collect();
                return Some((start, sorted(days)));
            }
            Freq::Monthly => {
                let index = d0.year() as i64 * 12 + d0.month0() as i64 + step;
                let (year, month) = (i32::try_from(index.div_euclid(12)).ok()?, index.rem_euclid(12) as u32 + 1);
                let first = NaiveDate::from_ymd_opt(year, month, 1)?;
                let dim = days_in_month(year, month);
                let day = |n: u32| NaiveDate::from_ymd_opt(year, month, n);
                let mut out = Vec::new();
                if !self.by_month_day.is_empty() {
                    for n in &self.by_month_day {
                        let d = if *n > 0 { *n as i64 } else { dim as i64 + 1 + *n as i64 };
                        if (1..=dim as i64).contains(&d)
                            && let Some(x) = day(d as u32)
                            && wanted(x)
                        {
                            out.push(x);
                        }
                    }
                } else if !self.by_day.is_empty() {
                    for (ord, w) in &self.by_day {
                        let all: Vec<NaiveDate> = (1..=dim).filter_map(day).filter(|d| d.weekday() == *w).collect();
                        match ord {
                            None => out.extend(all),
                            Some(n) if *n > 0 => out.extend(all.get(*n as usize - 1).copied()),
                            Some(n) => out.extend(all.len().checked_sub(n.unsigned_abs() as usize).and_then(|i| all.get(i).copied())),
                        }
                    }
                } else if d0.day() <= dim {
                    out.extend(day(d0.day()));
                }
                return Some((first, sorted(out)));
            }
            Freq::Yearly => {
                let year = i32::try_from(d0.year() as i64 + step).ok()?;
                let first = NaiveDate::from_ymd_opt(year, 1, 1)?;
                (first, NaiveDate::from_ymd_opt(year, d0.month(), d0.day()).into_iter().collect::<Vec<_>>())
            }
        };
        days.1.sort();
        Some(days)
    }

    /// Whole periods between `d0` and a later day, less one (a safe place to start looking).
    fn periods_before(&self, d0: NaiveDate, day: NaiveDate) -> i64 {
        let interval = self.interval as i64;
        let elapsed = match self.freq {
            Freq::Daily => (day - d0).num_days(),
            Freq::Weekly => (day - d0).num_days() / 7,
            Freq::Monthly => (day.year() as i64 * 12 + day.month0() as i64) - (d0.year() as i64 * 12 + d0.month0() as i64),
            Freq::Yearly => (day.year() - d0.year()) as i64,
        };
        (elapsed / interval - 1).max(0)
    }

    /// Occurrence starts up to `horizon` (inclusive), honouring COUNT and UNTIL: DTSTART first,
    /// then those from `after` on (all of them when the rule has a COUNT, which counts from DTSTART).
    pub fn starts(&self, dtstart: DateTime<Utc>, after: DateTime<Utc>, horizon: DateTime<Utc>) -> Vec<DateTime<Utc>> {
        let (d0, time) = (dtstart.date_naive(), dtstart.time());
        let first = if self.count.is_none() && after > dtstart { self.periods_before(d0, after.date_naive()) } else { 0 };
        let mut out = vec![dtstart];
        'periods: for k in first..first + MAX_PERIODS {
            let Some((period_start, days)) = self.period(d0, k) else { break };
            if period_start > horizon.date_naive() {
                break;
            }
            for day in days {
                let s = day.and_time(time).and_utc();
                if s <= dtstart {
                    continue;
                }
                if s > horizon || self.until.is_some_and(|u| s > u) || self.count.is_some_and(|c| out.len() as u32 >= c) {
                    break 'periods;
                }
                out.push(s);
            }
        }
        out
    }
}

fn sorted(mut v: Vec<NaiveDate>) -> Vec<NaiveDate> {
    v.sort();
    v.dedup();
    v
}

impl Exception {
    /// `YYYY-MM-DD` (that day) or an RFC 3339 instant.
    pub fn parse(s: &str) -> Result<Exception, String> {
        let t = s.trim();
        if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
            return Ok(Exception::Day(d));
        }
        DateTime::parse_from_rfc3339(t)
            .map(|d| Exception::At(d.with_timezone(&Utc)))
            .map_err(|_| format!("'{s}' is not a date (YYYY-MM-DD) or date-time (RFC 3339)"))
    }

    fn skips(&self, start: DateTime<Utc>) -> bool {
        match self {
            Exception::At(t) => *t == start,
            Exception::Day(d) => start.date_naive() == *d,
        }
    }
}

/// Occurrences of `series` overlapping `[from, to)`, as `(start, end)` in order. Zero-length
/// occurrences count when they start inside the window.
pub fn occurrences(series: &Series, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    let duration = (series.end - series.start).max(Duration::zero());
    let starts = match &series.rule {
        None => vec![series.start],
        Some(rule) => rule.starts(series.start, from - duration, to),
    };
    starts
        .into_iter()
        .filter(|s| !series.exceptions.iter().any(|x| x.skips(*s)))
        .map(|s| (s, s + duration))
        .filter(|(s, e)| *s < to && (*e > from || (*s >= from && s == e)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn series(start: &str, minutes: i64, rule: &str) -> Series {
        let start = t(start);
        Series { start, end: start + Duration::minutes(minutes), rule: Some(parse(rule).unwrap()), exceptions: vec![] }
    }

    fn starts(s: &Series, from: &str, to: &str) -> Vec<String> {
        occurrences(s, t(from), t(to)).into_iter().map(|(a, _)| a.format("%Y-%m-%d %H:%M").to_string()).collect()
    }

    #[test]
    fn weekly_by_day_with_count() {
        let s = series("2026-11-02T09:00:00Z", 30, "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5");
        assert_eq!(
            starts(&s, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
            ["2026-11-02 09:00", "2026-11-04 09:00", "2026-11-09 09:00", "2026-11-11 09:00", "2026-11-16 09:00"]
        );
    }

    #[test]
    fn weekly_interval_respects_week_start() {
        // RFC 5545 §3.8.5.3: the same rule yields different days when WKST changes.
        let mo = series("1997-08-05T09:00:00Z", 60, "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO");
        assert_eq!(
            starts(&mo, "1997-01-01T00:00:00Z", "1998-01-01T00:00:00Z"),
            ["1997-08-05 09:00", "1997-08-10 09:00", "1997-08-19 09:00", "1997-08-24 09:00"]
        );
        let su = series("1997-08-05T09:00:00Z", 60, "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU");
        assert_eq!(
            starts(&su, "1997-01-01T00:00:00Z", "1998-01-01T00:00:00Z"),
            ["1997-08-05 09:00", "1997-08-17 09:00", "1997-08-19 09:00", "1997-08-31 09:00"]
        );
    }

    #[test]
    fn monthly_on_the_31st_skips_short_months() {
        let by_start = series("2026-01-31T10:00:00Z", 60, "FREQ=MONTHLY;COUNT=5");
        let explicit = series("2026-01-31T10:00:00Z", 60, "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=5");
        let want = ["2026-01-31 10:00", "2026-03-31 10:00", "2026-05-31 10:00", "2026-07-31 10:00", "2026-08-31 10:00"];
        assert_eq!(starts(&by_start, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), want);
        assert_eq!(starts(&explicit, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), want);
    }

    #[test]
    fn monthly_last_day_and_last_friday() {
        let last = series("2027-01-31T08:00:00Z", 15, "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4");
        assert_eq!(
            starts(&last, "2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z"),
            ["2027-01-31 08:00", "2027-02-28 08:00", "2027-03-31 08:00", "2027-04-30 08:00"]
        );
        let leap = series("2028-01-31T08:00:00Z", 15, "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2");
        assert_eq!(starts(&leap, "2028-01-01T00:00:00Z", "2029-01-01T00:00:00Z"), ["2028-01-31 08:00", "2028-02-29 08:00"]);
        let friday = series("2026-10-30T16:00:00Z", 60, "FREQ=MONTHLY;BYDAY=-1FR;COUNT=3");
        assert_eq!(starts(&friday, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"), ["2026-10-30 16:00", "2026-11-27 16:00", "2026-12-25 16:00"]);
        // A date-only UNTIL includes that day: 1 Feb 2027 is the month's first Monday.
        let first_monday = series("2026-11-02T09:00:00Z", 60, "FREQ=MONTHLY;BYDAY=1MO;UNTIL=20270201");
        assert_eq!(
            starts(&first_monday, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"),
            ["2026-11-02 09:00", "2026-12-07 09:00", "2027-01-04 09:00", "2027-02-01 09:00"]
        );
    }

    #[test]
    fn yearly_leap_day_and_daily_until() {
        let leap = series("2024-02-29T12:00:00Z", 60, "FREQ=YEARLY;COUNT=3");
        assert_eq!(starts(&leap, "2024-01-01T00:00:00Z", "2040-01-01T00:00:00Z"), ["2024-02-29 12:00", "2028-02-29 12:00", "2032-02-29 12:00"]);
        // UNTIL is inclusive; a date-only UNTIL runs through the end of that day.
        let daily = series("2026-12-28T23:30:00Z", 30, "FREQ=DAILY;INTERVAL=2;UNTIL=20270103T233000Z");
        assert_eq!(
            starts(&daily, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"),
            ["2026-12-28 23:30", "2026-12-30 23:30", "2027-01-01 23:30", "2027-01-03 23:30"]
        );
        let by_date = series("2026-12-28T23:30:00Z", 30, "FREQ=DAILY;UNTIL=20261230");
        assert_eq!(starts(&by_date, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z").len(), 3);
        let weekdays = series("2026-11-06T09:00:00Z", 30, "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=3");
        assert_eq!(starts(&weekdays, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"), ["2026-11-06 09:00", "2026-11-09 09:00", "2026-11-10 09:00"]);
    }

    #[test]
    fn utc_times_ignore_daylight_saving() {
        // Europe leaves summer time on 25 Oct 2026; the occurrences stay at 09:00 UTC.
        let s = series("2026-10-19T09:00:00Z", 60, "FREQ=WEEKLY;COUNT=3");
        assert_eq!(starts(&s, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"), ["2026-10-19 09:00", "2026-10-26 09:00", "2026-11-02 09:00"]);
    }

    #[test]
    fn exceptions_windows_and_unbounded_rules() {
        let mut s = series("2026-11-02T09:00:00Z", 60, "FREQ=DAILY");
        s.exceptions = vec![Exception::parse("2026-11-03").unwrap(), Exception::parse("2026-11-05T09:00:00Z").unwrap()];
        // The 09:00 occurrence of the 4th overlaps a window opening at 09:30.
        assert_eq!(starts(&s, "2026-11-04T09:30:00Z", "2026-11-07T00:00:00Z"), ["2026-11-04 09:00", "2026-11-06 09:00"]);
        // COUNT counts excluded occurrences too (they are generated, then removed).
        let mut c = series("2026-11-02T09:00:00Z", 60, "FREQ=DAILY;COUNT=3");
        c.exceptions = vec![Exception::Day(NaiveDate::from_ymd_opt(2026, 11, 3).unwrap())];
        assert_eq!(starts(&c, "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z"), ["2026-11-02 09:00", "2026-11-04 09:00"]);
        // A single event and a zero-length one.
        let single = Series { start: t("2026-11-02T09:00:00Z"), end: t("2026-11-02T09:00:00Z"), rule: None, exceptions: vec![] };
        assert_eq!(occurrences(&single, t("2026-11-02T09:00:00Z"), t("2026-11-02T10:00:00Z")).len(), 1);
        assert!(occurrences(&single, t("2026-11-02T09:00:01Z"), t("2026-11-02T10:00:00Z")).is_empty());
        // Far-away windows of an endless rule skip ahead instead of walking every day since 1900.
        let far = starts(&s, "2100-01-01T00:00:00Z", "2100-01-03T00:00:00Z");
        assert_eq!(far, ["2100-01-01 09:00", "2100-01-02 09:00"]);
        let d0 = NaiveDate::from_ymd_opt(1900, 1, 5).unwrap();
        let checks: [(&str, fn(NaiveDate, NaiveDate) -> bool); 4] = [
            ("FREQ=DAILY;INTERVAL=3", |d, d0| (d - d0).num_days() % 3 == 0),
            ("FREQ=WEEKLY;BYDAY=WE", |d, _| d.weekday() == Weekday::Wed),
            ("FREQ=MONTHLY;BYMONTHDAY=-1", |d, _| d.succ_opt().is_some_and(|n| n.day() == 1)),
            ("FREQ=YEARLY", |d, _| (d.month(), d.day()) == (1, 5)),
        ];
        for (rule, matches) in checks {
            let old = series("1900-01-05T09:00:00Z", 60, rule);
            // Same answer as walking every period from the start (possible up to ~2170)...
            let (from, to) = (t("2150-03-01T00:00:00Z"), t("2151-03-01T00:00:00Z"));
            let walked: Vec<_> =
                old.rule.as_ref().unwrap().starts(old.start, old.start, to).into_iter().filter(|s| *s + Duration::minutes(60) > from).collect();
            assert!(!walked.is_empty(), "{rule}");
            assert_eq!(occurrences(&old, from, to).into_iter().map(|o| o.0).collect::<Vec<_>>(), walked, "{rule}");
            // ...and far beyond what walking could reach.
            let far = occurrences(&old, t("2400-03-01T00:00:00Z"), t("2401-03-01T00:00:00Z"));
            assert!(!far.is_empty() && far.iter().all(|o| matches(o.0.date_naive(), d0) && o.0.time() == old.start.time()), "{rule}: {far:?}");
        }
    }

    #[test]
    fn parsing_and_canonical_text() {
        let r = parse("RRULE:freq=weekly;interval=2;byday=mo,we;count=10;wkst=su").unwrap();
        assert_eq!(r.to_string(), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10;WKST=SU");
        assert_eq!(parse(&r.to_string()).unwrap(), r);
        assert_eq!(parse("FREQ=MONTHLY;BYDAY=-1FR,+2TU").unwrap().to_string(), "FREQ=MONTHLY;BYDAY=-1FR,2TU");
        assert_eq!(parse("FREQ=DAILY;UNTIL=20270103T233000Z").unwrap().to_string(), "FREQ=DAILY;UNTIL=20270103T233000Z");
        for bad in [
            "",
            "FREQ=HOURLY",
            "FREQ=DAILY;COUNT=2;UNTIL=20270101",
            "FREQ=MONTHLY;BYSETPOS=1",
            "FREQ=WEEKLY;BYDAY=1MO",
            "FREQ=YEARLY;BYDAY=MO",
            "FREQ=MONTHLY;BYMONTHDAY=0",
            "FREQ=MONTHLY;BYDAY=6MO",
            "FREQ=DAILY;INTERVAL=0",
            "FREQ=DAILY;COUNT=abc",
            "FREQ=DAILY;UNTIL=tomorrow",
            "COUNT=3",
        ] {
            assert!(parse(bad).is_err(), "{bad} should be refused");
        }
    }
}
