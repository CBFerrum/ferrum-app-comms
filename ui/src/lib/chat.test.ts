import { describe, expect, it } from "vitest";
import {
  accessText,
  addable,
  attachmentsOf,
  badge,
  bodyTooLong,
  completeMention,
  continues,
  draftKey,
  fileSize,
  filterChannels,
  firstUnread,
  groupChannels,
  loudness,
  matchPeople,
  memberRows,
  mentionAt,
  mentionsIn,
  mentionsMe,
  posting,
  readDraft,
  showMentions,
  snippet,
  splitChannels,
  startsDay,
  timeline,
  unreadTotal,
  writeDraft,
  type ChannelSummary,
  type Message,
} from "./chat";

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

const chan = (id: string, extra: Partial<ChannelSummary> = {}): ChannelSummary => ({ id, name: id, title: id, type: "Public", role: "Member", unread: 0, ...extra });

describe("who hears of a channel", () => {
  it("reads the person's choice, else what the kind of conversation suggests", () => {
    expect(loudness({ type: "Direct" })).toBe("All");
    expect(loudness({ type: "Public" })).toBe("Mentions");
    expect(loudness({ type: "Direct", notify_level: "Nothing" })).toBe("Nothing");
    expect(loudness({ type: "Private", notify_level: "All" })).toBe("All");
  });

  it("counts a muted channel as nothing, though a mention still marks it", () => {
    expect(badge(chan("a", { unread: 4, unread_mentions: 1 }))).toEqual({ count: 4, mention: true });
    expect(badge(chan("a", { unread: 4, unread_mentions: 1, notify_level: "Nothing" }))).toEqual({ count: 0, mention: true });
    expect(badge(chan("a", { unread: 4, notify_level: "Nothing" }))).toEqual({ count: 0, mention: false });
    expect(unreadTotal([chan("a", { unread: 2 }), chan("b", { unread: 5, notify_level: "Nothing" }), chan("c", { unread: 3, role: null })])).toBe(2);
  });

  it("narrows the list by text, unread and mentions", () => {
    const list = [chan("sales", { unread: 2 }), chan("support", { unread_mentions: 1, unread: 1 }), chan("old", { notify_level: "Nothing", unread: 9 }), chan("quiet")];
    expect(filterChannels(list, "su", "all").map((c) => c.id)).toEqual(["support"]);
    expect(filterChannels(list, "", "unread").map((c) => c.id)).toEqual(["sales", "support"]);
    expect(filterChannels(list, "", "mentions").map((c) => c.id)).toEqual(["support"]);
    expect(filterChannels(list, " ", "all")).toHaveLength(4);
  });

  it("groups direct messages apart and lets muted ones sink", () => {
    const list = [chan("a", { notify_level: "Nothing" }), chan("b"), chan("dm1", { type: "Direct", notify_level: "Nothing" }), chan("dm2", { type: "Direct" }), chan("j", { role: null })];
    const g = groupChannels(list);
    expect([g.direct.map((c) => c.id), g.channels.map((c) => c.id), g.joinable.map((c) => c.id)]).toEqual([["dm2", "dm1"], ["b", "a"], ["j"]]);
  });
});

describe("who may post", () => {
  it("says why a person cannot, in words", () => {
    expect(posting({ archived: false, role: "Member", post_policy: "Members" })).toEqual({ state: "ok" });
    expect(posting({ archived: false, role: null, post_policy: "Members" })).toEqual({ state: "join" });
    expect(posting({ archived: true, role: "Owner", post_policy: "Members" }).state).toBe("archived");
    expect(posting({ archived: false, role: "Member", post_policy: "Owners" }).state).toBe("owners");
    expect(posting({ archived: false, role: "Member", post_policy: "Owners" }, true)).toEqual({ state: "ok" });
    expect(posting({ archived: false, role: "Owner", post_policy: "Owners" })).toEqual({ state: "ok" });
    // Someone who has not joined cannot reply either.
    expect(posting({ archived: false, role: null, post_policy: "Owners" }, true)).toEqual({ state: "join" });
  });

  it("describes who reads and who posts", () => {
    expect(accessText({ type: "Direct" })).toBe("Only the two of you can read this conversation.");
    expect(accessText({ type: "Public", post_policy: "Members" })).toBe("Anyone in the workspace can read it and join. Every member can post.");
    expect(accessText({ type: "Private", post_policy: "Owners" })).toBe("Only its members can read it. Only its owners start posts; members reply in threads.");
    expect(accessText({ type: "Public", archived: true })).toContain("nobody can post");
  });

  it("lists members owners first and offers only people who are not in yet", () => {
    const members = [{ email: "z@x.test", full_name: "Zed", role: "Member" }, { email: "b@x.test", full_name: "Bea", role: "Member" }, { email: "o@x.test", full_name: "Omar", role: "Owner" }];
    expect(memberRows(members, "").map((m) => m.email)).toEqual(["o@x.test", "b@x.test", "z@x.test"]);
    expect(memberRows(members, "BE").map((m) => m.email)).toEqual(["b@x.test"]);
    const people = [{ id: "1", email: "b@x.test", full_name: "Bea" }, { id: "2", email: "n@x.test", full_name: "Nia" }, { id: "3", email: "ned@x.test", full_name: "Ned" }];
    expect(addable(people, members, "n").map((p) => p.email)).toEqual(["ned@x.test", "n@x.test"]);
    expect(addable(people, members, "bea")).toEqual([]);
  });
});

describe("typing a mention", () => {
  const people = [
    { id: "1", email: "ana.rao@x.test", full_name: "Ana Rao" },
    { id: "2", email: "raj@x.test", full_name: "Raj Anand" },
    { id: "3", email: "me@x.test", full_name: "Me Myself" },
  ];

  it("finds the @name before the caret, only where a mention can start", () => {
    expect(mentionAt("hi @an", 6)).toEqual({ from: 3, query: "an" });
    expect(mentionAt("@", 1)).toEqual({ from: 0, query: "" });
    expect(mentionAt("hi @an and more", 6)).toEqual({ from: 3, query: "an" });
    expect(mentionAt("mail me@x.test", 14)).toBeNull();
    expect(mentionAt("hi @an and", 10)).toBeNull();
    expect(mentionAt("(@ana", 5)).toEqual({ from: 1, query: "ana" });
  });

  it("offers names starting with it first, never the person themselves", () => {
    expect(matchPeople(people, "an", "me@x.test").map((p) => p.id)).toEqual(["1", "2"]);
    expect(matchPeople(people, "", "ME@x.test").map((p) => p.id)).toEqual(["1", "2"]);
    expect(matchPeople(people, "zzz")).toEqual([]);
    expect(matchPeople(people, "x.test", undefined, 2)).toHaveLength(2);
  });

  it("turns the typed name into the mention and moves the caret past it", () => {
    expect(completeMention("hi @an and", 6, people[0]!)).toEqual({ text: "hi <@ana.rao@x.test>  and", caret: 21 });
    expect(completeMention("no mention", 3, people[0]!)).toEqual({ text: "no mention", caret: 3 });
  });
});

describe("reading a conversation", () => {
  const at = (n: number) => `2026-10-29T10:0${n}:00Z`;
  const list = [msg("m1", at(1), "a@x.test"), msg("m2", at(2), "me@x.test"), msg("m3", at(3), "a@x.test", { deleted: true }), msg("m4", at(4), "b@x.test")];

  it("finds the first message the person has not read", () => {
    expect(firstUnread(list, at(0), "me@x.test")?.id).toBe("m1");
    expect(firstUnread(list, at(1), "me@x.test")?.id).toBe("m4");
    expect(firstUnread(list, at(4), "me@x.test")).toBeUndefined();
    expect(firstUnread(list, null, "ME@x.test")?.id).toBe("m1");
  });

  it("knows a message that mentions the person", () => {
    expect(mentionsMe({ mentions: ["Me@x.test"] }, "me@x.test")).toBe(true);
    expect(mentionsMe({ mentions: ["me@x.test"], deleted: true }, "me@x.test")).toBe(false);
    expect(mentionsMe({}, "me@x.test")).toBe(false);
  });

  it("cuts a search result around the match", () => {
    expect(snippet("The Globex deal closes   on Friday", "globex", 10)).toEqual({ before: "The ", hit: "Globex", after: " deal clos…" });
    expect(snippet("a long text with no match here at all", "zzz", 5)).toEqual({ before: "", hit: "", after: "a long tex…" });
    expect(snippet("short", "", 70).after).toBe("short");
  });
});

describe("keeping unsent text", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it("keeps a draft per conversation and per thread, and forgets an empty one", () => {
    const st = store();
    expect([draftKey("c1"), draftKey("c1", "m9")]).toEqual(["ferrum.chat.draft.c1", "ferrum.chat.draft.c1.m9"]);
    writeDraft(draftKey("c1"), "half a thought", st);
    expect(readDraft(draftKey("c1"), st)).toBe("half a thought");
    expect(readDraft(draftKey("c1", "m9"), st)).toBe("");
    writeDraft(draftKey("c1"), "  ", st);
    expect(readDraft(draftKey("c1"), st)).toBe("");
  });

  it("carries on when the browser keeps nothing", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => writeDraft("k", "text", broken)).not.toThrow();
    expect(readDraft("k", broken)).toBe("");
    expect(readDraft("k", null)).toBe("");
  });
});
