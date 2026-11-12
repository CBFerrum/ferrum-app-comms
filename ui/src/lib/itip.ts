// Answering invitations by mail (iTIP, RFC 5546): the REPLY a guest sends the organiser, and what an
// organiser reads out of a REPLY that came back. Lines are copied from the invitation as they were
// (its times and zones, its organiser), so the organiser's program matches the answer to its event.

export type PartStat = "ACCEPTED" | "TENTATIVE" | "DECLINED";

/** The invitation's own words for an answer, as Ferrum's calendar names them. */
export const RESPONSE: Record<PartStat, "Accepted" | "Tentative" | "Declined"> = { ACCEPTED: "Accepted", TENTATIVE: "Tentative", DECLINED: "Declined" };

const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((l) => l.length);

/** A content line folded at 75 octets (RFC 5545 §3.1), joined by CRLF. */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const name = (line: string) => line.slice(0, line.search(/[;:]/)).toUpperCase();
const mailto = (line: string) => line.slice(line.indexOf(":", line.search(/[;:]/))).replace(/^:(mailto:)?/i, "").trim().toLowerCase();

/** The parts of the invitation's first event an answer needs: its UID, the lines it is matched by,
 *  the time zones those use, and the guests. */
export function eventOf(ics: string): { uid: string; method: string; lines: string[]; zones: string[]; attendees: { email: string; name: string | null; partstat: string; line: string }[] } | null {
  const lines = unfold(ics);
  const method = (lines.find((l) => /^METHOD:/i.test(l)) ?? "").slice(7).trim().toUpperCase();
  const zones: string[] = [];
  let zone: string[] | null = null;
  let inEvent = false;
  const kept: string[] = [];
  const attendees: { email: string; name: string | null; partstat: string; line: string }[] = [];
  let uid = "";
  for (const l of lines) {
    if (/^BEGIN:VTIMEZONE/i.test(l)) zone = [];
    if (zone) {
      zone.push(l);
      if (/^END:VTIMEZONE/i.test(l)) {
        zones.push(...zone);
        zone = null;
      }
      continue;
    }
    if (/^BEGIN:VEVENT/i.test(l)) {
      if (inEvent || uid) break;
      inEvent = true;
      continue;
    }
    if (/^END:VEVENT/i.test(l)) {
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const n = name(l);
    if (n === "UID") uid = l.slice(4).trim();
    if (["UID", "SEQUENCE", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID", "SUMMARY", "ORGANIZER"].includes(n)) kept.push(l);
    if (n === "ATTENDEE") attendees.push({ email: mailto(l), name: /;CN="?([^";:]+)"?/i.exec(l)?.[1] ?? null, partstat: (/;PARTSTAT=([^;:]+)/i.exec(l)?.[1] ?? "NEEDS-ACTION").toUpperCase(), line: l });
  }
  return uid ? { uid, method, lines: kept, zones, attendees } : null;
}

/** The REPLY `me` sends the organiser of `ics`: the event's identifying lines and one ATTENDEE, theirs, with the answer. */
export function replyIcs(ics: string, me: { email: string; name?: string | null }, answer: PartStat, now = new Date()): string | null {
  const ev = eventOf(ics);
  if (!ev || !ev.lines.some((l) => name(l) === "ORGANIZER")) return null;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const cn = me.name ? `;CN="${me.name.replace(/"/g, "'")}"` : "";
  const out = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Ferrum//Mail//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    ...ev.zones,
    "BEGIN:VEVENT",
    ...ev.lines,
    `DTSTAMP:${stamp}`,
    `ATTENDEE;PARTSTAT=${answer}${cn}:mailto:${me.email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${out.map(fold).join("\r\n")}\r\n`;
}

/** iCalendar's form of an instant: `20270309T140000Z`. */
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const text = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** The COUNTER `me` sends the organiser of `ics` (RFC 5546 §3.2.7): the event's identifying lines with
 *  the time they propose instead (in UTC), their ATTENDEE line and their note as a COMMENT. */
export function counterIcs(ics: string, me: { email: string; name?: string | null }, start: Date, end: Date, note: string, now = new Date()): string | null {
  const ev = eventOf(ics);
  if (!ev || !ev.lines.some((l) => name(l) === "ORGANIZER")) return null;
  const cn = me.name ? `;CN="${me.name.replace(/"/g, "'")}"` : "";
  const kept = ev.lines.filter((l) => !["DTSTART", "DTEND", "DURATION"].includes(name(l)));
  const out = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Ferrum//Mail//EN",
    "VERSION:2.0",
    "METHOD:COUNTER",
    ...ev.zones,
    "BEGIN:VEVENT",
    ...kept,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(end)}`,
    `DTSTAMP:${utc(now)}`,
    `ATTENDEE;PARTSTAT=TENTATIVE${cn}:mailto:${me.email}`,
    ...(note.trim() ? [`COMMENT:${text(note.trim())}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${out.map(fold).join("\r\n")}\r\n`;
}

/** The plain words that go with a REPLY, for a program that does not read the calendar part. */
export function replyWords(answer: PartStat, who: string, title: string): string {
  const said = { ACCEPTED: "accepted", TENTATIVE: "might attend", DECLINED: "declined" }[answer];
  return `${who} ${said}: ${title}`;
}

/** What a REPLY says: the event and each answering guest's answer. Null when it is not a REPLY. */
export function answersIn(ics: string): { uid: string; answers: { email: string; name: string | null; response: "Accepted" | "Tentative" | "Declined" }[] } | null {
  const ev = eventOf(ics);
  if (!ev || ev.method !== "REPLY") return null;
  const answers = ev.attendees.filter((a): a is typeof a & { partstat: PartStat } => a.partstat in RESPONSE).map((a) => ({ email: a.email, name: a.name, response: RESPONSE[a.partstat as PartStat] }));
  return { uid: ev.uid, answers };
}

/** The Ferrum event id in a UID Ferrum gave it (`{id}@ferrum`), if it is one. */
export const ferrumEvent = (uid: string) => /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@ferrum$/i.exec(uid)?.[1] ?? null;
