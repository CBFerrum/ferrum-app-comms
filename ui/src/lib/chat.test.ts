import { describe, expect, it } from "vitest";
import { attachmentsOf, bodyTooLong, continues, fileSize, mentionsIn, showMentions, splitChannels, startsDay, timeline, type ChannelSummary, type Message } from "./chat";

const msg = (id: string, at: string, sender = "a@x.test", extra: Partial<Message> = {}): Message => ({ id, channel: "c", sender, body: id, posted_at: at, ...extra });

describe("chat", () => {
  it("reads a message's files and sizes them", () => {
    const files = [{ id: "f1", file_name: "plan.pdf", size: 2048 }, { id: 7 }, "x", null, { id: "f2", file_name: "a.png", content_type: "image/png" }];
    expect(attachmentsOf({ attachments: files }).map((a) => a.id)).toEqual(["f1", "f2"]);
    expect(attachmentsOf({ attachments: "nope" })).toEqual([]);
    expect([fileSize(840), fileSize(12_400), fileSize(3_565_158)]).toEqual(["840 B", "12 KB", "3.4 MB"]);
  });

  it("finds and shows mentions", () => {
    const body = "Hi <@Ana@x.test> and <@bo@x.test>, also <@ana@x.test>";
    expect(mentionsIn(body)).toEqual(["ana@x.test", "bo@x.test"]);
    expect(showMentions(body, [{ id: "1", email: "ana@x.test", full_name: "Ana Rao" }])).toBe("Hi @Ana Rao and @bo@x.test, also @Ana Rao");
    expect(bodyTooLong("é".repeat(2049))).toBe(true); // 4098 bytes
    expect(bodyTooLong("é".repeat(2048))).toBe(false);
  });

  it("merges pages into one ordered timeline", () => {
    const newest = [msg("m3", "2026-10-29T10:03:00Z"), msg("m2", "2026-10-29T10:02:00Z")];
    const older = [msg("m2", "2026-10-29T10:02:00Z"), msg("m1", "2026-10-28T09:00:00Z")];
    const t = timeline([newest, older]);
    expect(t.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect([startsDay(t[0]!, undefined), startsDay(t[1]!, t[0]), startsDay(t[2]!, t[1])]).toEqual([true, true, false]);
    expect(continues(t[2]!, t[1])).toBe(true);
    expect(continues(msg("m4", "2026-10-29T10:30:00Z"), t[2])).toBe(false);
    expect(continues(msg("m5", "2026-10-29T10:03:30Z", "b@x.test"), t[2])).toBe(false);
  });

  it("puts my channels before the ones I could join", () => {
    const c = (id: string, role: ChannelSummary["role"], archived = false): ChannelSummary => ({ id, name: id, title: id, type: "Public", role, unread: 0, archived });
    const { mine, joinable } = splitChannels([c("general", "Member"), c("random", null), c("old", null, true)]);
    expect([mine.map((x) => x.id), joinable.map((x) => x.id)]).toEqual([["general"], ["random"]]);
  });
});
