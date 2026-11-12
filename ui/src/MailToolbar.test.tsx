// The selection toolbar's enabled states: which buttons a folder shows, and what they are named.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar, selectionActions } from "./MailToolbar";
import type { Mailbox } from "./lib/mail";

const box = (id: string, name: string, role: string): Mailbox => ({ id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0 });
const BOXES = [box("a", "Inbox", "inbox"), box("h", "Archive", "archive"), box("c", "Junk Mail", "junk"), box("b", "Deleted Items", "trash")];

const labels = (role: string, o: { anyUnread?: boolean; allStarred?: boolean } = {}) =>
  [
    ...renderToString(
      <ActionBar role={role} boxes={BOXES} anyUnread={!!o.anyUnread} allStarred={!!o.allStarred} onVerb={() => {}} onMove={() => {}} onForever={() => {}} moveOpen={false} onMoveOpen={() => {}} />,
    ).matchAll(/aria-label="([^"]+)"/g),
  ].map((m) => m[1]!.replace(/&#x27;/g, "'"));

describe("the actions bar", () => {
  it("Inbox: archive, delete, report spam, mark unread, star, move", () => {
    expect(labels("inbox")).toEqual(["Archive", "Delete", "Report spam", "Mark as unread", "Star", "Move to"]);
  });
  it("offers mark as read when any selected is unread, and un-star when all are starred", () => {
    expect(labels("inbox", { anyUnread: true, allStarred: true })).toContain("Mark as read");
    expect(labels("inbox", { anyUnread: true, allStarred: true })).toContain("Remove the star");
  });
  it("Spam: not spam and delete forever, no archive, no report spam, still move", () => {
    const l = labels("junk");
    expect(l).toContain("Not spam: move to Inbox, and the filter learns");
    expect(l).toContain("Delete forever");
    expect(l).toContain("Move to");
    for (const gone of ["Archive", "Delete", "Report spam"]) expect(l).not.toContain(gone);
  });
  it("Trash: move to Inbox and delete forever, no plain delete", () => {
    const l = labels("trash");
    expect(l).toContain("Move to Inbox");
    expect(l).toContain("Delete forever");
    expect(l).not.toContain("Delete");
  });
  it("Archive has no archive button; Drafts has no move", () => {
    expect(labels("archive")).not.toContain("Archive");
    expect(labels("drafts")).not.toContain("Move to");
  });
});

describe("the selection's actions, as the kit's SelectionToolbar folds them", () => {
  const base = { boxes: BOXES, anyUnread: false, allStarred: false, onVerb: () => {}, onMove: () => {}, onForever: () => {}, moveOpen: false, onMoveOpen: () => {} };
  it("is one list in the bar's order, Archive and Delete kept last when it folds, each with its key in the title", () => {
    const a = selectionActions({ ...base, role: "inbox", onExport: () => {}, onSelectAll: () => {} });
    expect(a.map((x) => x.label)).toEqual(["Archive", "Delete", "Report spam", "Mark as unread", "Star", "Move to", "Export as .mbox", "Select all"]);
    expect(a.filter((x) => x.priority).map((x) => x.id)).toEqual(["archive", "trash"]);
    expect(a.find((x) => x.id === "trash")?.title).toBe("Delete (#)");
  });
  it("Spam offers Not spam and Delete forever (marked as dangerous), never Archive", () => {
    const a = selectionActions({ ...base, role: "junk" });
    expect(a.map((x) => x.id)).toEqual(["notSpam", "forever", "read", "star", "move"]);
    expect(a.find((x) => x.id === "forever")?.danger).toBe(true);
  });
  it("Move to opens its folder list after the menu that asked has closed", async () => {
    let opened = false;
    const move = selectionActions({ ...base, role: "inbox", onMoveOpen: (o) => void (opened = o) }).find((x) => x.id === "move")!;
    move.onSelect();
    expect(opened).toBe(false);
    await new Promise((r) => setTimeout(r));
    expect(opened).toBe(true);
  });
});
