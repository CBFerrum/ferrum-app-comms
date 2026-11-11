// Wave 1 of Mail parity: the patches an action sends and the snapshot that undoes it, the folder list,
// what the reader says about a sender (on header strings copied from the live mail server), blocked
// senders as a Sieve script, an invitation's event, a line of the list.

import { describe, expect, it } from "vitest";
import { doneLine, offered, patchFor, rangeBetween, restoreUpdates, toolbarVerbs, updatesFor } from "./actions";
import { blockScript, parseBlocked } from "./blocklist";
import { ALL_MAIL, STARRED, customTree, folderCount, folderName, folderNameProblem, moveTargets, virtualFolder, withDescendants } from "./folders";
import { listDate, nameAndAddress, recipientsLine, senderLabel } from "./list";
import { conversationRows, limiter, type Mailbox } from "./mail";
import type { Snapshot } from "./actions";
import { alwaysShowImagesFrom, authResults, imageSenders, inviteWhen, isExternal, parseInvite, senderWarning, showsImagesFrom, spamReasons, unsubscribeTargets, workspaceDomains } from "./safety";

const box = (id: string, name: string, role: string | null, extra: Partial<Mailbox> = {}): Mailbox => ({ id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, ...extra });
// What a fresh Stalwart mailbox lists, plus the Archive the app makes.
const BOXES = [box("c", "Junk Mail", "junk"), box("a", "Inbox", "inbox"), box("h", "Archive", "archive"), box("d", "Drafts", "drafts"), box("e", "Sent Items", "sent"), box("b", "Deleted Items", "trash")];

describe("action patches", () => {
  it("files into the role's folder and trains the filter for spam", () => {
    expect(patchFor("archive", BOXES)).toEqual({ mailboxIds: { h: true } });
    expect(patchFor("trash", BOXES)).toEqual({ mailboxIds: { b: true } });
    expect(patchFor("spam", BOXES)).toEqual({ mailboxIds: { c: true }, "keywords/$junk": true, "keywords/$notjunk": null });
    expect(patchFor("notSpam", BOXES)).toEqual({ mailboxIds: { a: true }, "keywords/$junk": null, "keywords/$notjunk": true });
    expect(patchFor("phishing", BOXES)).toMatchObject({ mailboxIds: { c: true }, "keywords/$phishing": true, "keywords/$junk": true });
  });
  it("marks and stars by keyword", () => {
    expect(patchFor("read", BOXES)).toEqual({ "keywords/$seen": true });
    expect(patchFor("unread", BOXES)).toEqual({ "keywords/$seen": null });
    expect(patchFor("star", BOXES)).toEqual({ "keywords/$flagged": true });
    expect(patchFor("unstar", BOXES)).toEqual({ "keywords/$flagged": null });
  });
  it("has no patch for a folder the mailbox lacks", () => {
    expect(patchFor("archive", BOXES.filter((b) => b.role !== "archive"))).toBeNull();
    expect(patchFor("move", BOXES)).toBeNull();
  });
  it("moving out of Spam says not spam, into Spam says spam, to the bin says neither", () => {
    const custom = box("k", "Invoices", null);
    expect(patchFor("move", BOXES, custom, "inbox")).toEqual({ mailboxIds: { k: true } });
    expect(patchFor("move", BOXES, custom, "junk")).toEqual({ mailboxIds: { k: true }, "keywords/$junk": null, "keywords/$notjunk": true });
    expect(patchFor("move", BOXES, BOXES[5], "junk")).toEqual({ mailboxIds: { b: true } });
    expect(patchFor("move", BOXES, BOXES[0], "inbox")).toMatchObject({ "keywords/$junk": true });
  });
  it("sends the same patch for every message of a bulk action", () => {
    expect(updatesFor(["m1", "m2", "m3"], { mailboxIds: { h: true } })).toEqual({ m1: { mailboxIds: { h: true } }, m2: { mailboxIds: { h: true } }, m3: { mailboxIds: { h: true } } });
  });
});

describe("undo", () => {
  it("puts back each message's own folders and keywords, whole", () => {
    const before: Snapshot[] = [
      { id: "m1", mailboxIds: { a: true }, keywords: { $seen: true, $flagged: true } },
      { id: "m2", mailboxIds: { a: true, k: true }, keywords: null },
    ];
    expect(restoreUpdates(before)).toEqual({
      m1: { mailboxIds: { a: true }, keywords: { $seen: true, $flagged: true } },
      m2: { mailboxIds: { a: true, k: true }, keywords: {} },
    });
  });
});

describe("selection", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("takes the range between the anchor and the click, either way round", () => {
    expect(rangeBetween(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ids, null, "c")).toEqual(["c"]);
    expect(rangeBetween(ids, "zz", "c")).toEqual(["c"]);
    expect(rangeBetween(ids, "a", "zz")).toEqual([]);
  });
});

describe("what a folder offers", () => {
  it("Inbox: archive, delete, spam, move; not restore", () => {
    expect(offered("inbox")).toMatchObject({ archive: true, trash: true, spam: true, notSpam: false, restore: false, deleteForever: false, move: true, empty: false });
  });
  it("Spam: not spam, restore, delete forever, empty; no archive, no report spam", () => {
    expect(offered("junk")).toMatchObject({ archive: false, trash: false, spam: false, notSpam: true, restore: true, deleteForever: true, empty: true });
  });
  it("Trash: restore and delete forever, empty; report spam still possible", () => {
    expect(offered("trash")).toMatchObject({ archive: true, trash: false, spam: true, notSpam: false, restore: true, deleteForever: true, empty: true });
  });
  it("Archive offers no archive; Drafts neither archive nor move; Sent no spam", () => {
    expect(offered("archive").archive).toBe(false);
    expect(offered("drafts")).toMatchObject({ archive: false, move: false });
    expect(offered("sent").spam).toBe(false);
  });
  it("the toolbar's verbs follow, with mark read or unread and star or unstar by the selection", () => {
    expect(toolbarVerbs("inbox", true, false)).toEqual(["archive", "trash", "spam", "read", "star"]);
    expect(toolbarVerbs("junk", false, true)).toEqual(["notSpam", "unread", "unstar"]);
  });
});

describe("the sentence that says it was done", () => {
  it("counts conversations and names the folder", () => {
    expect(doneLine("trash", 3)).toBe("3 conversations moved to Trash");
    expect(doneLine("archive", 1)).toBe("1 conversation archived");
    expect(doneLine("move", 2, "Invoices")).toBe("2 conversations moved to Invoices");
  });
});

describe("folders", () => {
  it("names system folders by role in Gmail's words and keeps the person's own names", () => {
    expect(BOXES.map(folderName)).toEqual(["Spam", "Inbox", "Archive", "Drafts", "Sent", "Trash"]);
    expect(folderName(box("k", "Invoices", null))).toBe("Invoices");
  });
  const mine = [box("p", "Projects", null), box("p1", "Alpha", null, { parentId: "p" }), box("p2", "Beta", null, { parentId: "p" }), box("z", "Zeta", null), box("o", "Orphan", null, { parentId: "gone" })];
  it("nests the person's folders under their parents, each level by name", () => {
    expect(customTree([...BOXES, ...mine]).map((r) => `${r.depth}${r.box.name}`)).toEqual(["0Orphan", "0Projects", "1Alpha", "1Beta", "0Zeta"]);
  });
  it("lists the move targets without Drafts, system folders first", () => {
    expect(moveTargets([...BOXES, ...mine]).map((r) => r.box.name)).toEqual(["Inbox", "Sent Items", "Archive", "Junk Mail", "Deleted Items", "Orphan", "Projects", "Alpha", "Beta", "Zeta"]);
  });
  it("finds a folder and what is below it", () => {
    expect(withDescendants([...BOXES, ...mine], "p").map((b) => b.id)).toEqual(["p", "p1", "p2"]);
  });
  it("counts: unread for Inbox and own folders, the total for Drafts, quiet unread for Spam, nothing for the rest", () => {
    expect(folderCount(box("a", "Inbox", "inbox", { unreadEmails: 12 }))).toEqual({ n: 12, quiet: false });
    expect(folderCount(box("k", "X", null, { unreadEmails: 2 }))).toEqual({ n: 2, quiet: false });
    expect(folderCount(box("d", "Drafts", "drafts", { totalEmails: 2, unreadEmails: 0 }))).toEqual({ n: 2, quiet: true });
    expect(folderCount(box("c", "Junk", "junk", { unreadEmails: 3 }))).toEqual({ n: 3, quiet: true });
    expect(folderCount(box("b", "Trash", "trash", { unreadEmails: 3 }))).toBeNull();
    expect(folderCount(box("e", "Sent", "sent", { unreadEmails: 3 }))).toBeNull();
  });
  it("refuses a name that is empty, has a slash, or is taken beside it", () => {
    expect(folderNameProblem("  ", mine, null)).toMatch(/name/);
    expect(folderNameProblem("a/b", mine, null)).toMatch(/slash/);
    expect(folderNameProblem("projects", mine, null)).toMatch(/already/);
    expect(folderNameProblem("Alpha", mine, null)).toBeNull();
    expect(folderNameProblem("Alpha", mine, "p")).toMatch(/already/);
    expect(folderNameProblem("Projects", mine, null, "p")).toBeNull();
  });
  it("Starred and All mail are folders that are searches", () => {
    expect(virtualFolder(STARRED)?.role).toBe("starred");
    expect(virtualFolder(ALL_MAIL)?.role).toBe("all");
    expect(virtualFolder("a")).toBeUndefined();
  });
  it("a search's rows reach the whole conversation, a folder's only its messages there", () => {
    const e = { id: "m2", threadId: "t", mailboxIds: { a: true }, keywords: {}, from: null, to: null, subject: "", receivedAt: "", preview: "", hasAttachment: false };
    const threads = [{ id: "t", emailIds: ["m1", "m2"] }];
    const flags: { id: string; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean> }[] = [{ id: "m1", keywords: {}, mailboxIds: { b: true } }, { id: "m2", keywords: {}, mailboxIds: { a: true } }];
    expect(conversationRows([e], threads, flags, "a")[0]!.folderIds).toEqual(["m2"]);
    expect(conversationRows([e], threads, flags, STARRED, true)[0]!.folderIds).toEqual(["m1", "m2"]);
  });
});

// Strings as the live mail server wrote them (the Inbox's hand-made phishing copy; the SMTP-delivered phishing mail in Spam).
const HAND_MADE = "mx.demo.test; spf=fail smtp.mailfrom=mailer.phish-host.example; dkim=none; dmarc=fail header.from=demo.test";
const FROM_SERVER =
  "mail.mail-host.test; spf=none (mail.mail-host.test: no SPF records found for postmaster@mx.external.example) smtp.helo=mx.external.example; spf=none (mail.mail-host.test: no SPF records found for bounce@mailer.phish-host.example) smtp.mailfrom=bounce@mailer.phish-host.example; iprev=permerror (dns record not found) policy.iprev=172.17.0.1; dmarc=none header.from=demo.test policy.dmarc=none";
const OUTSIDE = FROM_SERVER.replace("header.from=demo.test", "header.from=bluepeakholdings.example");
const SPAM_RESULT =
  "ARC_NA (0.00), DKIM2_NA (0.00), DKIM_NA (0.00), DNSWL_BLOCKED (0.00), HTML_SHORT_1 (0.00), RBL_SENDERSCORE_REPUT_BLOCKED (0.00), RBL_SPAMHAUS_BLOCKED_OPENRESOLVER (0.00), RCPT_COUNT_ONE (0.00), SPF_NA (0.00), TO_DN_ALL (0.00), TO_DOM_EQ_FROM_DOM (0.00), TO_MATCH_ENVRCPT_ALL (0.00), RCVD_COUNT_ZERO (0.10), RCVD_NO_TLS_LAST (0.10), AUTH_NA (1.00), DMARC_NA (1.00), MID_RHS_MATCH_FROM (1.00), MID_RHS_MATCH_TO (1.00), PARTS_DIFFER (1.00), ENV_FROM_INVALID (2.00), FROM_INVALID (2.00), HELO_NOT_FQDN (2.00), RDNS_NONE (2.00)";
const DOMAINS = workspaceDomains("admin@demo.test", ["admin@demo.test", "sales@demo.test"]);

describe("the sender's checks", () => {
  it("reads every SPF, DKIM and DMARC result", () => {
    expect(authResults(HAND_MADE)).toEqual({ spf: ["fail"], dkim: ["none"], dmarc: ["fail"] });
    expect(authResults(FROM_SERVER)).toEqual({ spf: ["none", "none"], dmarc: ["none"] });
  });
  it("the workspace's domains come from the addresses", () => {
    expect(DOMAINS).toEqual(["demo.test"]);
    expect(isExternal({ email: "a@bluepeakholdings.example" }, DOMAINS)).toBe(true);
    expect(isExternal({ email: "Priya.Nair@Demo.test" }, DOMAINS)).toBe(false);
    expect(isExternal({ email: "a@x.example" }, [])).toBe(false);
  });
  it("warns, naming the failed checks, when SPF and DMARC failed", () => {
    const w = senderWarning({ email: "payroll@demo.test" }, HAND_MADE, DOMAINS);
    expect(w?.kind).toBe("failed");
    expect(w?.text).toContain("SPF, DMARC");
  });
  it("warns that mail claiming the workspace's domain could not be verified", () => {
    const w = senderWarning({ email: "it-support@demo.test" }, FROM_SERVER, DOMAINS);
    expect(w).toEqual({ kind: "unverified", text: "This message could not be verified as coming from demo.test. Be careful with links and attachments." });
  });
  it("does not warn about outside mail that simply has no records, nor about mail the server did not receive", () => {
    expect(senderWarning({ email: "sunita@bluepeakholdings.example" }, OUTSIDE, DOMAINS)).toBeNull();
    expect(senderWarning({ email: "priya.nair@demo.test" }, null, DOMAINS)).toBeNull();
    expect(senderWarning({ email: "priya.nair@demo.test" }, "  ", DOMAINS)).toBeNull();
  });
  it("trusts the workspace's domain when DKIM or SPF passed", () => {
    expect(senderWarning({ email: "a@demo.test" }, "mx; spf=pass smtp.mailfrom=demo.test; dmarc=pass header.from=demo.test", DOMAINS)).toBeNull();
    expect(senderWarning({ email: "a@demo.test" }, "mx; dkim=pass header.d=demo.test; spf=none", DOMAINS)).toBeNull();
  });
  it("a fail that another signature passed is not a failure", () => {
    expect(senderWarning({ email: "a@x.example" }, "mx; dkim=fail header.d=other; dkim=pass header.d=x.example", DOMAINS)).toBeNull();
  });
});

describe("why a message is in Spam", () => {
  it("gives the score and the heaviest reasons from what the server wrote", () => {
    const why = spamReasons("Yes", SPAM_RESULT)!;
    expect(why.score).toBe(13.2);
    expect(why.reasons).toEqual(["the envelope sender is not valid", "the From address is not valid", "the sending server introduced itself with an invalid name"]);
  });
  it("says nothing for mail the server did not call spam, or without its verdict", () => {
    expect(spamReasons("No", SPAM_RESULT)).toBeNull();
    expect(spamReasons(null, SPAM_RESULT)).toBeNull();
    expect(spamReasons("Yes", null)).toEqual({ score: 0, reasons: [] });
  });
});

describe("unsubscribe", () => {
  it("takes the https link and the mailto of List-Unsubscribe", () => {
    expect(unsubscribeTargets(["https://www.gadgetgazette.example/unsubscribe?u=7f3a", "mailto:unsubscribe@gadgetgazette.example?subject=unsubscribe"])).toEqual({
      web: "https://www.gadgetgazette.example/unsubscribe?u=7f3a",
      mail: { to: "unsubscribe@gadgetgazette.example", subject: "unsubscribe" },
    });
  });
  it("never offers a link that is not http(s) or mailto", () => {
    expect(unsubscribeTargets(["javascript:alert(1)", "data:text/html,x", "ftp://x"])).toBeNull();
    expect(unsubscribeTargets(null)).toBeNull();
  });
});

describe("images", () => {
  it("remembers the senders whose images are always shown, per mailbox", () => {
    const mem = new Map<string, string>();
    const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } as unknown as Storage;
    expect(showsImagesFrom("c", "News@X.example", s)).toBe(false);
    alwaysShowImagesFrom("c", "News@X.example", s);
    alwaysShowImagesFrom("c", "news@x.example", s);
    expect(imageSenders("c", s)).toEqual(["news@x.example"]);
    expect(showsImagesFrom("c", "news@x.example", s)).toBe(true);
    expect(showsImagesFrom("d", "news@x.example", s)).toBe(false);
  });
  it("survives storage that throws", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } as unknown as Storage;
    expect(imageSenders("c", bad)).toEqual([]);
    expect(() => alwaysShowImagesFrom("c", "a@b.example", bad)).not.toThrow();
  });
});

describe("blocked senders as a Sieve script", () => {
  it("lists each address in a comment and files them all into Spam", () => {
    const s = blockScript(["A@x.example", "b@y.example", "a@x.example"], "Junk Mail");
    expect(s).toContain('require ["fileinto"];');
    expect(s).toContain('if address :is "from" ["a@x.example", "b@y.example"] { fileinto "Junk Mail"; stop; }');
    expect(parseBlocked(s)).toEqual(["a@x.example", "b@y.example"]);
  });
  it("an empty list is a script that does nothing", () => {
    const s = blockScript([], "Junk Mail");
    expect(s).not.toContain("if ");
    expect(parseBlocked(s)).toEqual([]);
  });
  it("quotes what could break out of the string", () => {
    expect(blockScript(['a"b@x.example'], 'Junk "Mail"')).toContain('"a\\"b@x.example"');
    expect(blockScript(['a"b@x.example'], 'Junk "Mail"')).toContain('fileinto "Junk \\"Mail\\""');
  });
});

describe("an invitation", () => {
  // The seeded invitation, as the mail server has it.
  const ICS = "BEGIN:VCALENDAR\r\nPRODID:-//Ferrum//Comms//EN\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:design-review-2026-11-13@demo.test\r\nDTSTART:20261113T053000Z\r\nDTEND:20261113T063000Z\r\nSUMMARY:Design review\r\nLOCATION:Banyan room\r\nORGANIZER;CN=Priya Nair:mailto:priya.nair@demo.test\r\nATTENDEE;CN=Administrator;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:admin@demo.test\r\nDESCRIPTION:Review the new mail screens\\, before the offsite.\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  it("reads title, moment, place and organiser", () => {
    const i = parseInvite(ICS)!;
    expect(i).toMatchObject({ method: "REQUEST", title: "Design review", where: "Banyan room", allDay: false, organizer: { name: "Priya Nair", email: "priya.nair@demo.test" } });
    expect(i.start?.toISOString()).toBe("2026-11-13T05:30:00.000Z");
    expect(i.end?.toISOString()).toBe("2026-11-13T06:30:00.000Z");
  });
  it("puts a time in a named zone at its true moment", () => {
    const i = parseInvite("BEGIN:VEVENT\nDTSTART;TZID=Asia/Kolkata:20261113T110000\nSUMMARY:x\nEND:VEVENT")!;
    expect(i.start?.toISOString()).toBe("2026-11-13T05:30:00.000Z");
  });
  it("reads an all-day event as a day", () => {
    const i = parseInvite("BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261113\nSUMMARY:Holiday\nEND:VEVENT")!;
    expect(i.allDay).toBe(true);
    expect(inviteWhen(i)).toMatch(/13/);
  });
  it("unfolds long lines and unescapes text", () => {
    expect(parseInvite("BEGIN:VEVENT\nSUMMARY:Review the\n  design\\, finally\nEND:VEVENT")!.title).toBe("Review the design, finally");
  });
  it("is nothing for text that is not an event", () => {
    expect(parseInvite("hello")).toBeNull();
    expect(parseInvite(null)).toBeNull();
  });
});

describe("a line of the list", () => {
  const NOW = Date.parse("2026-11-11T12:00:00Z");
  it("shows the sender's name, never the address when there is a name, and 'me' for the person", () => {
    expect(senderLabel([{ name: "Priya Nair", email: "priya.nair@demo.test" }], null, "admin@demo.test", false)).toBe("Priya Nair");
    expect(senderLabel([{ email: "ann@customer.example" }], null, "admin@demo.test", false)).toBe("ann@customer.example");
    expect(senderLabel([{ name: "Administrator", email: "admin@demo.test" }], null, "admin@demo.test", false)).toBe("me");
    expect(senderLabel(null, null, "admin@demo.test", false)).toBe("(unknown sender)");
  });
  it("shows recipients in Sent and Drafts", () => {
    expect(senderLabel(null, [{ name: "Omar Haddad", email: "o@demo.test" }, { email: "x@y.example" }], "admin@demo.test", true)).toBe("To: Omar Haddad, x@y.example");
    expect(senderLabel(null, [], "admin@demo.test", true)).toBe("(no recipients)");
  });
  it("dates: the time today, the weekday this week, day and month this year, the year before", () => {
    expect(listDate("2026-11-11T09:05:00Z", NOW)).toMatch(/^\d{1,2}:\d{2}/);
    expect(listDate("2026-11-09T09:05:00Z", NOW)).toMatch(/^Mon/);
    expect(listDate("2026-10-02T09:05:00Z", NOW)).toMatch(/^(2 Oct|Oct 2)$/);
    expect(listDate("2025-10-02T09:05:00Z", NOW)).toMatch(/2025/);
    expect(listDate("2026-11-04T09:05:00Z", NOW)).toMatch(/^(4 Nov|Nov 4)$/);
  });
  it("the reader's line: to me, then names, then how many more", () => {
    expect(recipientsLine([{ email: "admin@demo.test" }], null, "admin@demo.test")).toBe("to me");
    expect(recipientsLine([{ email: "admin@demo.test" }, { name: "Omar Haddad", email: "o@demo.test" }], [{ name: "Priya Nair", email: "p@demo.test" }], "admin@demo.test")).toBe("to me, Omar Haddad, +1");
    expect(recipientsLine([{ name: "A", email: "a@x.example" }, { name: "B", email: "b@x.example" }, { name: "C", email: "c@x.example" }], null, "admin@demo.test")).toBe("to A, B, +1");
  });
  it("Name <address> in full", () => {
    expect(nameAndAddress({ name: "Priya Nair", email: "p@demo.test" })).toBe("Priya Nair <p@demo.test>");
    expect(nameAndAddress({ email: "p@demo.test" })).toBe("p@demo.test");
  });
});

describe("asking the mail server in turn", () => {
  it("never runs more than its limit at once, and runs them all", async () => {
    const turn = limiter(3);
    let now = 0;
    let most = 0;
    const done = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        turn(async () => {
          most = Math.max(most, ++now);
          await new Promise((r) => setTimeout(r, 5));
          now--;
          return i;
        }),
      ),
    );
    expect(most).toBe(3);
    expect(done).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
  it("asks again after the server's concurrency refusal, and gives up on any other error at once", async () => {
    const turn = limiter(1);
    let tries = 0;
    expect(await turn(async () => (++tries < 3 ? Promise.reject(new Error('limit "maxConcurrentRequests"')) : "ok"))).toBe("ok");
    expect(tries).toBe(3);
    let other = 0;
    await expect(turn(async () => (++other, Promise.reject(new Error("forbidden"))))).rejects.toThrow("forbidden");
    expect(other).toBe(1);
    // and the slot is free again after a failure
    expect(await turn(async () => 1)).toBe(1);
  });
});
