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
