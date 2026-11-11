//! Calendar mail that changes the calendar (iMIP, RFC 6047 / iTIP, RFC 5546), one implementation for
//! both ways it is met: when it arrives (`arrivals.rs`, no tab open) and when someone opens it
//! (`POST /mail/itip`). Only the UID is taken from the message to find the event, and only what the
//! sender may say is applied:
//! * a REPLY to an event the mailbox's owner organises sets the answer of the guest who sent it,
//!   when that guest is on the event's list (an answer the REPLY gives for anyone else is ignored);
//! * a CANCEL from the organiser of an event the owner keeps in their calendar (one they took from
//!   an invitation) cancels it, or the one occurrence it names.
//!
//! The sender is taken from the From header only when the mail server vouches for it ([`origin`]):
//! mail that came in from outside must have passed DMARC, or carry a DKIM signature that passed for
//! the From domain; mail submitted on this server by a signed-in account is its own proof. A CANCEL
//! must also come from the organiser recorded when the event was taken from the invitation.
//!
//! COUNTER (a guest proposing another time) is not applied: the calendar has no proposals; the
//! message stays in the Inbox for the organiser to read. A REQUEST is answered from the message.

use crate::arrivals::Mail;
use crate::calendar;
use crate::ics;
use crate::util::{self, s};
use ferrum_kernel::{Ctx, Doc, Kernel, Result};
use serde_json::{Value, json};
use uuid::Uuid;

/// The keyword a message carries once its calendar part was applied (the reader's card reads it).
pub(crate) const APPLIED: &str = "ferrum-rsvp-applied";
/// Largest calendar part read.
const MAX_ICS: usize = 1 << 20;

/// What a calendar message says, from its first event.
#[derive(Debug, PartialEq)]
pub(crate) struct Itip {
    pub method: String,
    pub uid: String,
    pub organizer: Option<String>,
    /// (address, PARTSTAT) as written.
    pub attendees: Vec<(String, String)>,
    pub occurrence: bool,
}

/// The method, UID, organiser and guests of the first event (lines unfolded; no times needed, as a
/// REPLY need not carry them).
pub(crate) fn read(text: &str) -> Option<Itip> {
    let mut out = Itip { method: String::new(), uid: String::new(), organizer: None, attendees: vec![], occurrence: false };
    let mut depth = Vec::<String>::new();
    for l in ics::unfold(text) {
        let Some((name, params, value)) = ics::content_line(&l) else { continue };
        match name.as_str() {
            "BEGIN" => depth.push(value.trim().to_ascii_uppercase()),
            "END" => {
                let ended = depth.pop();
                if ended.as_deref() == Some("VEVENT") && !out.uid.is_empty() {
                    break;
                }
            }
            "METHOD" if depth.last().map(String::as_str) == Some("VCALENDAR") => out.method = value.trim().to_ascii_uppercase(),
            _ if depth.last().map(String::as_str) != Some("VEVENT") => {}
            "UID" => out.uid = value.trim().to_string(),
            "ORGANIZER" => out.organizer = ics::mailto(&value),
            "RECURRENCE-ID" => out.occurrence = true,
            "ATTENDEE" => {
                if let Some(email) = ics::mailto(&value) {
                    out.attendees.push((email, ics::get(&params, "PARTSTAT").unwrap_or("NEEDS-ACTION").to_ascii_uppercase()));
                }
            }
            _ => {}
        }
    }
    (!out.uid.is_empty() && !out.method.is_empty()).then_some(out)
}

/// What became of a calendar message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Applied {
    /// The calendar changed.
    Updated,
    /// It already said so.
    Same,
    /// No event of the owner's has this UID.
    NotInCalendar,
    /// The sender may not say this (not a guest of the event, not its organiser).
    Refused,
    /// Not something the calendar takes from mail (COUNTER, REQUEST, an answer it has no word for).
    Unsupported,
    /// From outside, and the mail server could not authenticate the From domain.
    Unverified,
    /// A CANCEL for an event taken from an invitation before Ferrum recorded its organiser.
    NoOrganizer,
}

impl Applied {
    pub(crate) fn word(self) -> &'static str {
        match self {
            Applied::Updated => "updated",
            Applied::Same => "same",
            Applied::NotInCalendar => "none",
            Applied::Refused => "refused",
            Applied::Unsupported => "unsupported",
            Applied::Unverified => "unverified",
            Applied::NoOrganizer => "no-organizer",
        }
    }
}

/// The answer a REPLY from `from` gives for the event with these guests (address, response): only
/// the sender's own, and only when they are invited.
pub(crate) fn reply_answer(it: &Itip, from: &str, guests: &[(String, Option<String>, String)]) -> std::result::Result<&'static str, Applied> {
    if !guests.iter().any(|g| g.0 == from) {
        return Err(Applied::Refused);
    }
    let said = it.attendees.iter().find(|(e, _)| e == from).ok_or(Applied::Refused)?;
    match said.1.as_str() {
        "ACCEPTED" => Ok("Accepted"),
        "DECLINED" => Ok("Declined"),
        "TENTATIVE" => Ok("Tentative"),
        _ => Err(Applied::Unsupported),
    }
}

/// The Ferrum event id in a UID Ferrum gave (`{id}@ferrum`).
fn ferrum_event(uid: &str) -> Option<Uuid> {
    uid.strip_suffix("@ferrum").and_then(|i| i.parse().ok())
}

/// Applies a calendar message `text` found in `me`'s mailbox, sent by `from` (both lower case).
pub(crate) async fn apply(k: &Kernel, tenant: Uuid, me: &str, from: &str, text: &str) -> Result<Applied> {
    let Some(it) = read(text) else { return Ok(Applied::Unsupported) };
    if from == me {
        return Ok(Applied::Refused);
    }
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await?);
    let mut tx = k.db.tenant_tx(tenant).await?;
    let event: Option<Uuid> = sqlx::query_scalar(
        "select id from e_calendar_event where tenant_id = $1 and lower(owner) = $2 \
         and (ical_uid = $3 or (ical_uid is null and id = $4)) order by created_at limit 1",
    )
    .bind(tenant)
    .bind(me)
    .bind(util::cut(&it.uid, 990))
    .bind(ferrum_event(&it.uid))
    .fetch_optional(&mut *tx)
    .await?;
    let Some(event) = event else { return Ok(Applied::NotInCalendar) };
    // Read for update, so two answers at once do not undo each other.
    let doc = k.get_tx(&sys, &mut tx, "CalendarEvent", event, true).await?;
    let outcome = match it.method.as_str() {
        "REPLY" => {
            if it.organizer.as_deref().is_some_and(|o| o != me) {
                return Ok(Applied::Refused);
            }
            let guests = calendar::attendees(&doc);
            match reply_answer(&it, from, &guests) {
                Err(e) => e,
                Ok(response) if guests.iter().any(|g| g.0 == from && g.2 == response) => Applied::Same,
                Ok(response) => {
                    let name = guests.iter().find(|g| g.0 == from).and_then(|g| g.1.clone()).unwrap_or_else(|| from.to_string());
                    calendar::record_answer(k, &mut tx, tenant, &sys, &doc, from, response, None, &name).await?;
                    Applied::Updated
                }
            }
        }
        "CANCEL" => {
            // Only an event taken from an invitation (owned here, with the organiser's UID), and only
            // the organiser recorded then cancels it.
            if ferrum_event(&it.uid).is_some() {
                return Ok(Applied::Refused);
            }
            let Some(organizer) = s(&doc, "organizer").map(str::to_lowercase) else { return Ok(Applied::NoOrganizer) };
            if organizer != from || it.organizer.as_deref() != Some(from) {
                return Ok(Applied::Refused);
            }
            match cancel_patch(&doc, &it, text) {
                Some(patch) if patch.is_empty() => Applied::Same,
                Some(patch) => {
                    k.update_tx(&sys, &mut tx, "CalendarEvent", event, patch, None).await?;
                    Applied::Updated
                }
                None => Applied::Unsupported,
            }
        }
        _ => Applied::Unsupported,
    };
    tx.commit().await?;
    Ok(outcome)
}

/// What a CANCEL changes on the event: the whole event cancelled, or one occurrence skipped (as the
/// calendar keeps changes to single occurrences); empty when it says so already, none when the
/// occurrence cannot be read.
fn cancel_patch(doc: &Doc, it: &Itip, text: &str) -> Option<Doc> {
    if !it.occurrence {
        return Some(if s(doc, "status") == Some("Cancelled") { Doc::new() } else { util::obj(json!({"status": "Cancelled"})) });
    }
    let (at, day) = ics::parse(text).ok()?.events.into_iter().find_map(|e| e.recurrence_id)?;
    let skip = if day { at.format("%Y-%m-%d").to_string() } else { util::ts(at) };
    let mut list: Vec<Value> = doc.get("recurrence_exceptions").and_then(Value::as_array).cloned().unwrap_or_default();
    if list.iter().any(|v| v.as_str() == Some(&skip)) {
        return Some(Doc::new());
    }
    list.push(json!(skip));
    Some(util::obj(json!({"recurrence_exceptions": list})))
}

/// The calendar part of message `email` in `account` (as `mail` reaches it), applied for `me` and
/// the message marked so it is not applied again. Returns what became of it; a message without a
/// calendar part, or marked already, is left alone.
pub(crate) async fn from_message(k: &Kernel, tenant: Uuid, mail: &dyn Mail, account: &str, email: &str, me: &str) -> Result<Applied> {
    let got = mail
        .call(json!([["Email/get", {"accountId": account, "ids": [email],
            "properties": ["from", "keywords", "attachments", "header:Authentication-Results:asRaw:all", "header:Received:asRaw:all"],
            "bodyProperties": ["type", "blobId", "size"]}, "0"]]))
        .await?;
    let m = &got[0][1]["list"][0];
    if m.is_null() {
        return Err(ferrum_kernel::Error::NotFound("message".into()));
    }
    if m["keywords"][APPLIED] == json!(true) {
        return Ok(Applied::Same);
    }
    let from = m["from"][0]["email"].as_str().unwrap_or_default().to_lowercase();
    let part = m["attachments"].as_array().into_iter().flatten().find(|p| is_calendar(p["type"].as_str().unwrap_or_default()));
    let Some(blob) = part.and_then(|p| p["blobId"].as_str()) else { return Ok(Applied::Unsupported) };
    let headers = |name: &str| m[name].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect::<Vec<_>>();
    if origin(&headers("header:Received:asRaw:all"), &headers("header:Authentication-Results:asRaw:all"), &from) == Origin::Unverified {
        return Ok(Applied::Unverified);
    }
    let raw = mail.download(account, blob, MAX_ICS).await?;
    let outcome = apply(k, tenant, me, &from, &String::from_utf8_lossy(&raw)).await?;
    // Marked only when applied: a refused one is judged again (the card then says why).
    if matches!(outcome, Applied::Updated | Applied::Same) {
        mail.call(json!([["Email/set", {"accountId": account, "update": {email: {format!("keywords/{APPLIED}"): true}}}, "0"]])).await?;
    }
    Ok(outcome)
}

/// Whether the mail server vouches for a message's From address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    /// Not received over SMTP from elsewhere: submitted on this server by a signed-in account (JMAP,
    /// or authenticated SMTP), or imported by the mailbox's owner.
    Local,
    /// From outside, with the From domain authenticated (DMARC pass, or an aligned DKIM pass).
    Verified,
    Unverified,
}

/// Where a message came from, by the headers the mail server wrote on top (`received` and `auth` as
/// in the message, topmost first). Mail that arrives by SMTP gets a `Received` line from this
/// server first: "with ESMTPA"/"ESMTPSA" when the sender signed in to it, otherwise it came from
/// another server and this server's own `Authentication-Results` (the topmost) decides. A message
/// without a `Received` line never crossed SMTP into this server.
// ponytail: relies on the mail server adding Received and Authentication-Results (Stalwart's default).
pub(crate) fn origin(received: &[String], auth: &[String], from: &str) -> Origin {
    let Some(top) = received.first() else { return Origin::Local };
    let top = top.to_ascii_lowercase();
    if [" with esmtpa", " with esmtpsa", " with lmtpa", " with lmtpsa"].iter().any(|w| top.contains(&format!("{w};")) || top.contains(&format!("{w} "))) {
        return Origin::Local;
    }
    let domain = from.rsplit_once('@').map(|(_, d)| d.trim().to_ascii_lowercase()).unwrap_or_default();
    match auth.first() {
        Some(a) if !domain.is_empty() && authenticated(a, &domain) => Origin::Verified,
        _ => Origin::Unverified,
    }
}

/// Whether an `Authentication-Results` header (RFC 8601) says `domain` was authenticated: DMARC
/// passed for it, or a DKIM signature of it (or of the organisational domain it is under) passed.
pub(crate) fn authenticated(header: &str, domain: &str) -> bool {
    // Comments in parentheses say nothing that counts.
    let mut plain = String::new();
    let mut depth = 0usize;
    for c in header.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => plain.push(c),
            _ => {}
        }
    }
    let aligned = |d: &str| {
        let d = d.trim().trim_end_matches('.').to_ascii_lowercase();
        !d.is_empty() && d.contains('.') && (d == domain || domain.ends_with(&format!(".{d}")) || d.ends_with(&format!(".{domain}")))
    };
    // The first part is the server's name; each result after it is `method=result prop=value ...`.
    plain.split(';').skip(1).any(|r| {
        let words: Vec<&str> = r.split_whitespace().collect();
        let Some((method, result)) = words.first().and_then(|w| w.split_once('=')) else { return false };
        let prop = |name: &str| words.iter().find_map(|w| w.split_once('=').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim_matches('"')));
        if !result.eq_ignore_ascii_case("pass") {
            return false;
        }
        match method.to_ascii_lowercase().as_str() {
            "dmarc" => prop("header.from").is_none_or(aligned),
            "dkim" => prop("header.d").or_else(|| prop("header.i").and_then(|i| i.rsplit_once('@').map(|(_, d)| d))).is_some_and(aligned),
            _ => false,
        }
    })
}

/// A part that is an iCalendar object.
pub(crate) fn is_calendar(ctype: &str) -> bool {
    let t = ctype.to_ascii_lowercase();
    t.starts_with("text/calendar") || t.starts_with("application/ics")
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str = "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:0192-abc@ferrum\r\nORGANIZER:mailto:Ann@Acme.test\r\n\
        ATTENDEE;PARTSTAT=ACCEPTED;CN=\"Bob\":mailto:bob@out.example\r\nATTENDEE;PARTSTAT=DECLINED:mailto:carol@out.exam\r\n ple\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    /// Headers as the live Stalwart 1.0 wrote them (JMAP `header:...:asRaw:all`) on a message injected by
    /// SMTP from another host claiming to be Omar, a colleague.
    const FORGED_RECEIVED: &str = " from mx.external.example (unknown [172.17.0.1])\r\n\tby mail.mail-host.test (Stalwart SMTP) with ESMTP id 4B82CA761A05000;\r\n\tWed, 11 Nov 2026 23:07:06 +0000";
    const FORGED_AUTH: &str = " mail.mail-host.test;\r\n\tspf=none (mail.mail-host.test: no SPF records found for postmaster@mx.external.example) smtp.helo=mx.external.example;\r\n\tspf=none (mail.mail-host.test: no SPF records found for omar.haddad@demo.test) smtp.mailfrom=omar.haddad@demo.test;\r\n\tiprev=permerror (dns record not found) policy.iprev=172.17.0.1;\r\n\tdmarc=none header.from=demo.test policy.dmarc=none";

    #[test]
    fn only_mail_the_server_vouches_for_changes_the_calendar() {
        let v = |s: &str| vec![s.to_string()];
        let omar = "omar.haddad@demo.test";
        assert_eq!(origin(&v(FORGED_RECEIVED), &v(FORGED_AUTH), omar), Origin::Unverified, "from outside, claiming a colleague, nothing passed");
        assert_eq!(origin(&[], &[], omar), Origin::Local, "never crossed SMTP: submitted here, or imported by the owner");
        // Authenticated SMTP to this server is local, whatever else the message carries.
        let submitted =
            " from [10.0.0.5] (unknown [10.0.0.5])\r\n\tby mail.mail-host.test (Stalwart SMTP) with ESMTPSA id 4B8;\r\n\tWed, 11 Nov 2026 23:10:00 +0000";
        assert_eq!(origin(&v(submitted), &[], omar), Origin::Local);
        // From outside with the From domain authenticated (Stalwart's own form of the header).
        let pass = " mail.mail-host.test;\r\n\tdkim=pass header.d=customer.example header.s=s1 header.b=AbC;\r\n\tspf=pass smtp.mailfrom=bounce@mailer.example;\r\n\tdmarc=pass header.from=customer.example policy.dmarc=reject";
        assert_eq!(origin(&v(FORGED_RECEIVED), &v(pass), "ann@customer.example"), Origin::Verified);
        assert_eq!(origin(&v(FORGED_RECEIVED), &v(pass), "ann@other.example"), Origin::Unverified, "passed, but for another domain");
        // A DKIM pass aligned with the From domain is enough; SPF alone, or a pass in a comment, is not.
        assert!(authenticated(" mx;\r\n\tdkim=pass header.d=mail.customer.example", "customer.example"));
        assert!(authenticated(" mx; dkim=pass header.i=@customer.example", "news.customer.example"));
        assert!(!authenticated(" mx; dkim=pass header.d=bulk-sender.example; dmarc=fail header.from=customer.example", "customer.example"));
        assert!(!authenticated(" mx; spf=pass smtp.mailfrom=ann@customer.example", "customer.example"));
        assert!(!authenticated(" mx; dmarc=none (dmarc=pass header.from=customer.example) header.from=customer.example", "customer.example"));
        assert!(!authenticated(" dmarc=pass header.from=customer.example", "customer.example"), "the first part is the server's name, not a result");
        // A forged Authentication-Results lower down does not count: only the server's own, on top.
        assert_eq!(origin(&v(FORGED_RECEIVED), &[FORGED_AUTH.to_string(), pass.to_string()], "ann@customer.example"), Origin::Unverified);
    }

    #[test]
    fn a_reply_says_who_answered_what_for_which_event() {
        let it = read(REPLY).expect("a reply");
        assert_eq!(it.method, "REPLY");
        assert_eq!(it.uid, "0192-abc@ferrum");
        assert_eq!(it.organizer.as_deref(), Some("ann@acme.test"));
        assert_eq!(it.attendees, [("bob@out.example".to_string(), "ACCEPTED".to_string()), ("carol@out.example".to_string(), "DECLINED".to_string())]);
        assert!(!it.occurrence);
        assert_eq!(read("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR"), None, "no method: not iTIP");
        assert_eq!(read("hello"), None);
    }

    #[test]
    fn only_an_invited_guest_answers_and_only_for_themself() {
        let it = read(REPLY).unwrap();
        let guests = |list: &[(&str, &str)]| list.iter().map(|(e, r)| (e.to_string(), None, r.to_string())).collect::<Vec<_>>();
        let invited = guests(&[("bob@out.example", "Needs Action"), ("carol@out.example", "Needs Action")]);
        assert_eq!(reply_answer(&it, "bob@out.example", &invited), Ok("Accepted"));
        // Bob's message also claims Carol declined: only Carol's own message says that.
        assert_eq!(reply_answer(&it, "carol@out.example", &invited), Ok("Declined"));
        assert_eq!(reply_answer(&it, "mallory@evil.example", &invited), Err(Applied::Refused), "not invited");
        assert_eq!(
            reply_answer(&it, "dan@out.example", &guests(&[("dan@out.example", "Needs Action")])),
            Err(Applied::Refused),
            "invited but says nothing of themself"
        );
        let odd = read(&REPLY.replace("PARTSTAT=ACCEPTED", "PARTSTAT=DELEGATED")).unwrap();
        assert_eq!(reply_answer(&odd, "bob@out.example", &invited), Err(Applied::Unsupported));
        assert_eq!(ferrum_event("01a1cbf3-d117-71d2-b08c-48cd9d8bacac@ferrum"), Some("01a1cbf3-d117-71d2-b08c-48cd9d8bacac".parse().unwrap()));
        assert_eq!(ferrum_event("abc@google.com"), None);
        assert!(is_calendar("text/calendar; method=REPLY") && is_calendar("application/ics") && !is_calendar("text/plain"));
    }

    #[test]
    fn a_cancel_cancels_the_event_or_skips_its_occurrence() {
        let cancel = "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:x@google.com\r\nORGANIZER:mailto:o@out.example\r\nDTSTART:20261120T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let it = read(cancel).unwrap();
        let confirmed = util::obj(json!({"status": "Confirmed"}));
        assert_eq!(cancel_patch(&confirmed, &it, cancel), Some(util::obj(json!({"status": "Cancelled"}))));
        assert_eq!(cancel_patch(&util::obj(json!({"status": "Cancelled"})), &it, cancel), Some(Doc::new()), "said already");
        let one = cancel.replace("DTSTART:20261120T090000Z", "RECURRENCE-ID:20261127T090000Z\r\nDTSTART:20261127T090000Z");
        let it = read(&one).unwrap();
        assert!(it.occurrence);
        assert_eq!(cancel_patch(&confirmed, &it, &one), Some(util::obj(json!({"recurrence_exceptions": ["2026-11-27T09:00:00.000Z"]}))));
        let skipped = util::obj(json!({"recurrence_exceptions": ["2026-11-27T09:00:00.000Z"]}));
        assert_eq!(cancel_patch(&skipped, &it, &one), Some(Doc::new()));
    }
}
