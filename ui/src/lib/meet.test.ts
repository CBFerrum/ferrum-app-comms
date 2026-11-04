import { describe, expect, it } from "vitest";
import { mediaProblem, meetLink, meetPath, notSetUp, openCall, opensBeside, recordingWords, segmentId } from "./meet";

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

describe("calls on phones", () => {
  it("opens a call beside the page on a computer and over it on a phone", () => {
    expect([opensBeside({ coarse: false, width: 1280 }), opensBeside({ coarse: true, width: 1280 }), opensBeside({ coarse: false, width: 390 }), opensBeside({ coarse: true, width: 820 })]).toEqual([true, false, false, false]);
    const click = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const phone = click();
    openCall(phone, "/meet/room/1", { coarse: true, width: 390 });
    expect(phone.prevented).toBe(false); // the link goes where it points
    const keyed = { ...click(), ctrlKey: true };
    openCall(keyed, "/meet/room/1", { coarse: false, width: 1280 });
    expect(keyed.prevented).toBe(false);
  });

  it("says what keeps a camera and microphone from working", () => {
    expect(mediaProblem({ secure: true, devices: true })).toBeNull();
    expect(mediaProblem({ secure: false, devices: false })).toContain("secure connection");
    expect(mediaProblem({ secure: true, devices: false })).toContain("cannot use a camera");
  });

  it("tells a meeting server that is not there from one that failed", () => {
    expect(notSetUp("video meetings are not set up on this server")).toBe(true);
    expect(notSetUp("could not establish signal connection")).toBe(false);
  });
});

describe("what a call keeps", () => {
  it("names each caption segment by when it was heard, and its place", () => {
    expect(segmentId(1_700_000_000_000, 3)).toBe("loyw3v28-3");
    expect(segmentId(0, 0)).toMatch(/^[a-z0-9._-]+$/);
  });

  it("says where a recording stands", () => {
    expect(recordingWords({ status: "EGRESS_ACTIVE", ended_at: null, location: null, error: null })).toBe("Recording");
    expect(recordingWords({ status: "EGRESS_COMPLETE", ended_at: "x", location: "s3://m/1.mp4", error: null })).toBe("Saved at s3://m/1.mp4");
    expect(recordingWords({ status: "EGRESS_FAILED", ended_at: "x", location: null, error: "no space" })).toBe("Failed: no space");
  });
});
