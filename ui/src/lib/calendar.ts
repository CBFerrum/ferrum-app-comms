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
