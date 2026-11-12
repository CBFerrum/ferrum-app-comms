import { afterEach, describe, expect, it, vi } from "vitest";
import { barsAcross, dayFrom, daysShown, endBefore, firstDayOf, followingRule, fromInputIn, isoDay, matches, monthGrid, skipping, snap, stepped, toInputIn, unbounded, weekendOf, type Occurrence } from "./calendar";

const occ = (id: string, start: string, end: string, all_day = false, extra: Partial<Occurrence> = {}): Occurrence => ({ id, event: id, start, end, all_day, subject: id, ...extra });
const days = (list: Date[]) => list.map(isoDay);

describe("calendar views", () => {
  it("takes the week's first day and weekend from the locale", () => {
    expect([firstDayOf("en-GB"), firstDayOf("en-US"), firstDayOf("ar-EG"), firstDayOf("hi-IN"), firstDayOf("not a tag")]).toEqual([1, 0, 6, 0, 1]);
    expect(weekendOf("en-GB").sort()).toEqual([0, 6]);
    expect(weekendOf("ar-EG").sort()).toEqual([5, 6]);
    // October 2026 starts on a Thursday: Sunday-first grids start on 27 September.
    expect(isoDay(monthGrid(new Date(2026, 9, 15), 0)[0]!)).toBe("2026-09-27");
  });

  it("shows the days of each view, and steps by them", () => {
    const o = { first: 1, weekend: [6, 0] };
    const thu = new Date(2026, 10, 12);
    expect(days(daysShown("day", thu, o))).toEqual(["2026-11-12"]);
    expect(days(daysShown("workweek", thu, o))).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(days(daysShown("workweek", thu, { first: 6, weekend: [5, 6] }))).toEqual(["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(days(daysShown("week", thu, o))).toHaveLength(7);
    expect(days(daysShown("week", thu, { ...o, narrow: true }))).toEqual(["2026-11-12", "2026-11-13", "2026-11-14"]);
    expect(daysShown("month", thu, o)).toHaveLength(42);
    expect(daysShown("agenda", thu, o)).toHaveLength(30);
    expect(daysShown("year", thu, o)).toHaveLength(365);
    expect(isoDay(stepped("day", thu, -1))).toBe("2026-11-11");
    expect(isoDay(stepped("week", thu, 1))).toBe("2026-11-19");
    expect(isoDay(stepped("week", thu, 1, true))).toBe("2026-11-15");
    expect(isoDay(stepped("month", new Date(2027, 0, 31), 1))).toBe("2027-02-01");
    expect(isoDay(stepped("year", thu, 1))).toBe("2027-01-01");
    expect([dayFrom("2026-02-30"), dayFrom("x"), dayFrom(null)]).toEqual([null, null, null]);
    expect([snap(52, 15), snap(-10, 15), snap(1500, 15)]).toEqual([45, 0, 1440]);
  });

  it("lays all-day and multi-day events as bars across the days, in rows that do not collide", () => {
    const week = daysShown("week", new Date(2026, 10, 12), { first: 1, weekend: [6, 0] });
    const bars = barsAcross(
      [
        occ("trip", "2026-11-08T00:00:00Z", "2026-11-11T00:00:00Z", true), // Sun–Tue: starts before the week
        occ("offsite", "2026-11-10T00:00:00Z", "2026-11-13T00:00:00Z", true), // Tue–Thu
        occ("fri", "2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z", true),
        occ("overnight", new Date(2026, 10, 14, 22).toISOString(), new Date(2026, 10, 15, 6).toISOString()),
        occ("meeting", new Date(2026, 10, 12, 9).toISOString(), new Date(2026, 10, 12, 10).toISOString()),
      ],
      week,
    );
    expect(bars.map((b) => [b.o.id, b.col, b.span, b.row, b.before, b.after])).toEqual([
      ["trip", 0, 2, 0, true, false],
      ["offsite", 1, 3, 1, false, false],
      ["fri", 4, 1, 0, false, false],
      ["overnight", 5, 2, 0, false, false],
    ]);
  });

  it("finds events by every word, in any case and without accents", () => {
    const o = occ("x", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z", false, { subject: "Café review", location: "Room 4", owner: "asha@acme.test" });
    expect([matches(o, "cafe ROOM"), matches(o, "asha"), matches(o, "review lunch")]).toEqual([true, true, false]);
  });

  it("types times on the event's clock, across a change of clocks", () => {
    // 09:00 in London is 08:00 UTC in October and 09:00 UTC in November.
    expect(fromInputIn("2026-10-19T09:00", "Europe/London")?.toISOString()).toBe("2026-10-19T08:00:00.000Z");
    expect(fromInputIn("2026-11-02T09:00", "Europe/London")?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(toInputIn(new Date("2026-11-02T03:30:00Z"), "Asia/Kolkata")).toBe("2026-11-02T09:00");
    expect(toInputIn(new Date("2026-10-06T22:00:00Z"), "Australia/Lord_Howe")).toBe("2026-10-07T09:00");
    expect(fromInputIn("2026-03-08T02:30", "America/New_York")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(fromInputIn("nonsense", "Europe/London")).toBeNull();
  });

  it("divides a repeating event at an occurrence", () => {
    const at = new Date(2026, 10, 16, 9);
    expect(unbounded("FREQ=WEEKLY;COUNT=10;BYDAY=MO")).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(endBefore("FREQ=WEEKLY;UNTIL=20271231", at)).toBe("FREQ=WEEKLY;UNTIL=20261115");
    expect(followingRule("FREQ=WEEKLY;COUNT=10", 3)).toBe("FREQ=WEEKLY;COUNT=7");
    expect(followingRule("FREQ=WEEKLY;UNTIL=20271231", 3)).toBe("FREQ=WEEKLY;UNTIL=20271231");
    expect(skipping(["2026-11-09"], "2026-11-16T09:00:00Z")).toEqual(["2026-11-09", "2026-11-16T09:00:00.000Z"]);
    expect(skipping(["2026-11-16T09:00:00.000Z"], "2026-11-16T09:00:00Z")).toEqual(["2026-11-16T09:00:00.000Z"]);
  });
});

const calls: [string, string, unknown?][] = [];
vi.mock("@ferrum/client", async (orig) => {
  const real = await orig<typeof import("@ferrum/client")>();
  const series = {
    id: "s1",
    version: 4,
    subject: "Stand-up",
    starts_at: "2026-11-02T09:00:00.000Z",
    ends_at: "2026-11-02T09:15:00.000Z",
    timezone: "Europe/London",
    recurrence: "FREQ=WEEKLY;COUNT=10",
    recurrence_exceptions: ["2026-11-30T09:00:00.000Z"],
    attendees: [{ email: "bo@acme.test", attendee_name: "Bo", response: "Accepted" }],
    reminders: [{ minutes_before: 10 }],
    calendar: "c9",
  };
  const record = (m: string) => async (path: string, body?: unknown) => {
    calls.push([m, path, body]);
    if (m === "GET" && path.endsWith("/calendar/events")) return { occurrences: [{ id: "a", event: "s1", start: "2026-11-02T09:00:00Z" }, { id: "b", event: "s1", start: "2026-11-09T09:00:00Z" }] };
    if (m === "GET") return series;
    if (m === "POST") return { id: "n1" };
    return { version: 5 };
  };
  return { ...real, api: { get: record("GET"), post: record("POST"), patch: record("PATCH"), del: record("DELETE") }, docPath: (e: string, id?: string) => `/api/r/${e}${id ? `/${id}` : ""}` };
});

describe("changing a repeating event in a calendar shared to make changes", () => {
  afterEach(() => void (calls.length = 0));
  it("reads and writes through Calendar's routes, keeping the event in its calendar", async () => {
    const { changeTimes, removeOccurrence } = await import("./calendarChanges");
    const o: Occurrence = { id: "s1/x", event: "s1", start: "2026-11-16T09:00:00.000Z", end: "2026-11-16T09:15:00.000Z", all_day: false, subject: "Stand-up", recurring: true, level: "edit", calendar: "c9" };
    await changeTimes(o, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:30:00Z"), "this");
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ["GET", "/api/app/comms/calendar/events/s1/record"],
      ["POST", "/api/app/comms/calendar/events"],
      ["PATCH", "/api/app/comms/calendar/events/s1"],
    ]);
    expect(calls[1]![2]).toEqual(expect.objectContaining({ calendar: "c9" }));
    calls.length = 0;
    await removeOccurrence(o, "all");
    expect(calls.map((c) => [c[0], c[1]])).toEqual([["GET", "/api/app/comms/calendar/events/s1/record"], ["DELETE", "/api/app/comms/calendar/events/s1"]]);
  });
});

describe("changing a repeating event", () => {
  afterEach(() => void (calls.length = 0));
  const o: Occurrence = { id: "s1/x", event: "s1", start: "2026-11-16T09:00:00.000Z", end: "2026-11-16T09:15:00.000Z", all_day: false, subject: "Stand-up", recurring: true, is_organizer: true };

  it("this event: an event of its own, and the occurrence skipped; Undo takes both back", async () => {
    const { changeTimes } = await import("./calendarChanges");
    const undo = await changeTimes(o, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:30:00Z"), "this");
    const [, post, patch] = calls;
    expect(post).toEqual(["POST", "/api/r/CalendarEvent", expect.objectContaining({ subject: "Stand-up", starts_at: "2026-11-16T10:00:00.000Z", ends_at: "2026-11-16T10:30:00.000Z", timezone: "Europe/London", reminders: [{ minutes_before: 10 }] })]);
    expect((post![2] as Record<string, unknown>).recurrence).toBeUndefined();
    expect(patch).toEqual(["PATCH", "/api/r/CalendarEvent/s1", { recurrence_exceptions: ["2026-11-30T09:00:00.000Z", "2026-11-16T09:00:00.000Z"] }]);
    calls.length = 0;
    await undo();
    expect(calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ["DELETE", "/api/r/CalendarEvent/n1", undefined],
      ["PATCH", "/api/r/CalendarEvent/s1", { recurrence_exceptions: ["2026-11-30T09:00:00.000Z"] }],
    ]);
  });

  it("this and following: the series ends the day before, a new one takes the rest of its COUNT and later exceptions", async () => {
    const { changeTimes } = await import("./calendarChanges");
    await changeTimes(o, new Date("2026-11-16T09:30:00Z"), new Date("2026-11-16T09:45:00Z"), "following");
    const post = calls.find((c) => c[0] === "POST")!;
    expect(post[2]).toEqual(expect.objectContaining({ recurrence: "FREQ=WEEKLY;COUNT=8", recurrence_exceptions: ["2026-11-30T09:30:00.000Z"], starts_at: "2026-11-16T09:30:00.000Z" }));
    expect(calls.find((c) => c[0] === "PATCH")![2]).toEqual({ recurrence: "FREQ=WEEKLY;UNTIL=20261115" });
  });

  it("all events: the series moves by as much, its exceptions with it", async () => {
    const { changeTimes, removeOccurrence } = await import("./calendarChanges");
    await changeTimes(o, new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:15:00Z"), "all");
    expect(calls.find((c) => c[0] === "PATCH")![2]).toEqual({ starts_at: "2026-11-02T10:00:00.000Z", ends_at: "2026-11-02T10:15:00.000Z", recurrence_exceptions: ["2026-11-30T10:00:00.000Z"] });
    calls.length = 0;
    const undo = await removeOccurrence(o, "this");
    expect(calls.find((c) => c[0] === "PATCH")![2]).toEqual({ recurrence_exceptions: ["2026-11-30T09:00:00.000Z", "2026-11-16T09:00:00.000Z"] });
    calls.length = 0;
    await undo();
    expect(calls).toEqual([["PATCH", "/api/r/CalendarEvent/s1", { recurrence_exceptions: ["2026-11-30T09:00:00.000Z"] }]]);
  });
});

import { awayOn, inHours, suggestSlots as suggest, workBar } from "./calendar";

describe("working hours", () => {
  const kolkata = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", timezone: "Asia/Kolkata" };
  it("reads a time on the person's own clock", () => {
    // 04:00–05:00 UTC is 09:30–10:30 in Kolkata on a Monday; 13:00 UTC is 18:30 there.
    expect(inHours(kolkata, new Date("2026-11-16T04:00:00Z"), new Date("2026-11-16T05:00:00Z"))).toBe(true);
    expect(inHours(kolkata, new Date("2026-11-16T12:00:00Z"), new Date("2026-11-16T13:00:00Z"))).toBe(false);
    expect(inHours(kolkata, new Date("2026-11-21T04:00:00Z"), new Date("2026-11-21T05:00:00Z"))).toBe(false); // Saturday
    const away = { ...kolkata, away_from: "2026-11-16", away_to: "2026-11-17" };
    expect(inHours(away, new Date("2026-11-16T04:00:00Z"), new Date("2026-11-16T05:00:00Z"))).toBe(false);
    expect([awayOn(away, new Date(2026, 10, 17)), awayOn(away, new Date(2026, 10, 18)), awayOn(undefined, new Date())]).toEqual([true, false, false]);
  });

  it("suggests only times inside every guest's hours, and draws them on the viewer's day", () => {
    const ny = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00", timezone: "America/New_York" };
    const got = suggest({}, { from: new Date("2026-11-16T00:00:00Z"), days: 1, minutes: 60, start: 0, end: 24, limit: 50, hours: { a: kolkata, b: ny } });
    // Kolkata 09:00–18:00 is 03:30–12:30 UTC; New York 09:00–17:00 is 14:00–22:00 UTC: no overlap.
    expect(got).toEqual([]);
    const both = suggest({}, { from: new Date("2026-11-16T00:00:00Z"), days: 1, minutes: 60, start: 0, end: 24, step: 30, limit: 50, hours: { b: ny } });
    expect(both.map((d) => d.toISOString().slice(11, 16))[0]).toBe("14:00");
    const bar = workBar(ny, new Date(2026, 10, 16), 0, 24);
    // At most 8 of the viewer's 24 hours (less where their day cuts it, in the zone the tests run in).
    expect(bar!.width > 0 && bar!.width <= 100 / 3 + 0.01).toBe(true);
    expect(workBar({ ...ny, days: [] }, new Date(2026, 10, 16), 0, 24)).toBeNull();
  });
});

import { colorOf, movable as canMove, toneVar, withCalendars, type Cal } from "./calendar";

describe("several calendars", () => {
  const cal = (id: string, extra: Partial<Cal> = {}): Cal => ({ id, name: id, tone: "green", hidden: false, is_default: false, owner: "me@acme.test", level: "owner", shares: [], ...extra });
  const o = (id: string, calendar: string | null, extra: Partial<Occurrence> = {}): Occurrence => ({ id, event: id, start: "2027-03-10T10:00:00Z", end: "2027-03-10T11:00:00Z", all_day: false, subject: id, calendar, ...extra });
  it("colours each event by its calendar, leaves hidden calendars out, and names a busy-only one Busy", () => {
    const cals = [cal("personal", { is_default: true, tone: "blue" }), cal("team", { tone: "amber" }), cal("hers", { level: "free_busy", owner: "ana@acme.test" })];
    const got = withCalendars([o("a", "team"), o("b", null, { is_organizer: true }), o("c", "hers", { level: "free_busy", subject: "Busy" }), o("d", "gone")], cals, new Set(["personal"]));
    expect(got.map((x) => [x.id, x.tone, x.calendarName])).toEqual([["a", "amber", "team"], ["c", "green", "hers"], ["d", undefined, undefined]]);
    expect(colorOf(got[0]!)).toBe("var(--warning)");
    expect(colorOf({ color: "#123456", tone: "red" })).toBe("#123456");
    expect([toneVar("purple", true), toneVar("nonsense")]).toEqual(["var(--purple-soft)", "var(--primary)"]);
  });
  it("lets 'make changes' move an event or a series, and never a free/busy or details one", () => {
    const base = o("x", "team");
    expect([canMove({ ...base, level: "edit" }), canMove({ ...base, level: "edit", recurring: true }), canMove({ ...base, level: "free_busy" }), canMove({ ...base, level: "details" }), canMove({ ...base, level: "edit", status: "Cancelled" })]).toEqual([true, true, false, false, false]);
  });
});

import { changeable, fileKind, isRoom, subscriptionState } from "./calendar";

describe("wave 3 helpers", () => {
  it("never lets a subscribed event be changed, and lets 'make changes' change one", () => {
    expect([changeable({ is_organizer: true, fetched: true }), changeable({ level: "edit" }), changeable({ level: "details" }), changeable({ is_organizer: true })]).toEqual([false, true, false, true]);
  });
  it("says how a subscription's last fetch went", () => {
    expect(subscriptionState({ failures: 2, result: "failed: its server answered 500" }, () => "x")).toEqual({ failed: true, text: "its server answered 500" });
    expect(subscriptionState({ failures: 0, fetched_at: "2027-03-01T00:00:00Z", result: "up to date" }, (at) => `at ${at}`)).toEqual({ failed: false, text: "at 2027-03-01T00:00:00Z" });
  });
  it("names a file's kind and knows a room's address", () => {
    expect([fileKind("Budget.XLSX"), fileKind("notes.pdf"), fileKind("photo.heic"), fileKind("README")]).toEqual(["Spreadsheet", "PDF", "HEIC", ""]);
    expect([isRoom("board-1a2b3c@rooms.ferrum.invalid"), isRoom("ana@acme.test")]).toEqual([true, false]);
  });
});
