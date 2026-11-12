import { t as tr } from "@ferrum/client";
// The calendar screen's pure parts, on the Mail app's `/api/app/comms/calendar`: the month grid
// and which occurrences (recurrences already expanded by the server) fall on which day.

export const CALENDAR = "/api/app/comms/calendar";

export interface Occurrence {
  id: string;
  event: string;
  start: string;
  end: string;
  all_day: boolean;
  subject: string;
  location?: string | null;
  meeting_link?: string | null;
  description?: string | null;
  status?: string | null;
  visibility?: string | null;
  category?: string | null;
  color?: string | null;
  timezone?: string | null;
  owner?: string | null;
  is_organizer?: boolean;
  my_response?: string | null;
  recurring?: boolean;
}

/** A person on the guest list of an event, and what they answered. */
export interface Guest {
  email: string;
  name?: string | null;
  response: string;
  /** A note that came with their answer (the organizer sees it). */
  comment?: string | null;
}

/** A local date as `YYYY-MM-DD`. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The 42 days (six weeks, Monday first) shown for the month containing `month`. */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const back = (first.getDay() + 6) % 7; // days since Monday
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - back + i));
}

/**
 * The local days an occurrence covers. All-day events are UTC midnights with an exclusive end, so
 * they keep their calendar dates in every time zone; timed ones cover each local day they touch
 * (an end at exactly midnight does not reach the next day).
 */
export function daysOf(o: Pick<Occurrence, "start" | "end" | "all_day">): string[] {
  const start = new Date(o.start);
  const end = new Date(o.end);
  const out: string[] = [];
  if (o.all_day) {
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d < end && out.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out.length ? out : [start.toISOString().slice(0, 10)];
  }
  const last = new Date(Math.max(start.getTime(), end.getTime() - 1));
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= last && out.length < 400; d.setDate(d.getDate() + 1)) out.push(isoDay(d));
  return out;
}

/** Occurrences by local day, all-day ones first, then by start. */
export function byDay(list: Occurrence[]): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  for (const o of list) for (const d of daysOf(o)) out.set(d, [...(out.get(d) ?? []), o]);
  for (const v of out.values()) v.sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start));
  return out;
}

/** The week (Monday first) holding `day`. */
export function weekOf(day: Date): Date[] {
  const back = (day.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - back + i));
}

/** A timed occurrence on one day of the week grid: minutes from midnight, and its lane among overlaps. */
export interface Placed {
  o: Occurrence;
  from: number;
  to: number;
  lane: number;
  lanes: number;
}

/** Lays out the timed occurrences touching a local day; overlapping ones share the width in lanes. */
export function placeDay(list: Occurrence[], day: Date): Placed[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const minutes = (t: number) => Math.round((Math.min(Math.max(t, start), end) - start) / 60_000);
  const items = list
    .filter((o) => !o.all_day && new Date(o.start).getTime() < end && new Date(o.end).getTime() > start)
    .map((o) => {
      const from = minutes(new Date(o.start).getTime());
      return { o, from, to: Math.min(1440, Math.max(minutes(new Date(o.end).getTime()), from + 15)) };
    })
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  for (const it of items) {
    if (it.from >= clusterEnd) {
      for (const p of cluster) p.lanes = laneEnds.length;
      cluster = [];
      laneEnds = [];
    }
    let lane = laneEnds.findIndex((e) => e <= it.from);
    if (lane < 0) lane = laneEnds.push(it.to) - 1;
    else laneEnds[lane] = it.to;
    const p = { ...it, lane, lanes: 1 };
    cluster.push(p);
    out.push(p);
    clusterEnd = Math.max(clusterEnd, it.to);
  }
  for (const p of cluster) p.lanes = laneEnds.length;
  return out;
}

/** Whether the user may move an occurrence by dragging it: their own event, not repeating, not cancelled. */
export const movable = (o: Occurrence) => !!o.is_organizer && !o.recurring && o.status !== "Cancelled";

/**
 * Where an occurrence goes when it now starts at `start`, its length kept. All-day events move by
 * whole days (to `start`'s local date, kept as UTC midnights).
 */
export function moved(o: Occurrence, start: Date): { starts_at: string; ends_at: string } {
  const length = new Date(o.end).getTime() - new Date(o.start).getTime();
  const at = o.all_day ? Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) : start.getTime();
  return { starts_at: new Date(at).toISOString(), ends_at: new Date(at + length).toISOString() };
}

/** `day` at the local time of day `o` starts at: a timed event dropped on another day keeps its hour. */
export function sameTimeOn(o: Occurrence, day: Date): Date {
  const s = new Date(o.start);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), s.getHours(), s.getMinutes());
}

/** Only colors that cannot smuggle anything into a style: `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export function safeColor(c: string | null | undefined): string | undefined {
  return c && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()) ? c.trim() : undefined;
}

/** `http(s)` meeting links only. */
export function safeLink(href: string | null | undefined): string | undefined {
  return href && /^https?:\/\/[^\s]+$/i.test(href.trim()) ? href.trim() : undefined;
}

// ───────────────────────────── guests and their answers ─────────────────────────────

/** An answer as people say it. */
export function answerWord(response: string | null | undefined): "Yes" | "Maybe" | "No" | "No reply yet" {
  return response === "Accepted" ? "Yes" : response === "Tentative" ? "Maybe" : response === "Declined" ? "No" : "No reply yet";
}

/** How many said what: "3 yes, 1 maybe, 2 waiting". */
export function tally(guests: Pick<Guest, "response">[]): string {
  const n = (r: string) => guests.filter((g) => g.response === r).length;
  const parts: [number, string][] = [[n("Accepted"), "yes"], [n("Tentative"), "maybe"], [n("Declined"), "no"], [guests.length - n("Accepted") - n("Tentative") - n("Declined"), "waiting"]];
  return parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(", ");
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Addresses typed or pasted (commas, semicolons, spaces or lines apart); what is not one is told apart. */
export function parseGuests(text: string): { emails: string[]; bad: string[] } {
  const emails: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const part = raw.trim().replace(/^<|>$/g, "");
    if (!part) continue;
    if (!ADDRESS.test(part)) bad.push(part);
    else if (!emails.includes(part.toLowerCase())) emails.push(part.toLowerCase());
  }
  return { emails, bad };
}

/** The guest list after the editor: those who stay keep their answers, new ones are waiting. */
export function mergeGuests(existing: Guest[], emails: string[], names: Record<string, string | undefined> = {}): { email: string; attendee_name?: string; response: string; comment?: string }[] {
  const kept = new Map(existing.map((g) => [g.email.toLowerCase(), g]));
  return emails.map((email) => {
    const g = kept.get(email.toLowerCase());
    const name = g?.name || names[email.toLowerCase()];
    return { email, ...(name ? { attendee_name: name } : {}), response: g?.response ?? "Needs Action", ...(g?.comment ? { comment: g.comment } : {}) };
  });
}

// ───────────────────────────── finding a time ─────────────────────────────

/** Someone's busy time, as `/calendar/freebusy` answers (no details of what it is). */
export interface Busy {
  start: string;
  end: string;
}

/** Busy time by person (lower-case address). */
export type BusyMap = Record<string, Busy[]>;

const ms = (d: Date | string) => (typeof d === "string" ? new Date(d).getTime() : d.getTime());

/** Who is busy at some point between `start` and `end`. */
export function clashes(busy: BusyMap, start: Date, end: Date): string[] {
  return Object.entries(busy)
    .filter(([, list]) => list.some((b) => ms(b.start) < ms(end) && ms(b.end) > ms(start)))
    .map(([who]) => who);
}

/** Times for a meeting of `minutes` that suit everyone in `busy`: on the marks of `step` minutes,
 *  within working hours (`start` to `end`, in hours of the viewer's day), from `from` on, over the
 *  next `days` days; weekends are skipped unless asked for. */
export function suggestSlots(
  busy: BusyMap,
  o: { from: Date; days: number; minutes: number; start?: number; end?: number; step?: number; limit?: number; weekends?: boolean },
): Date[] {
  const { start = 9, end = 18, step = 30, limit = 5 } = o;
  const out: Date[] = [];
  for (let d = 0; d < o.days && out.length < limit; d++) {
    const day = new Date(o.from.getFullYear(), o.from.getMonth(), o.from.getDate() + d);
    if (!o.weekends && (day.getDay() === 0 || day.getDay() === 6)) continue;
    for (let m = start * 60; m + o.minutes <= end * 60 && out.length < limit; m += step) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
      if (at.getTime() < o.from.getTime()) continue;
      if (!clashes(busy, at, new Date(at.getTime() + o.minutes * 60_000)).length) out.push(at);
    }
  }
  return out;
}

/** Busy time laid on a day's hours as shares of the width (percent), cut to the hours shown. */
export function bars(busy: Busy[], day: Date, fromHour: number, toHour: number): { left: number; width: number }[] {
  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), fromHour).getTime();
  const span = (toHour - fromHour) * 3_600_000;
  return busy
    .map((b) => ({ a: Math.max(ms(b.start), base), z: Math.min(ms(b.end), base + span) }))
    .filter((b) => b.z > b.a)
    .map((b) => ({ left: ((b.a - base) / span) * 100, width: ((b.z - b.a) / span) * 100 }));
}

/** "10:00–11:00" for a busy stretch, in the viewer's time. */
export const stretch = (b: Busy) => {
  const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${t(b.start)}–${t(b.end)}`;
};

// ───────────────────────────── the editor's fields ─────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");

/** A date and time for `<input type="datetime-local">`, in the viewer's time. */
export const toInput = (d: Date) => `${isoDay(d)}T${two(d.getHours())}:${two(d.getMinutes())}`;

/** The date of a `datetime-local` or `date` input in the viewer's time; none if it is not one. */
export function fromInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d;
}

/** The next whole hour from `now`. */
export function nextHour(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
  return d;
}

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "custom";

export const REPEATS: { value: Exclude<Repeat, "custom">; label: string }[] = [
  { value: "none", get label() { return tr("Does not repeat"); } },
  { value: "daily", get label() { return tr("Every day"); } },
  { value: "weekdays", get label() { return tr("Every weekday"); } },
  { value: "weekly", get label() { return tr("Every week"); } },
  { value: "monthly", get label() { return tr("Every month"); } },
  { value: "yearly", get label() { return tr("Every year"); } },
];

const RULES: Record<Exclude<Repeat, "none" | "custom">, string> = {
  daily: "FREQ=DAILY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

/** What a stored rule is, in the editor's terms (and until when); anything else is "custom", kept as it is. */
export function repeatOf(rule: string | null | undefined): { kind: Repeat; until: string } {
  const text = (rule ?? "").trim();
  if (!text) return { kind: "none", until: "" };
  const m = /^(.*?)(?:;UNTIL=(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?)?$/i.exec(text);
  const base = (m?.[1] ?? text).toUpperCase();
  const kind = (Object.entries(RULES).find(([, r]) => r === base)?.[0] as Repeat | undefined) ?? "custom";
  return { kind, until: kind !== "custom" && m?.[2] ? `${m[2]}-${m[3]}-${m[4]}` : "" };
}

/** The rule for the editor's choice; none for no repeat. UNTIL is a date: that whole day in the event's zone. */
export function ruleFor(kind: Exclude<Repeat, "custom">, until: string): string | null {
  if (kind === "none") return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
  return day ? `${RULES[kind]};UNTIL=${day[1]}${day[2]}${day[3]}` : RULES[kind];
}

/** Reminders the editor offers, minutes before. */
export const REMINDERS: { minutes: number; label: string }[] = [
  { minutes: 0, get label() { return tr("When it starts"); } },
  { minutes: 5, get label() { return tr("5 minutes before"); } },
  { minutes: 10, get label() { return tr("10 minutes before"); } },
  { minutes: 15, get label() { return tr("15 minutes before"); } },
  { minutes: 30, get label() { return tr("30 minutes before"); } },
  { minutes: 60, get label() { return tr("1 hour before"); } },
  { minutes: 1440, get label() { return tr("1 day before"); } },
];

/** The one reminder the editor shows for a list of them: none, one of the offered, or "custom" (kept). */
export function reminderOf(minutes: number[]): number | "none" | "custom" {
  if (!minutes.length) return "none";
  return minutes.length === 1 && REMINDERS.some((r) => r.minutes === minutes[0]) ? minutes[0]! : "custom";
}
