import { describe, expect, it } from "vitest";
import { meetLink, meetPath } from "./meet";

const ORIGIN = "https://erp.example.com";
const ID = "74486aa5-c53f-4a79-9861-c44e700c1197";

describe("meet", () => {
  it("opens this app's meeting links inside it", () => {
    expect(meetLink("event", ID, ORIGIN)).toBe(`${ORIGIN}/meet/event/${ID}`);
    expect(meetPath(meetLink("event", ID, ORIGIN), ORIGIN)).toBe(`/meet/event/${ID}`);
    expect(meetPath(`${ORIGIN}/app/meet/Room/${ID.toUpperCase()}/`, ORIGIN)).toBe(`/meet/room/${ID}`);
    expect(meetPath(`/app/meet/channel/${ID}`, ORIGIN)).toBe(`/meet/channel/${ID}`);
    expect(meetPath(`${ORIGIN}/meet/room/${ID}`, ORIGIN)).toBe(`/meet/room/${ID}`);
  });

  it("leaves other links alone", () => {
    for (const href of [
      "https://meet.google.com/abc-defg-hij",
      `https://evil.example.net/app/meet/event/${ID}`,
      `${ORIGIN}/app/meet/space/${ID}`,
      `${ORIGIN}/app/meet/event/${ID}/extra`,
      `${ORIGIN}/app/drive?item=${ID}`,
      "not a link at all ::",
      "",
      null,
    ])
      expect(meetPath(href, ORIGIN), String(href)).toBeNull();
  });
});
