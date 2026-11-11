// The selection toolbar's enabled states: which buttons a folder shows, and what they are named.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar } from "./MailToolbar";
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
