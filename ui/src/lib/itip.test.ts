import { describe, expect, it } from "vitest";
import { answersIn, ferrumEvent, fold, replyIcs } from "./itip";

const INVITE = [
  "BEGIN:VCALENDAR", "PRODID:-//Ferrum//Comms//EN", "VERSION:2.0", "METHOD:REQUEST",
  "BEGIN:VTIMEZONE", "TZID:Asia/Kolkata", "BEGIN:STANDARD", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:design-review-2026-11-13@demo.test", "DTSTAMP:20261110T093000Z", "SEQUENCE:2", "DTSTART;TZID=Asia/Kolkata:20261113T110000", "DTEND;TZID=Asia/Kolkata:20261113T120000",
  "SUMMARY:Design review", "LOCATION:Banyan room", "ORGANIZER;CN=Priya Nair:mailto:priya.nair@demo.test",
  "ATTENDEE;CN=Administrator;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:admin@demo.test",
  "ATTENDEE;CN=Omar Haddad;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:omar.haddad@demo.test",
  "DESCRIPTION:Review the new mail screens before the offsite.", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

describe("answering an invitation by mail", () => {
  it("sends the organiser a REPLY with the event's lines and only one's own answer", () => {
    const ics = replyIcs(INVITE, { email: "admin@demo.test", name: "Administrator" }, "ACCEPTED", new Date("2026-11-12T04:00:00Z"))!;
    expect(ics.split("\r\n")).toEqual([
      "BEGIN:VCALENDAR", "PRODID:-//Ferrum//Mail//EN", "VERSION:2.0", "METHOD:REPLY",
      "BEGIN:VTIMEZONE", "TZID:Asia/Kolkata", "BEGIN:STANDARD", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:design-review-2026-11-13@demo.test", "SEQUENCE:2", "DTSTART;TZID=Asia/Kolkata:20261113T110000", "DTEND;TZID=Asia/Kolkata:20261113T120000",
      "SUMMARY:Design review", "ORGANIZER;CN=Priya Nair:mailto:priya.nair@demo.test", "DTSTAMP:20261112T040000Z",
      'ATTENDEE;PARTSTAT=ACCEPTED;CN="Administrator":mailto:admin@demo.test', "END:VEVENT", "END:VCALENDAR", "",
    ]);
    expect(replyIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { email: "a@x" }, "DECLINED")).toBeNull();
  });

  it("reads who answered what from a REPLY, and nothing from a REQUEST", () => {
    const reply = replyIcs(INVITE, { email: "Omar.Haddad@demo.test" }, "TENTATIVE")!;
    expect(answersIn(reply)).toEqual({ uid: "design-review-2026-11-13@demo.test", answers: [{ email: "omar.haddad@demo.test", name: null, response: "Tentative" }] });
    expect(answersIn(INVITE)).toBeNull();
  });

  it("folds long lines at 75 octets and knows Ferrum's own event ids", () => {
    const long = `SUMMARY:${"ब".repeat(40)}`;
    const folded = fold(long);
    expect(folded.split("\r\n ").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(ferrumEvent("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@ferrum")).toBe("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    expect(ferrumEvent("design-review@demo.test")).toBeNull();
  });
});
