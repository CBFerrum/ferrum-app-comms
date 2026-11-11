import { describe, expect, it } from "vitest";
import { mboxEntry, splitMbox } from "./mbox";

describe("mbox", () => {
  it("round-trips messages, quoting From lines in bodies", () => {
    const a = "From: a@x.example\r\nSubject: one\r\n\r\nFrom the start\r\n>From quoted\r\n";
    const b = "From: b@y.example\r\nSubject: two\r\n\r\nhi\r\n";
    const file = mboxEntry(a, "a@x.example", new Date("2026-11-12T10:00:00Z")) + mboxEntry(b, "b@y.example", new Date("2026-11-12T10:00:00Z"));
    expect(file.startsWith("From a@x.example Thu Nov 12 10:00:00 2026\n")).toBe(true);
    expect(file).toContain("\n>From the start\n>>From quoted\n");
    expect(splitMbox(file)).toEqual([a, b]);
  });
  it("one .eml is one message; nothing is nothing", () => {
    expect(splitMbox("Subject: x\n\nbody\n")).toEqual(["Subject: x\r\n\r\nbody\r\n"]);
    expect(splitMbox("  ")).toEqual([]);
  });
});
