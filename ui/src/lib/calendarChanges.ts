// Changing and deleting events from the calendar's grid, as the server's records API takes them:
// one event, or for a repeating one this occurrence (an exception plus an event of its own), this
// and the following ones (the series ended the day before, a new series from here) or all of them.
// Each change returns its Undo, which puts back exactly what it changed.
// An event in a calendar shared with me to "make changes" goes through Calendar's own routes
// (`/calendar/events`), which keep its owner the organizer; my own through the records API.

import { api, docPath } from "@ferrum/client";
import { CALENDAR, endBefore, followingRule, isoDay, skipping, type Occurrence, type Scope } from "./calendar";

/** An event as the records API gives it. */
export interface EventDoc {
  id: string;
  version: number;
  subject: string;
  starts_at: string;
  ends_at: string;
  all_day?: boolean;
  timezone?: string | null;
  location?: string | null;
  meeting_link?: string | null;
  description?: string | null;
  calendar?: string | null;
  owner?: string | null;
  visibility?: string | null;
  status?: string | null;
  category?: string | null;
  color?: string | null;
  recurrence?: string | null;
  recurrence_exceptions?: string[] | null;
  attendees?: { email: string; attendee_name?: string | null; response?: string; comment?: string | null }[];
  reminders?: { minutes_before: number }[];
}

export type Undo = () => Promise<unknown>;

/** Where an event is read and written: the records API for my own, Calendar's routes for a calendar shared with me. */
export interface Routes {
  get(id: string): Promise<EventDoc>;
  create(body: Record<string, unknown>): Promise<{ id: string; version?: number }>;
  patch(id: string, body: Record<string, unknown>, version?: number): Promise<{ version?: number }>;
  del(id: string): Promise<unknown>;
}

const own: Routes = {
  get: (id) => api.get<EventDoc>(docPath("CalendarEvent", id)),
  create: (body) => api.post<{ id: string; version?: number }>(docPath("CalendarEvent"), body),
  patch: (id, body, version) => api.patch<{ version?: number }>(docPath("CalendarEvent", id), body, version ? { ifMatch: version } : undefined),
  del: (id) => api.del(docPath("CalendarEvent", id)),
};

const shared: Routes = {
  get: (id) => api.get<EventDoc>(`${CALENDAR}/events/${id}/record`),
  create: (body) => api.post<{ id: string; version?: number }>(`${CALENDAR}/events`, body),
  patch: (id, body, version) => api.patch<{ version?: number }>(`${CALENDAR}/events/${id}`, body, version ? { ifMatch: version } : undefined),
  del: (id) => api.del(`${CALENDAR}/events/${id}`),
};

/** The routes for an event I reach at `level` (`edit`: a calendar shared with me to make changes). */
export const routesFor = (level?: string | null): Routes => (level === "edit" ? shared : own);

const iso = (t: number | string | Date) => new Date(t).toISOString();

/** A new event with `doc`'s details at `start`–`end` (its guests keep their answers, the organizer is whoever creates it). */
export function copyOf(doc: EventDoc, start: number | string | Date, end: number | string | Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    subject: doc.subject,
    starts_at: iso(start),
    ends_at: iso(end),
    all_day: !!doc.all_day,
    attendees: (doc.attendees ?? []).map((a) => ({ email: a.email, ...(a.attendee_name ? { attendee_name: a.attendee_name } : {}), response: a.response ?? "Needs Action" })),
    reminders: (doc.reminders ?? []).map((r) => ({ minutes_before: r.minutes_before })),
  };
  for (const k of ["timezone", "location", "meeting_link", "description", "visibility", "category", "color", "status", "calendar"] as const) if (doc[k] != null) body[k] = doc[k];
  return { ...body, ...extra };
}

/** Instants in an exception list moved by `delta` (dates by whole days), so they still name their occurrences after the series moves. */
export function shiftExceptions(list: string[] | null | undefined, delta: number): string[] {
  const DAY = 86_400_000;
  return (list ?? []).map((x) => {
    if (x.length > 10) return iso(Date.parse(x) + delta);
    if (delta % DAY !== 0) return x;
    const [y, m, d] = x.split("-").map(Number);
    return isoDay(new Date(y!, m! - 1, d! + delta / DAY));
  });
}

/** How many occurrences of `o`'s series come before it (for a COUNT that "this and following" divides). */
async function countBefore(o: Occurrence, doc: EventDoc): Promise<number> {
  if (!/(?:^|;)COUNT=/i.test(doc.recurrence ?? "")) return 0;
  const from = new Date(doc.starts_at);
  const to = new Date(Date.parse(o.start) - 1);
  if (to.getTime() - from.getTime() > 399 * 86_400_000) throw new Error("This series is too long to divide here. Change all of it, or end it in the event's editor.");
  const got = await api.get<{ occurrences: Occurrence[] }>(`${CALENDAR}/events`, { from: isoDay(from), to: isoDay(to) });
  return got.occurrences.filter((x) => x.event === o.event && Date.parse(x.start) < Date.parse(o.start)).length;
}

/** Moves or resizes `o` to `start`–`end`: the event, or for a repeating one the occurrences `scope` names. */
export async function changeTimes(o: Occurrence, start: Date, end: Date, scope: Scope = "all"): Promise<Undo> {
  const r = routesFor(o.level);
  const doc = await r.get(o.event);
  const first = Date.parse(o.start) <= Date.parse(doc.starts_at);
  if (!o.recurring || scope === "all" || (scope === "following" && first)) {
    const delta = start.getTime() - Date.parse(o.start);
    const begins = Date.parse(doc.starts_at) + delta;
    const body: Record<string, unknown> = { starts_at: iso(begins), ends_at: iso(begins + end.getTime() - start.getTime()) };
    if (o.recurring && doc.recurrence_exceptions?.length) body.recurrence_exceptions = shiftExceptions(doc.recurrence_exceptions, delta);
    const saved = await r.patch(doc.id, body, doc.version);
    return () => r.patch(doc.id, { starts_at: doc.starts_at, ends_at: doc.ends_at, ...(body.recurrence_exceptions ? { recurrence_exceptions: doc.recurrence_exceptions } : {}) }, saved?.version);
  }
  if (scope === "this") {
    const made = await r.create(copyOf(doc, start, end));
    try {
      await r.patch(doc.id, { recurrence_exceptions: skipping(doc.recurrence_exceptions, o.start) }, doc.version);
    } catch (e) {
      await r.del(made.id).catch(() => undefined);
      throw e;
    }
    return async () => {
      await r.del(made.id);
      await r.patch(doc.id, { recurrence_exceptions: doc.recurrence_exceptions ?? [] });
    };
  }
  const before = await countBefore(o, doc);
  const later = (doc.recurrence_exceptions ?? []).filter((x) => (x.length > 10 ? Date.parse(x) : Date.parse(`${x}T23:59:59`)) >= Date.parse(o.start));
  const made = await r.create(copyOf(doc, start, end, { recurrence: followingRule(doc.recurrence ?? "", before), recurrence_exceptions: shiftExceptions(later, start.getTime() - Date.parse(o.start)) }));
  try {
    await r.patch(doc.id, { recurrence: endBefore(doc.recurrence ?? "", new Date(o.start)) }, doc.version);
  } catch (e) {
    await r.del(made.id).catch(() => undefined);
    throw e;
  }
  return async () => {
    await r.del(made.id);
    await r.patch(doc.id, { recurrence: doc.recurrence });
  };
}

/** Deletes `o`: the event, or for a repeating one the occurrences `scope` names. Undo brings them back (a deleted event as a new one). */
export async function removeOccurrence(o: Occurrence, scope: Scope = "all"): Promise<Undo> {
  const r = routesFor(o.level);
  const doc = await r.get(o.event);
  const first = Date.parse(o.start) <= Date.parse(doc.starts_at);
  if (!o.recurring || scope === "all" || (scope === "following" && first)) {
    await r.del(doc.id);
    return () => r.create(copyOf(doc, doc.starts_at, doc.ends_at, { recurrence: doc.recurrence ?? null, recurrence_exceptions: doc.recurrence_exceptions ?? [] }));
  }
  const body = scope === "this" ? { recurrence_exceptions: skipping(doc.recurrence_exceptions, o.start) } : { recurrence: endBefore(doc.recurrence ?? "", new Date(o.start)) };
  await r.patch(doc.id, body, doc.version);
  return () => r.patch(doc.id, scope === "this" ? { recurrence_exceptions: doc.recurrence_exceptions ?? [] } : { recurrence: doc.recurrence });
}
