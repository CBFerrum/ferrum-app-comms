// The folder list: system folders named by role in the person's words (not the server's "Sent Items",
// "Junk Mail", "Deleted Items"), the person's own folders nested under their parents, and the two
// virtual folders that are queries (Starred, All mail).

import { t as tr } from "@ferrum/client";
import { sortMailboxes, type Mailbox } from "./mail";

/** Ids of the folders that are searches, not mailboxes: `/mail/~starred`. */
export const STARRED = "~starred";
export const ALL_MAIL = "~all";
/** Messages held on the mail server until a chosen time (Schedule send): pending submissions, not a mailbox. */
export const SCHEDULED = "~scheduled";
/** The largest conversations first, to free space. */
export const LARGEST = "~largest";
/** A saved search: `~saved:<id>`. */
export const SAVED = "~saved:";
/** The folder snoozed mail waits in (made on first use; one of the person's own to the mail server). */
export const SNOOZED_NAME = "Snoozed";

const ROLE_NAMES: Record<string, () => string> = {
  inbox: () => tr("Inbox"),
  drafts: () => tr("Drafts"),
  sent: () => tr("Sent"),
  archive: () => tr("Archive"),
  junk: () => tr("Spam"),
  trash: () => tr("Trash"),
};

/** Folders every mailbox has, in the order they are listed. */
export const SYSTEM_ROLES = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

/** What the person sees: a system folder by its role, their own folder by its own name. */
export const folderName = (b: Pick<Mailbox, "name" | "role"> & { parentId?: string | null }) => (b.role && ROLE_NAMES[b.role] ? ROLE_NAMES[b.role]!() : isSnoozed(b) ? tr("Snoozed") : b.name);

export const isVirtual = (id: string | undefined) => id === STARRED || id === ALL_MAIL || id === SCHEDULED || id === LARGEST || !!id?.startsWith(SAVED);

/** A folder that is a query, shaped like a mailbox so the list and its actions treat it alike. */
export function virtualFolder(id: string): Mailbox | undefined {
  if (id === STARRED) return { id, name: tr("Starred"), role: "starred", sortOrder: 0, totalEmails: 0, unreadEmails: 0 };
  if (id === ALL_MAIL) return { id, name: tr("All mail"), role: "all", sortOrder: 0, totalEmails: 0, unreadEmails: 0 };
  if (id === SCHEDULED) return { id, name: tr("Scheduled"), role: "scheduled", sortOrder: 0, totalEmails: 0, unreadEmails: 0 };
  if (id === LARGEST) return { id, name: tr("Largest conversations"), role: "largest", sortOrder: 0, totalEmails: 0, unreadEmails: 0 };
  if (id.startsWith(SAVED)) return { id, name: tr("Search"), role: "saved", sortOrder: 0, totalEmails: 0, unreadEmails: 0 };
  return undefined;
}

/** How long the mail server keeps mail in Trash and Spam before it removes it (its default: `DataRetention.expungeTrashAfter`, 30 days). */
export const PURGE_DAYS = 30;

export interface FolderRow {
  box: Mailbox;
  depth: number;
}

/** The person's own folders, parents before children, each level by name. */
export const isSnoozed = (b: Pick<Mailbox, "name" | "role" | "parentId">) => !b.role && !b.parentId && b.name === SNOOZED_NAME;

export function customTree(list: Mailbox[]): FolderRow[] {
  const mine = list.filter((b) => !b.role && !isSnoozed(b));
  const ids = new Set(mine.map((b) => b.id));
  const byName = (a: Mailbox, b: Mailbox) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const out: FolderRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const b of mine.filter((m) => (m.parentId && ids.has(m.parentId) ? m.parentId : null) === parent).sort(byName)) {
      out.push({ box: b, depth });
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The system folders, in the order they are listed. */
export const systemFolders = (list: Mailbox[]) => sortMailboxes(list).filter((b) => b.role && SYSTEM_ROLES.includes(b.role));

/** Every folder as a flat list for a "Move to" menu: system folders, then the person's own, nested ones indented by `depth`. */
export function moveTargets(list: Mailbox[]): FolderRow[] {
  return [...systemFolders(list).filter((b) => b.role !== "drafts").map((box) => ({ box, depth: 0 })), ...customTree(list)];
}

/** A folder and everything below it. */
export function withDescendants(list: Mailbox[], id: string): Mailbox[] {
  const out: Mailbox[] = [];
  const walk = (parent: string) => {
    for (const b of list.filter((m) => m.parentId === parent)) {
      out.push(b);
      walk(b.id);
    }
  };
  const self = list.find((b) => b.id === id);
  if (self) out.push(self);
  walk(id);
  return out;
}

/** The count a folder shows, and how: unread for Inbox and the person's folders, the total for Drafts, a quiet unread count for Spam. */
export function folderCount(b: Mailbox): { n: number; quiet: boolean } | null {
  if (b.role === "drafts") return b.totalEmails > 0 ? { n: b.totalEmails, quiet: true } : null;
  if (b.role === "junk") return b.unreadEmails > 0 ? { n: b.unreadEmails, quiet: true } : null;
  if (b.role === null || b.role === "inbox") return b.unreadEmails > 0 ? { n: b.unreadEmails, quiet: false } : null;
  return null;
}

/** The line under "Empty Trash" / "Empty Spam". */
export const purgeLine = (days = PURGE_DAYS) => tr("The mail server removes what is here for good after {days} days.", { days });

/** A name for a new or renamed folder: trimmed, one line, not already used beside it; the reason it is refused, or null. */
export function folderNameProblem(name: string, list: Mailbox[], parentId: string | null, own?: string): string | null {
  const n = name.trim();
  if (!n) return tr("Give the folder a name.");
  if (n.length > 200 || /[\r\n/]/.test(n)) return tr("A folder's name is one line without slashes.");
  const same = list.some((b) => b.id !== own && (b.parentId ?? null) === parentId && folderName(b).toLowerCase() === n.toLowerCase());
  return same ? tr("There is a folder with that name here already.") : null;
}
