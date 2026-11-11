import { describe, expect, it } from "vitest";
import { notificationText, notifying, snoozeChoices, wakeKeys, wakeKeyword, wakeOf, type Arrived } from "./watch";

const m = (id: string, from: string, box = "a", kw: Record<string, boolean> = {}): Arrived => ({ id, threadId: id, mailboxIds: { [box]: true }, keywords: kw, from: [{ name: from.split("@")[0], email: from }], subject: `S ${id}` });

describe("new mail", () => {
  const list = [m("1", "ann@x.example"), m("2", "bob@y.example", "u"), m("3", "me@demo.test"), m("4", "cy@z.example", "a", { $seen: true }), m("5", "dee@w.example")];
  it("notifies unread inbox mail from others, as chosen", () => {
    expect(notifying(list, "a", ["Me@demo.test"], "all", () => false).map((x) => x.id)).toEqual(["1", "5"]);
    expect(notifying(list, "a", ["me@demo.test"], "people", (e) => e === "dee@w.example").map((x) => x.id)).toEqual(["5"]);
    expect(notifying(list, "a", [], "none", () => true)).toEqual([]);
    expect(notifying(list, undefined, [], "all", () => true)).toEqual([]);
  });
  it("says one by sender and subject, several by count", () => {
    expect(notificationText([list[0]!])).toEqual({ title: "ann", body: "S 1" });
    expect(notificationText([list[0]!, list[4]!, list[0]!])).toEqual({ title: "3 new messages", body: "ann, dee" });
  });
});

describe("snooze", () => {
  it("keeps the wake time in a keyword", () => {
    const at = new Date(Date.UTC(2026, 10, 13, 8, 0));
    const k = wakeKeyword(at);
    expect(k).toBe("$ferrum_wake_202611130800");
    expect(wakeOf({ [k.toLowerCase()]: true, $seen: true })?.toISOString()).toBe(at.toISOString());
    expect(wakeOf({ $seen: true })).toBeNull();
    expect(wakeKeys({ [k]: true, $flagged: true })).toEqual([k]);
  });
  it("offers later today only before evening, then tomorrow and next week, on the person's clock", () => {
    // A clock 5:30 ahead of UTC (India), whatever the browser's.
    const off = 5.5 * 3600_000;
    const toLocal = (iso: string) => new Date(Date.parse(iso) + off).toISOString().slice(0, 16);
    const fromLocal = (w: string) => new Date(Date.parse(`${w}:00Z`) - off).toISOString();
    const morning = new Date("2026-11-12T03:30:00Z"); // Thursday 09:00 there
    const c = snoozeChoices(morning, toLocal, fromLocal);
    expect(c.map((x) => x.id)).toEqual(["later", "tomorrow", "week"]);
    expect(c.map((x) => toLocal(x.at.toISOString()))).toEqual(["2026-11-12T18:00", "2026-11-13T08:00", "2026-11-16T08:00"]);
    expect(snoozeChoices(new Date("2026-11-12T14:30:00Z"), toLocal, fromLocal).map((x) => x.id)).toEqual(["tomorrow", "week"]);
  });
});
