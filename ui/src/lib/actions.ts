// What an action on mail is, as data: the JMAP patch it sends, the snapshot that undoes it exactly,
// the sentence that says it was done, and which actions a folder offers. Every action in Mail (a
// key, a row's button, the selection toolbar, the open conversation) goes through these.

import { t as tr } from "@ferrum/client";
import { byRole, type Mailbox } from "./mail";

export type Verb = "archive" | "trash" | "spam" | "notSpam" | "move" | "read" | "unread" | "star" | "unstar" | "phishing";

type Patch = Record<string, unknown>;

/** What was true of a message before an action: its folders and keywords, which undo puts back whole. */
export interface Snapshot {
  id: string;
  mailboxIds: Record<string, boolean> | null;
  keywords: Record<string, boolean> | null;
}

/** The patch for an action; null when the mailbox has no folder for it. `from` is the role of the folder it is done from. */
export function patchFor(verb: Verb, boxes: Mailbox[], to?: Mailbox, from?: string | null): Patch | null {
  const into = (b: Mailbox | undefined) => (b ? { mailboxIds: { [b.id]: true } } : null);
  const flags = (p: Patch | null, k: Record<string, boolean | null>) => p && { ...p, ...Object.fromEntries(Object.entries(k).map(([n, v]) => [`keywords/${n}`, v])) };
  switch (verb) {
    case "archive":
      return into(byRole(boxes, "archive"));
    case "trash":
      return into(byRole(boxes, "trash"));
    case "spam":
      return flags(into(byRole(boxes, "junk")), { $junk: true, $notjunk: null });
    case "phishing":
      return flags(into(byRole(boxes, "junk")), { $junk: true, $notjunk: null, $phishing: true });
    case "notSpam":
      return flags(into(byRole(boxes, "inbox")), { $junk: null, $notjunk: true });
    case "move":
      if (!to) return null;
      // Into Spam it is spam, and out of Spam (not to the bin) it is not.
      if (to.role === "junk") return flags(into(to), { $junk: true, $notjunk: null });
      return from === "junk" && to.role !== "trash" ? flags(into(to), { $junk: null, $notjunk: true }) : into(to);
    case "read":
      return { "keywords/$seen": true };
    case "unread":
      return { "keywords/$seen": null };
    case "star":
      return { "keywords/$flagged": true };
    case "unstar":
      return { "keywords/$flagged": null };
  }
}

export const updatesFor = (ids: string[], patch: Patch): Record<string, Patch> => Object.fromEntries(ids.map((i) => [i, patch]));

/** The updates that put every message back as the snapshots say. */
export const restoreUpdates = (snaps: Snapshot[]): Record<string, Patch> =>
  Object.fromEntries(snaps.map((s) => [s.id, { mailboxIds: s.mailboxIds ?? {}, keywords: s.keywords ?? {} }]));

/** The ids between two positions of the list, both included (Shift+click). */
export function rangeBetween(ids: string[], a: string | null, b: string): string[] {
  const x = a ? ids.indexOf(a) : -1;
  const y = ids.indexOf(b);
  if (y < 0) return [];
  if (x < 0) return [b];
  return ids.slice(Math.min(x, y), Math.max(x, y) + 1);
}

/** "Conversation" or "3 conversations". */
export const conversations = (n: number) => (n === 1 ? tr("1 conversation") : tr("{n} conversations", { n }));

/** The sentence that says an action was done (and is announced). `where` is the folder's name for a move. */
export function doneLine(verb: Verb, n: number, where = ""): string {
  const c = conversations(n);
  switch (verb) {
    case "archive":
      return tr("{value} archived", { value: c });
    case "trash":
      return tr("{value} moved to Trash", { value: c });
    case "spam":
      return tr("{value} reported as spam", { value: c });
    case "phishing":
      return tr("{value} reported as phishing", { value: c });
    case "notSpam":
      return tr("{value} moved to the inbox", { value: c });
    case "move":
      return tr("{value} moved to {where}", { value: c, where });
    case "read":
      return tr("{value} marked as read", { value: c });
    case "unread":
      return tr("{value} marked as unread", { value: c });
    case "star":
      return tr("{value} starred", { value: c });
    case "unstar":
      return tr("Star removed from {value}", { value: c });
  }
}

/** Which actions a folder offers (by its role; the virtual folders are `starred` and `all`). */
export interface Offered {
  archive: boolean;
  trash: boolean;
  spam: boolean;
  notSpam: boolean;
  restore: boolean;
  deleteForever: boolean;
  move: boolean;
  empty: boolean;
}

export function offered(role: string | null | undefined): Offered {
  const out = role === "trash" || role === "junk";
  return {
    archive: role !== "archive" && role !== "junk" && role !== "drafts",
    trash: !out,
    spam: role !== "junk" && role !== "sent" && role !== "drafts",
    notSpam: role === "junk",
    restore: out,
    deleteForever: out,
    move: role !== "drafts",
    empty: out,
  };
}

/** The verbs the selection toolbar offers in a folder, given whether any selected conversation is unread and whether all are starred. */
export const toolbarVerbs = (role: string | null | undefined, anyUnread: boolean, allStarred: boolean): Verb[] => {
  const o = offered(role);
  return [
    ...(o.archive ? (["archive"] as const) : []),
    ...(o.trash ? (["trash"] as const) : []),
    ...(o.spam ? (["spam"] as const) : []),
    ...(o.notSpam ? (["notSpam"] as const) : []),
    anyUnread ? ("read" as const) : ("unread" as const),
    allStarred ? ("unstar" as const) : ("star" as const),
  ];
};
