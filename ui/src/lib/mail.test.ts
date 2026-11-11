import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  busyWith,
  conversationRows,
  dropDraft,
  expandedIds,
  frameDocument,
  hasContent,
  inFolder,
  keepDraft,
  keptDrafts,
  keyAction,
  messagesIn,
  parseAddresses,
  refusal,
  replyRecipients,
  sizeLabel,
  sortMailboxes,
  step,
  type EmailSummary,
  type Kept,
  type Mailbox,
} from "./mail";

const box = (id: string, role: string | null, sortOrder = 0, name = id): Mailbox => ({ id, name, role, sortOrder, totalEmails: 0, unreadEmails: 0 });

describe("mail", () => {
  it("orders folders the usual way, then the person's own by order and name", () => {
    const sorted = sortMailboxes([box("z", null, 1), box("t", "trash"), box("a", null, 1), box("i", "inbox"), box("s", "sent"), box("j", "junk"), box("d", "drafts")]);
    expect(sorted.map((m) => m.id)).toEqual(["i", "d", "s", "j", "t", "a", "z"]);
  });

  it("reads typed addresses and points out what is not one", () => {
    expect(parseAddresses(`Ann Lee <ann@acme.com>; bob@acme.com,\n"Carol, CFO" <carol@acme.com>, nope, x@y`)).toEqual({
      list: [{ name: "Ann Lee", email: "ann@acme.com" }, { email: "bob@acme.com" }, { name: "Carol, CFO", email: "carol@acme.com" }],
      bad: ["nope", "x@y"],
    });
  });

  it("answers the sender, or everyone but oneself", () => {
    const m = {
      from: [{ name: "Ann", email: "ann@acme.com" }],
      replyTo: null,
      to: [{ email: "me@acme.com" }, { email: "bob@acme.com" }],
      cc: [{ email: "ANN@acme.com" }, { email: "cat@acme.com" }],
    };
    expect(replyRecipients(m, "me@acme.com", false)).toEqual({ to: [{ name: "Ann", email: "ann@acme.com" }], cc: [] });
    expect(replyRecipients(m, "Me@Acme.com", true)).toEqual({ to: [{ name: "Ann", email: "ann@acme.com" }], cc: [{ email: "bob@acme.com" }, { email: "cat@acme.com" }] });
    expect(replyRecipients({ ...m, replyTo: [{ email: "list@acme.com" }] }, "me@acme.com", false).to).toEqual([{ email: "list@acme.com" }]);
    // Answering one's own sent mail goes to the people it went to.
    expect(replyRecipients({ ...m, from: [{ email: "me@acme.com" }] }, "me@acme.com", false).to).toEqual([{ email: "bob@acme.com" }]);
  });


  it("frames a message with no scripts and remote images only on request", () => {
    const doc = frameDocument("<p>Hi</p>", false);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data:;");
    expect(doc).not.toContain("script-src");
    expect(frameDocument("<p>Hi</p>", true)).toContain("img-src data: https: http:;");
    expect(sizeLabel(900)).toBe("900 B");
    expect(sizeLabel(12_800)).toBe("13 KB");
    expect(sizeLabel(3_500_000)).toBe("3.3 MB");
  });
});

describe("conversations", () => {
  const email = (id: string, threadId: string, seen = true): EmailSummary => ({ id, threadId, mailboxIds: { in: true }, keywords: seen ? { $seen: true } : {}, from: null, to: null, subject: id, receivedAt: "", preview: "", hasAttachment: false });

  it("counts a conversation and finds an unread message anywhere in it", () => {
    const rows = conversationRows(
      [email("a3", "t1"), email("b1", "t2", false), email("c1", "t3")],
      [{ id: "t1", emailIds: ["a1", "a2", "a3"] }, { id: "t2", emailIds: ["b1"] }],
      [
        { id: "a1", keywords: {}, mailboxIds: { in: true } },
        { id: "a2", keywords: { $seen: true }, mailboxIds: { sent: true } },
        { id: "a3", keywords: { $seen: true }, mailboxIds: { in: true } },
        { id: "b1", keywords: {}, mailboxIds: { in: true } },
      ],
      "in",
    );
    expect(rows.map((r) => [r.id, r.count, r.unread])).toEqual([["a3", 3, true], ["b1", 1, true], ["c1", 1, false]]);
    // An action on a line reaches the conversation's messages in the folder, not those in Sent.
    expect(rows.map((r) => r.folderIds)).toEqual([["a1", "a3"], ["b1"], ["c1"]]);
  });

  it("opens the newest message and the unread ones, the rest folded", () => {
    expect(expandedIds([{ id: "1", keywords: { $seen: true } }, { id: "2", keywords: {} }, { id: "3", keywords: { $seen: true } }, { id: "4", keywords: { $seen: true } }])).toEqual(["2", "4"]);
    expect(expandedIds([])).toEqual([]);
    expect(expandedIds([{ id: "1", keywords: null }])).toEqual(["1"]);
  });

  it("acts on the messages of a conversation that are in the folder it is seen from", () => {
    const m: Pick<EmailSummary, "id" | "mailboxIds">[] = [{ id: "1", mailboxIds: { in: true } }, { id: "2", mailboxIds: { sent: true } }, { id: "3", mailboxIds: { in: true, star: true } }];
    expect(inFolder(m, "in", "3")).toEqual(["1", "3"]);
    expect(inFolder(m, "gone", "3")).toEqual(["3"]);
    expect(inFolder(m, undefined, "2")).toEqual(["2"]);
    expect([messagesIn(1), messagesIn(4)]).toEqual(["1 message", "4 messages"]);
  });
});

describe("keyboard", () => {
  it("maps keys to what they ask for, leaving the browser's own shortcuts alone", () => {
    expect([keyAction({ key: "j" }), keyAction({ key: "U" }), keyAction({ key: "Escape" }), keyAction({ key: "q" })]).toEqual(["next", "unread", "back", null]);
    expect([keyAction({ key: "r", ctrlKey: true }), keyAction({ key: "r", metaKey: true }), keyAction({ key: "a", altKey: true })]).toEqual([null, null, null]);
    expect(SHORTCUTS.every((s) => s.keys.length > 0)).toBe(true);
    // Every shortcut listed is one a key reaches.
    expect(SHORTCUTS.map((s) => s.action).sort()).toEqual([...new Set(Object.values({ j: "next", k: "previous", o: "open", u: "back", r: "reply", a: "replyAll", f: "forward", e: "archive", "#": "delete", "!": "spam", U: "unread", I: "read", x: "select", v: "move", l: "label", z: "undo", s: "star", c: "compose", "/": "search", "?": "help" }))].sort());
  });

  it("stays out of the way of typing, menus and dialogs", () => {
    expect(busyWith({ tagName: "INPUT" }, "j")).toBe(true);
    expect(busyWith({ tagName: "textarea" }, "j")).toBe(true);
    expect(busyWith({ tagName: "DIV", isContentEditable: true }, "j")).toBe(true);
    expect(busyWith({ tagName: "BUTTON" }, "Enter")).toBe(true);
    expect(busyWith({ tagName: "BUTTON" }, "j")).toBe(false);
    expect(busyWith({ tagName: "DIV", closest: (s) => s.includes("dialog") }, "j")).toBe(true);
    expect(busyWith({ tagName: "BODY", closest: () => null }, "j")).toBe(false);
    expect(busyWith(null, "j")).toBe(false);
  });

  it("steps through the list and stops at its ends", () => {
    expect([step(0, 3, 1), step(2, 3, 1), step(0, 3, -1), step(5, 0, 1)]).toEqual([1, 2, 0, 0]);
  });
});

describe("writing", () => {
  it("knows whether anything is written", () => {
    const w = { to: [], cc: [], bcc: [], subject: " ", text: "\n", files: [] };
    expect(hasContent(w)).toBe(false);
    expect(hasContent({ ...w, text: "x" })).toBe(true);
    expect(hasContent({ ...w, files: [{ blobId: "b", name: "a", type: "t", size: 1 }] })).toBe(true);
  });

  it("tells why the mail server refused, in words", () => {
    expect(refusal({ type: "overQuota" })).toContain("mailbox is full");
    expect(refusal({ type: "forbiddenFrom" })).toContain("send as that address");
    expect(refusal({ type: "invalidProperties", properties: ["to", "subject"] })).toBe("The mail server did not accept the message (to, subject).");
    expect(refusal({ type: "somethingNew", description: "Quota exceeded for this hour" })).toBe("The mail server said: Quota exceeded for this hour");
    expect(refusal(undefined)).toBe("The mail server refused it.");
    expect(refusal({ type: "x" }, "Nothing was sent.")).toBe("Nothing was sent.");
  });

});

describe("drafts kept in the browser", () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      get length() {
        return m.size;
      },
      key: (i: number) => [...m.keys()][i] ?? null,
    };
  };
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const written = { to: [{ email: "ann@acme.com" }], cc: [], bcc: [], subject: "Hi", html: "<p>Words</p>", text: "Words", plain: false, quote: null, files: [], signature: true };
  const kept = (key: string, at: string, account = "a1"): Kept => ({ key, account, savedAt: at, written });

  it("keeps what is written per account, newest first, until it is dropped", () => {
    const st = store();
    keepDraft(kept("one", ago(3)), st);
    keepDraft(kept("two", ago(2)), st);
    keepDraft(kept("other", ago(1), "a2"), st);
    st.setItem("unrelated", "x");
    expect(keptDrafts("a1", st).map((k) => k.key)).toEqual(["two", "one"]);
    dropDraft("a1", "two", st);
    expect(keptDrafts("a1", st).map((k) => k.key)).toEqual(["one"]);
    expect(keptDrafts("a1", st)[0]!.written.text).toBe("Words");
  });

  it("lets go of copies older than two weeks, and reads a plain copy from before rich text", () => {
    const st = store();
    keepDraft(kept("old", ago(24 * 15)), st);
    st.setItem("ferrum.mail.draft.a1.legacy", JSON.stringify({ key: "legacy", account: "a1", savedAt: ago(1), to: "Ann <ann@acme.com>, bob@acme.com", cc: "", bcc: "", subject: "Hi", body: "Words", files: [] }));
    const got = keptDrafts("a1", st);
    expect(got.map((k) => k.key)).toEqual(["legacy"]);
    expect(got[0]!.written).toMatchObject({ to: [{ name: "Ann", email: "ann@acme.com" }, { email: "bob@acme.com" }], text: "Words", plain: true, html: "" });
    expect(st.getItem("ferrum.mail.draft.a1.old")).toBeNull();
  });

  it("carries on when the browser keeps nothing or holds something else", () => {
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); }, length: 1, key: () => { throw new Error("no"); } };
    expect(() => keepDraft(kept("x", "t"), broken)).not.toThrow();
    expect(() => dropDraft("a1", "x", broken)).not.toThrow();
    expect(keptDrafts("a1", broken)).toEqual([]);
    expect(keptDrafts("a1", null)).toEqual([]);
    const st = store();
    st.setItem("ferrum.mail.draft.a1.bad", "{not json");
    expect(keptDrafts("a1", st)).toEqual([]);
  });
});
