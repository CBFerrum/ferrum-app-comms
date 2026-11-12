import { describe, expect, it } from "vitest";
import { byDay, daysOf, isoDay, monthGrid, movable, moved, placeDay, safeColor, safeLink, sameTimeOn, weekOf, type Occurrence } from "./calendar";

const occ = (id: string, start: string, end: string, all_day = false): Occurrence => ({ id, event: id, start, end, all_day, subject: id });

describe("calendar", () => {
  it("lays a month out as six Monday-first weeks", () => {
    const g = monthGrid(new Date(2026, 9, 15)); // October 2026 starts on a Thursday
    expect(g).toHaveLength(42);
    expect(isoDay(g[0]!)).toBe("2026-09-28");
    expect(g[0]!.getDay()).toBe(1);
    expect(isoDay(g[41]!)).toBe("2026-11-08");
  });

  it("puts all-day events on their dates, exclusive end", () => {
    expect(daysOf(occ("a", "2026-10-30T00:00:00Z", "2026-11-01T00:00:00Z", true))).toEqual(["2026-10-30", "2026-10-31"]);
    expect(daysOf(occ("b", "2026-10-30T00:00:00Z", "2026-10-30T00:00:00Z", true))).toEqual(["2026-10-30"]);
  });

  it("puts timed events on each local day they touch, and orders a day", () => {
    const at = (h: number, d = 30) => new Date(2026, 9, d, h).toISOString();
    expect(daysOf(occ("t", at(9), at(10)))).toEqual(["2026-10-30"]);
    expect(daysOf(occ("n", at(22), at(0, 31)))).toEqual(["2026-10-30"]); // ends at midnight
    expect(daysOf(occ("o", at(22), at(2, 31)))).toEqual(["2026-10-30", "2026-10-31"]);
    const day = byDay([occ("late", at(15), at(16)), occ("early", at(9), at(10)), occ("whole", "2026-10-30T00:00:00Z", "2026-10-31T00:00:00Z", true)]).get("2026-10-30");
    expect(day?.map((o) => o.id)).toEqual(["whole", "early", "late"]);
  });

  it("lays a week out Monday first and places overlapping events in lanes", () => {
    expect(weekOf(new Date(2026, 9, 29)).map(isoDay)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    const at = (h: number, m = 0, d = 30) => new Date(2026, 9, d, h, m).toISOString();
    const day = new Date(2026, 9, 30);
    const placed = placeDay([occ("a", at(9), at(11)), occ("b", at(10), at(10, 30)), occ("c", at(13), at(13)), occ("late", at(23), at(1, 0, 31)), occ("x", "2026-10-30T00:00:00Z", "2026-10-31T00:00:00Z", true)], day);
    expect(placed.map((p) => [p.o.id, p.from, p.to, p.lane, p.lanes])).toEqual([
      ["a", 540, 660, 0, 2],
      ["b", 600, 630, 1, 2],
      ["c", 780, 795, 0, 1],
      ["late", 1380, 1440, 0, 1],
    ]);
    expect(placeDay([occ("late", at(23), at(1, 0, 31))], new Date(2026, 9, 31)).map((p) => [p.from, p.to])).toEqual([[0, 60]]);
  });

  it("moves an event keeping its length, all-day ones by whole days", () => {
    const timed = { ...occ("t", new Date(2026, 9, 30, 9).toISOString(), new Date(2026, 9, 30, 10, 30).toISOString()), is_organizer: true };
    const to = moved(timed, new Date(2026, 10, 2, 14));
    expect([to.starts_at, to.ends_at]).toEqual([new Date(2026, 10, 2, 14).toISOString(), new Date(2026, 10, 2, 15, 30).toISOString()]);
    expect(sameTimeOn(timed, new Date(2026, 10, 4)).getTime()).toBe(new Date(2026, 10, 4, 9).getTime());
    const whole = occ("w", "2026-10-30T00:00:00Z", "2026-11-01T00:00:00Z", true);
    expect(moved(whole, new Date(2026, 10, 5, 15))).toEqual({ starts_at: "2026-11-05T00:00:00.000Z", ends_at: "2026-11-07T00:00:00.000Z" });
    expect([movable(timed), movable({ ...timed, recurring: true }), movable({ ...timed, is_organizer: false }), movable({ ...timed, status: "Cancelled" })]).toEqual([true, false, false, false]);
  });

  it("only lets safe colors and links through", () => {
    expect([safeColor("#0a7"), safeColor("#00aa77ff"), safeColor("red;background:url(x)"), safeColor(null)]).toEqual(["#0a7", "#00aa77ff", undefined, undefined]);
    expect([safeLink("https://meet.example/x"), safeLink("javascript:alert(1)")]).toEqual(["https://meet.example/x", undefined]);
  });
});

import { answerWord, bars, clashes, fromInput, mergeGuests, nextHour, parseGuests, reminderOf, repeatOf, ruleFor, stretch, suggestSlots, tally, toInput } from "./calendar";

describe("guests and their answers", () => {
  it("says answers as people do, and how many said what", () => {
    expect([answerWord("Accepted"), answerWord("Tentative"), answerWord("Declined"), answerWord("Needs Action"), answerWord(null)]).toEqual(["Yes", "Maybe", "No", "No reply yet", "No reply yet"]);
    expect(tally([{ response: "Accepted" }, { response: "Accepted" }, { response: "Tentative" }, { response: "Needs Action" }])).toBe("2 yes, 1 maybe, 1 waiting");
    expect(tally([])).toBe("");
  });

  it("reads typed addresses, once each, and points out what is not one", () => {
    expect(parseGuests("Ana@x.test, bo@x.test; ana@x.test\n<cy@x.test> nope x@y")).toEqual({ emails: ["ana@x.test", "bo@x.test", "cy@x.test"], bad: ["nope", "x@y"] });
    expect(parseGuests("  ")).toEqual({ emails: [], bad: [] });
  });

  it("keeps the answers of those who stay on the list", () => {
    const was = [{ email: "ana@x.test", name: "Ana", response: "Accepted", comment: "Yes!" }, { email: "gone@x.test", response: "Declined" }];
    expect(mergeGuests(was, ["Ana@x.test", "new@x.test"], { "new@x.test": "Nia" })).toEqual([
      { email: "Ana@x.test", attendee_name: "Ana", response: "Accepted", comment: "Yes!" },
      { email: "new@x.test", attendee_name: "Nia", response: "Needs Action" },
    ]);
  });
});

describe("finding a time", () => {
  const at = (h: number, m = 0, d = 2) => new Date(2026, 10, d, h, m); // Mon 2 Nov 2026
  const busy = { "ana@x.test": [{ start: at(10).toISOString(), end: at(11).toISOString() }], "bo@x.test": [{ start: at(9).toISOString(), end: at(9, 30).toISOString() }] };

  it("finds who is busy at some point of a span", () => {
    expect(clashes(busy, at(10, 30), at(11, 30))).toEqual(["ana@x.test"]);
    expect(clashes(busy, at(11), at(12))).toEqual([]);
    expect(clashes(busy, at(9, 15), at(10, 15)).sort()).toEqual(["ana@x.test", "bo@x.test"]);
    expect(clashes({}, at(9), at(10))).toEqual([]);
  });

  it("suggests the first times that suit everyone, in working hours", () => {
    const slots = suggestSlots(busy, { from: at(8), days: 1, minutes: 60, limit: 3 });
    expect(slots.map((d) => toInput(d))).toEqual(["2026-11-02T11:00", "2026-11-02T11:30", "2026-11-02T12:00"]);
    // From the middle of the day, nothing earlier; a day of nothing free moves on to the next one; weekends are skipped.
    expect(suggestSlots({}, { from: at(15, 10), days: 1, minutes: 30, limit: 2 }).map(toInput)).toEqual(["2026-11-02T15:30", "2026-11-02T16:00"]);
    expect(suggestSlots(busy, { from: at(17, 45), days: 8, minutes: 60, limit: 1, start: 9, end: 18 }).map(toInput)).toEqual(["2026-11-03T09:00"]);
    expect(suggestSlots({}, { from: new Date(2026, 10, 7, 10), days: 1, minutes: 30 })).toEqual([]);
    expect(suggestSlots({}, { from: new Date(2026, 10, 7, 10), days: 1, minutes: 30, weekends: true, limit: 1 })).toHaveLength(1);
  });

  it("lays busy time on the hours shown", () => {
    expect(bars(busy["ana@x.test"]!, at(0), 8, 18)).toEqual([{ left: 20, width: 10 }]);
    expect(bars([{ start: at(6).toISOString(), end: at(9).toISOString() }], at(0), 8, 18)).toEqual([{ left: 0, width: 10 }]);
    expect(bars([{ start: at(19).toISOString(), end: at(20).toISOString() }], at(0), 8, 18)).toEqual([]);
    expect(stretch({ start: at(10).toISOString(), end: at(11, 30).toISOString() })).toMatch(/10.00.*11.30/);
  });
});

describe("the editor's fields", () => {
  it("writes and reads the date inputs in the viewer's time", () => {
    expect(toInput(new Date(2026, 10, 2, 9, 5))).toBe("2026-11-02T09:05");
    expect(fromInput("2026-11-02T09:05")?.getTime()).toBe(new Date(2026, 10, 2, 9, 5).getTime());
    expect(fromInput("2026-11-02")?.getTime()).toBe(new Date(2026, 10, 2).getTime());
    expect([fromInput("2026-02-31"), fromInput("tomorrow"), fromInput("")]).toEqual([null, null, null]);
    expect(nextHour(new Date(2026, 10, 2, 9, 40)).getTime()).toBe(new Date(2026, 10, 2, 10).getTime());
  });

  it("turns a repeat choice into a rule and back, keeping what it cannot show", () => {
    expect(ruleFor("weekly", "")).toBe("FREQ=WEEKLY");
    expect(ruleFor("weekdays", "2026-12-31")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231");
    expect(ruleFor("none", "2026-12-31")).toBeNull();
    for (const kind of ["daily", "weekdays", "weekly", "monthly", "yearly"] as const) expect(repeatOf(ruleFor(kind, "2027-01-15"))).toEqual({ kind, until: "2027-01-15" });
    expect(repeatOf(null)).toEqual({ kind: "none", until: "" });
    expect(repeatOf("FREQ=WEEKLY;INTERVAL=2")).toEqual({ kind: "custom", until: "" });
    expect(repeatOf("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5").kind).toBe("custom");
  });

  it("shows one reminder, or says there are others", () => {
    expect([reminderOf([]), reminderOf([15]), reminderOf([0]), reminderOf([7]), reminderOf([10, 60])]).toEqual(["none", 15, 0, "custom", "custom"]);
  });
});
