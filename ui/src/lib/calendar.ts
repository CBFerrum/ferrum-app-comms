import { currentLanguage, t as tr } from "@ferrum/client";
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
  /** The calendar it is in, and what I may do with it: owner, edit, details, free_busy. */
  calendar?: string | null;
  level?: string;
  /** Copied from a calendar subscribed to by its address: read-only. */
  fetched?: boolean;
  /** I organize it, and a guest proposed another time for it (or this occurrence). */
  proposed?: boolean;
  /** The notes with their formatting (made safe by the server), and files from Drive by reference. */
  description_html?: string | null;
  attachments?: Attachment[] | null;
  /** Its calendar's tone and name, filled in by the page from the calendars list. */
  tone?: string;
  calendarName?: string;
  /** "away": my time away, drawn as a bar (not an event). */
  kind?: string;
  /** Guests' addresses and names, for search (sent when asked with `q`). */
  guests?: string[];
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

/** The locale dates are written in: the browser's own (en-GB, hi-IN) when it is in the page's language, else the page's language. */
export function userLocale(): string {
  const lang = currentLanguage();
  const own = typeof navigator !== "undefined" ? navigator.language : "";
  return own && own.toLowerCase().split("-")[0] === lang.toLowerCase().split("-")[0] ? own : lang;
}

/** The first day of the week in a locale (0 Sunday … 6 Saturday), from `Intl.Locale`'s week information; Monday where it is not known. */
export function firstDayOf(lang: string | undefined): number {
  try {
    const loc = new Intl.Locale(lang || "en-GB") as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const day = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay;
    return day ? day % 7 : 1;
  } catch {
    return 1;
  }
}

/** The weekend days in a locale (0 Sunday … 6 Saturday); Saturday and Sunday where it is not known. */
export function weekendOf(lang: string | undefined): number[] {
  try {
    const loc = new Intl.Locale(lang || "en-GB") as Intl.Locale & { getWeekInfo?: () => { weekend: number[] }; weekInfo?: { weekend: number[] } };
    const days = (loc.getWeekInfo?.() ?? loc.weekInfo)?.weekend;
    return days?.length ? days.map((d) => d % 7) : [6, 0];
  } catch {
    return [6, 0];
  }
}

/** The 42 days (six weeks, starting on `first`, Monday by default) shown for the month containing `month`. */
export function monthGrid(month: Date, first = 1): Date[] {
  const one = new Date(month.getFullYear(), month.getMonth(), 1);
  const back = (one.getDay() - first + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(one.getFullYear(), one.getMonth(), 1 - back + i));
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

/** The week (starting on `first`, Monday by default) holding `day`. */
export function weekOf(day: Date, first = 1): Date[] {
  const back = (day.getDay() - first + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - back + i));
}

// ───────────────────────────── views ─────────────────────────────

export type View = "day" | "workweek" | "week" | "month" | "agenda" | "year";
export const VIEWS: View[] = ["day", "workweek", "week", "month", "agenda", "year"];
/** Days the agenda lists from its date. */
export const AGENDA_DAYS = 30;

/** A `YYYY-MM-DD` as a local date (noon-safe); none when it is not one. */
export function dayFrom(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * The days a view shows around `anchor`: one; the working days of its week (weekend left out);
 * its week (three days from the anchor on a phone); the month's six weeks; the agenda's next
 * days; the year's days.
 */
export function daysShown(view: View, anchor: Date, o: { first: number; weekend: number[]; narrow?: boolean }): Date[] {
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  switch (view) {
    case "day":
      return [a];
    case "workweek": {
      const days = weekOf(a, o.first).filter((d) => !o.weekend.includes(d.getDay()));
      return days.length ? days : weekOf(a, o.first);
    }
    case "week":
      return o.narrow ? [a, plusDays(a, 1), plusDays(a, 2)] : weekOf(a, o.first);
    case "month":
      return monthGrid(a, o.first);
    case "agenda":
      return Array.from({ length: AGENDA_DAYS }, (_, i) => plusDays(a, i));
    case "year":
      return Array.from({ length: 366 }, (_, i) => new Date(a.getFullYear(), 0, 1 + i)).filter((d) => d.getFullYear() === a.getFullYear());
  }
}

/** Where previous/next go: a day, a week (three days on a phone), a month, the agenda's span, a year. */
export function stepped(view: View, anchor: Date, n: number, narrow = false): Date {
  switch (view) {
    case "day":
      return plusDays(anchor, n);
    case "workweek":
      return plusDays(anchor, 7 * n);
    case "week":
      return plusDays(anchor, (narrow ? 3 : 7) * n);
    case "month":
      return new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
    case "agenda":
      return plusDays(anchor, AGENDA_DAYS * n);
    case "year":
      return new Date(anchor.getFullYear() + n, 0, 1);
  }
}

/** A bar of an all-day or multi-day occurrence across the columns of `days`: first column, how many, and its row. */
export interface Bar {
  o: Occurrence;
  col: number;
  span: number;
  row: number;
  /** It started before the first column / goes on after the last. */
  before: boolean;
  after: boolean;
}

/** Lays all-day and multi-day occurrences over consecutive `days` as bars, each in the first row free across its span (longest first). */
export function barsAcross(list: Occurrence[], days: Date[]): Bar[] {
  const keys = days.map(isoDay);
  const items = list
    .filter((o) => o.all_day || daysOf(o).length > 1)
    .map((o) => {
      const covered = daysOf(o);
      const cols = keys.map((k, i) => (covered.includes(k) ? i : -1)).filter((i) => i >= 0);
      return { o, covered, cols };
    })
    .filter((x) => x.cols.length)
    .sort((a, b) => a.cols[0]! - b.cols[0]! || b.cols.length - a.cols.length || a.o.start.localeCompare(b.o.start));
  const rows: number[][] = [];
  return items.map(({ o, covered, cols }) => {
    const col = cols[0]!;
    const span = cols[cols.length - 1]! - col + 1;
    let row = rows.findIndex((taken) => taken.every((c) => c < col || c >= col + span));
    if (row < 0) row = rows.push([]) - 1;
    for (let c = col; c < col + span; c++) rows[row]!.push(c);
    return { o, col, span, row, before: covered[0]! < keys[0]!, after: covered[covered.length - 1]! > keys[keys.length - 1]! };
  });
}

/** `minutes` to the nearest multiple of `step`, kept within one day. */
export const snap = (minutes: number, step: number) => Math.min(1440, Math.max(0, Math.round(minutes / step) * step));

/** A local day plus minutes from its midnight (a day that changes the clocks counts wall-clock minutes). */
export const atMinutes = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);

/** Minutes from local midnight. */
export const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Occurrences whose title, place, notes, organizer or zone match every word of `q` (case and accents ignored). */
export function matches(o: Occurrence, q: string): boolean {
  const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const hay = fold([o.subject, o.location, o.description, o.owner, ...(o.guests ?? [])].filter(Boolean).join(" "));
  return fold(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// ───────────────────────────── changing one occurrence of a series ─────────────────────────────

/** Which occurrences a change to a repeating event applies to. */
export type Scope = "this" | "following" | "all";

/** The day before `day` as an UNTIL date (`YYYYMMDD`): that whole day in the event's zone. */
const untilDay = (day: Date) => isoDay(plusDays(day, -1)).replaceAll("-", "");

/** The rule without its COUNT or UNTIL, so it can be bounded again. */
export const unbounded = (rule: string) => rule.split(";").filter((p) => !/^(COUNT|UNTIL)=/i.test(p.trim())).join(";");

/** The series' rule ended the day before `occurrence` (its local day): "this and following" leaves it there. */
export function endBefore(rule: string, occurrence: Date): string {
  return `${unbounded(rule)};UNTIL=${untilDay(occurrence)}`;
}

/**
 * The rule of the new series that "this and following" starts at an occurrence: the old rule, its
 * UNTIL kept; a COUNT becomes what was left of it (`before` occurrences came before this one).
 */
export function followingRule(rule: string, before: number): string {
  const count = /(?:^|;)COUNT=(\d+)/i.exec(rule);
  if (!count) return rule;
  return `${unbounded(rule)};COUNT=${Math.max(1, Number(count[1]) - before)}`;
}

/** An occurrence's start as the series' exception list keeps it (RFC 3339). */
export const exceptionOf = (start: string) => new Date(start).toISOString();

/** The exception list with `start` skipped (once). */
export function skipping(list: string[] | null | undefined, start: string): string[] {
  const at = exceptionOf(start);
  const now = list ?? [];
  return now.some((x) => x === at || (x.length > 10 && Date.parse(x) === Date.parse(at))) ? now : [...now, at];
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

/** Whether the user may move or resize an occurrence: their own event, not cancelled (a repeating one asks which occurrences). */
export const movable = (o: Occurrence) => changeable(o) && o.status !== "Cancelled";
/** Whether I may change or delete `o`: I organize it, or its calendar is shared with me to make changes. */
export const changeable = (o: Pick<Occurrence, "is_organizer" | "level" | "fetched">) => !o.fetched && (!!o.is_organizer || o.level === "edit");

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

/** A calendar: mine or shared with me (`GET /calendar/calendars`). */
export interface Cal {
  id: string;
  name: string;
  tone: string;
  hidden: boolean;
  is_default: boolean;
  owner: string;
  owner_name?: string | null;
  level: "owner" | "edit" | "details" | "free_busy";
  /** Subscribed to from outside by its address (its host only), with how its last fetch went. */
  subscription?: { label?: string | null; fetched_at?: string | null; result?: string | null; failures?: number; remind?: boolean } | null;
  /** Who it is shared with: a person by email, or a group (a role of the workspace). */
  shares: { person?: string; role?: string; level: "Free/busy" | "Details" | "Edit" }[];
}

export const TONES = ["blue", "green", "amber", "red", "purple", "neutral"] as const;
const TONE_VARS: Record<string, [string, string]> = {
  blue: ["--primary", "--primary-soft"],
  green: ["--success", "--success-soft"],
  amber: ["--warning", "--warning-soft"],
  red: ["--danger", "--danger-soft"],
  purple: ["--purple", "--purple-soft"],
  neutral: ["--faint", "--surface-2"],
};
/** A tone's strong and soft colours, as the kit's tokens. */
export const toneVar = (tone: string | undefined, soft = false) => `var(${(TONE_VARS[tone ?? "blue"] ?? TONE_VARS.blue!)[soft ? 1 : 0]})`;

/** An occurrence's colour: its own (a safe hex), else its calendar's tone. */
export const colorOf = (o: Pick<Occurrence, "color" | "tone">) => safeColor(o.color) ?? toneVar(o.tone);

/** Occurrences with their calendar's tone and name, and only those of calendars shown (an event without one is in the default). */
export function withCalendars(list: Occurrence[], cals: Cal[], hidden: Set<string>): Occurrence[] {
  const byId = new Map(cals.map((c) => [c.id, c]));
  const fallback = cals.find((c) => c.is_default);
  return list.flatMap((o) => {
    if (o.kind === "away") return [o];
    const c = (o.calendar && byId.get(o.calendar)) || (o.level === "owner" || o.is_organizer ? fallback : undefined);
    if (c && hidden.has(c.id)) return [];
    return [{ ...o, tone: c?.tone ?? o.tone, calendarName: c?.name, subject: o.level === "free_busy" ? tr("Busy") : o.subject }];
  });
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

/** Someone's working hours and time away, as `/calendar/hours` and `/calendar/freebusy` give them. */
export interface PersonHours {
  /** 0 Sunday … 6 Saturday. */
  days: number[];
  /** "09:00", "17:00" on the clock of `timezone`. */
  from: string;
  to: string;
  timezone?: string | null;
  away_from?: string | null;
  away_to?: string | null;
  away_decline?: boolean;
  away_message?: string | null;
}

export const DEFAULT_HOURS: PersonHours = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

/** Whether `start`–`end` is inside someone's working hours on one of their working days, not in their time away (on their clock). */
export function inHours(h: PersonHours, start: Date, end: Date): boolean {
  const a = toInputIn(start, h.timezone);
  const z = toInputIn(end, h.timezone);
  const day = a.slice(0, 10);
  if (h.away_from && h.away_to && day >= h.away_from && day <= h.away_to) return false;
  if (!h.days.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) return false;
  const endsSameDay = z.slice(0, 10) === day || (z.slice(0, 10) > day && z.slice(11) === "00:00" && h.to === "24:00");
  return endsSameDay && a.slice(11) >= h.from && z.slice(11) <= h.to;
}

/** Whether someone is away on a local day of the viewer's. */
export const awayOn = (h: PersonHours | undefined, day: Date) => !!h?.away_from && !!h.away_to && isoDay(day) >= h.away_from && isoDay(day) <= h.away_to;

/** Someone's working hours on a day of the viewer's, as a share of the hours shown (percent); none on a day off. */
export function workBar(h: PersonHours, day: Date, fromHour: number, toHour: number): { left: number; width: number } | null {
  const date = isoDay(day);
  const a = fromInputIn(`${date}T${h.from}`, h.timezone);
  const z = fromInputIn(`${date}T${h.to}`, h.timezone);
  if (!a || !z || !h.days.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) return null;
  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), fromHour).getTime();
  const span = (toHour - fromHour) * 3_600_000;
  const left = Math.max(0, (a.getTime() - base) / span) * 100;
  const right = Math.min(1, (z.getTime() - base) / span) * 100;
  return right > left ? { left, width: right - left } : null;
}

/** Times for a meeting of `minutes` that suit everyone in `busy`: on the marks of `step` minutes,
 *  within working hours (`start` to `end`, in hours of the viewer's day), from `from` on, over the
 *  next `days` days; weekends are skipped unless asked for. */
export function suggestSlots(
  busy: BusyMap,
  o: { from: Date; days: number; minutes: number; start?: number; end?: number; step?: number; limit?: number; weekends?: boolean; hours?: Record<string, PersonHours> },
): Date[] {
  const { start = 9, end = 18, step = 30, limit = 5 } = o;
  const out: Date[] = [];
  for (let d = 0; d < o.days && out.length < limit; d++) {
    const day = new Date(o.from.getFullYear(), o.from.getMonth(), o.from.getDate() + d);
    if (!o.weekends && (day.getDay() === 0 || day.getDay() === 6)) continue;
    for (let m = start * 60; m + o.minutes <= end * 60 && out.length < limit; m += step) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
      if (at.getTime() < o.from.getTime()) continue;
      const until = new Date(at.getTime() + o.minutes * 60_000);
      // Inside every guest's own working hours, on their clock, where they set them.
      if (o.hours && Object.values(o.hours).some((h) => !inHours(h, at, until))) continue;
      if (!clashes(busy, at, until).length) out.push(at);
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

/** Old names some browsers still list, as the IANA database names them now. */
const RENAMED: Record<string, string> = { "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Rangoon": "Asia/Yangon", "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires", "Atlantic/Faeroe": "Atlantic/Faroe" };

/** Every IANA zone this browser knows, by its current name, sorted. */
export function zoneList(): string[] {
  const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(all.map((z) => RENAMED[z] ?? z))].sort();
}

/** The wall clock at `d` in `zone`. */
function wallIn(d: Date, zone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  return ["year", "month", "day", "hour", "minute"].map((type) => Number(parts.find((p) => p.type === type)?.value));
}

/** A `datetime-local` value for `d` on the clock of `zone` (the viewer's own without one). */
export function toInputIn(d: Date, zone?: string | null): string {
  if (!zone) return toInput(d);
  const [y, mo, day, h, mi] = wallIn(d, zone);
  return `${y}-${two(mo!)}-${two(day!)}T${two(h!)}:${two(mi!)}`;
}

/** A `datetime-local` value read on the clock of `zone` as an instant (the first of a repeated hour). */
export function fromInputIn(v: string, zone?: string | null): Date | null {
  if (!zone) return fromInput(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const offset = (t: number) => {
    const [y, mo, d, h, mi] = wallIn(new Date(t), zone);
    return Date.UTC(y!, mo! - 1, d!, h!, mi!) - Math.floor(t / 60_000) * 60_000;
  };
  // The offset at that wall time: guessed from the wall time itself, then taken where the guess
  // lands. A time the clocks skip takes the offset from before the jump (as the server does), so
  // 02:30 on a one-hour jump is 03:30 after it.
  const guess = wall - offset(wall);
  const t = wall - offset(guess);
  return new Date(toInputIn(new Date(t), zone) === v.trim() ? t : wall - offset(guess - 86_400_000));
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

/** A subscription's state in words: when it last worked, or why its last fetch failed (the server's own words after "failed: "). */
export function subscriptionState(sub: NonNullable<Cal["subscription"]>, ago: (iso: string) => string): { failed: boolean; text: string } {
  const failed = (sub.failures ?? 0) > 0;
  if (failed) return { failed, text: (sub.result ?? "").replace(/^failed: /, "") };
  return { failed, text: sub.fetched_at ? ago(sub.fetched_at) : "" };
}

/** A file from Drive an event links to. */
export interface Attachment {
  id: string;
  name: string;
  size?: number;
}

/** A file's kind as people say it, from its name: "PDF", "Spreadsheet", … else its extension. */
export function fileKind(name: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const doc = () => tr("Document");
  const sheet = () => tr("Spreadsheet");
  const slides = () => tr("Presentation");
  const image = () => tr("Image");
  const kinds: Record<string, () => string> = { pdf: () => "PDF", doc, docx: doc, odt: doc, xls: sheet, xlsx: sheet, ods: sheet, csv: sheet, ppt: slides, pptx: slides, odp: slides, png: image, jpg: image, jpeg: image, gif: image, webp: image, txt: () => tr("Text"), md: () => tr("Text"), zip: () => tr("Archive") };
  return kinds[ext]?.() ?? ext.toUpperCase();
}

/** A room or a resource: booked by adding its address to an event as a guest. */
export interface Room {
  id: string;
  name: string;
  kind: "Room" | "Resource";
  address: string;
  capacity?: number | null;
  place?: string | null;
  hours?: { days: number[]; from: string; to: string; timezone?: string | null } | null;
  may_book: boolean;
  everyone: boolean;
  bookers: { person?: string; role?: string }[];
}

/** Whether a guest's address is a room's or a resource's (never mailed). */
export const isRoom = (email: string) => /@rooms\.ferrum\.invalid$/i.test(email);
