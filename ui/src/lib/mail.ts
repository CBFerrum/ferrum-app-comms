// Webmail (the Mail app's `/api/app/comms/mail`: the person's hosted mailbox over JMAP, RFC 8620
// and 8621): shapes and the pure parts of the mail screen.

import { useQuery } from "@tanstack/react-query";
import { api, t as tr } from "@ferrum/client";

export const MAIL = "/api/app/comms/mail";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission", "urn:ietf:params:jmap:vacationresponse", "urn:ietf:params:jmap:sieve", "urn:stalwart:jmap"];

export interface Session {
  username: string;
  accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly: boolean }>;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
  servers?: { imap: string; smtp: string };
  /** What this server's Mail does beyond JMAP (a server from before wave 4 sends none). */
  ferrum?: { features?: string[] };
}

/** Whether the server does `feature` itself: "arrivals" (new mail, snooze and calendar answers without a tab), "itip", "unsubscribe" (one-click), "zip". */
export const serverDoes = (s: Session | undefined, feature: string) => !!s?.ferrum?.features?.includes(feature);
/** The same, from the cached session. */
export const useServerDoes = (feature: string) => serverDoes(useMailSession().data, feature);

export interface Address {
  name?: string | null;
  email: string;
}

export interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  parentId?: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[] | null;
  to: Address[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
}

export interface Attachment {
  blobId: string;
  name: string | null;
  type: string;
  size: number;
}

/** A file on a message being written: already on the mail server (its blob). */
export interface Upload {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

/** A message to read, as `GET /mail/message/...` gives it: its HTML already made safe. */
export interface Message extends Omit<EmailSummary, "hasAttachment"> {
  cc: Address[] | null;
  bcc: Address[] | null;
  replyTo: Address[] | null;
  sentAt: string | null;
  messageId: string[] | null;
  inReplyTo?: string[] | null;
  references: string[] | null;
  html: string;
  text: string;
  remote_images: number;
  attachments: Attachment[];
}

/** The person's mail session; an error when they have no hosted mailbox. */
export function useMailSession(enabled = true) {
  return useQuery({
    queryKey: ["mail", "session"],
    queryFn: ({ signal }) => api.get<Session>(MAIL, undefined, signal),
    enabled,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

export const mailAccount = (s: Session | undefined) => s?.primaryAccounts["urn:ietf:params:jmap:mail"];

type Call = [string, Record<string, unknown>, string];

/**
 * The mail server answers at most `maxConcurrentRequests` (4 on Stalwart) requests of one account at a
 * time and refuses the rest, so the screen asks in turn: three at once, the rest wait, leaving one for
 * the proxy's own (a message's inline images). A refusal for that reason is asked again a little later.
 */
export function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (attempt >= 3 || !/maxConcurrentRequests/.test(String((e as Error)?.message ?? e))) throw e;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Every request to the mail server from this screen goes through here. */
export const inTurn = limiter(3);

/** Calls in one JMAP request; the answers by call id. A method error becomes an exception. */
export const jmap = (calls: Call[]) => inTurn(() => jmapNow(calls));

async function jmapNow(calls: Call[]): Promise<Record<string, Record<string, unknown>>> {
  const out = await api.post<{ methodResponses: [string, Record<string, unknown>, string][] }>(`${MAIL}/jmap`, { using: USING, methodCalls: calls });
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [name, args, id] of out.methodResponses) {
    if (name === "error") throw new Error(tr("The mail server refused it: {value}", { value: String(args.description ?? args.type) }));
    // A call's own answer comes first; one it implies (onSuccessUpdateEmail's Email/set) shares its id and must not replace it.
    if (!(id in answers)) answers[id] = args;
  }
  return answers;
}

/** Folders in the usual order: Inbox, Drafts, Sent, Archive, Junk, Trash, then the person's own. */
const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
export function sortMailboxes(list: Mailbox[]): Mailbox[] {
  const rank = (m: Mailbox) => (m.role && ROLE_ORDER.includes(m.role) ? ROLE_ORDER.indexOf(m.role) : ROLE_ORDER.length);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export const byRole = (list: Mailbox[] | undefined, role: string) => list?.find((m) => m.role === role);

export function addressLabel(a: Address | undefined | null): string {
  if (!a) return "";
  return a.name?.trim() || a.email;
}

export const addressList = (list: Address[] | null | undefined) => (list ?? []).map(addressLabel).join(", ");

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** "Ann <ann@x.com>, bob@y.com" → addresses; `bad` lists what is not an address. */
export function parseAddresses(input: string): { list: Address[]; bad: string[] } {
  const list: Address[] = [];
  const bad: string[] = [];
  // Separators inside a quoted name ("Carol, CFO") or <...> do not split.
  for (const raw of input.match(/(?:"[^"]*"|<[^>]*>|[^,;\n"<])+/g) ?? []) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(.*)<([^>]+)>$/.exec(part);
    const email = (m ? m[2] : part).trim();
    const name = m ? m[1].trim().replace(/^"|"$/g, "") : "";
    if (EMAIL.test(email)) list.push(name ? { name, email } : { email });
    else bad.push(part);
  }
  return { list, bad };
}

export const formatAddresses = (list: Address[] | null | undefined) => (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

/**
 * A reply's recipients: the sender (or Reply-To), or for one's own message its recipients; with
 * `all`, everyone else on it too, never oneself.
 */
export function replyRecipients(m: Pick<Message, "from" | "to" | "cc" | "replyTo">, me: string | string[], all: boolean): { to: Address[]; cc: Address[] } {
  const own = new Set((Array.isArray(me) ? me : [me]).map((x) => x.toLowerCase()));
  const others = (list: Address[] | null | undefined) => (list ?? []).filter((a) => !own.has(a.email.toLowerCase()));
  const sender = others(m.replyTo?.length ? m.replyTo : m.from);
  const to = sender.length ? sender : others(m.to);
  if (!all) return { to, cc: [] };
  const seen = new Set([...own, ...to.map((a) => a.email.toLowerCase())]);
  const cc = [...(m.to ?? []), ...(m.cc ?? [])].filter((a) => {
    const e = a.email.toLowerCase();
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  return { to, cc };
}

/**
 * The document a message is shown in: the server already made its HTML safe; the sandboxed frame
 * (no scripts, its own origin) and this policy are the second wall. Remote images load only when
 * the person asked for them.
 */
export function frameDocument(html: string, images: boolean): string {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https: http:" : ""}; base-uri 'none'; form-action 'none'`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    // ui-lint-allow raw-color: authored mail content in a sandboxed iframe; senders write for a white page, so it ignores the theme
    `<base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff;word-wrap:break-word}` +
    `img{max-width:100%;height:auto}img:not([src]){display:none!important}pre{white-space:pre-wrap;font:inherit}table{max-width:100%}</style></head><body>${html}</body></html>`
  );
}

/** Size for people: 12 KB, 3.4 MB. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return tr("{n} KB", { n: Math.round(bytes / 1024) });
  if (bytes < 1024 * 1024 * 1024) return tr("{value} MB", { value: (bytes / 1024 / 1024).toFixed(1) });
  return tr("{value} GB", { value: +(bytes / 1024 / 1024 / 1024).toFixed(1) });
}

// ───────────────────────────── conversations ─────────────────────────────

/** A line of the list: the newest message of a conversation in this folder. */
export interface Row extends EmailSummary {
  /** Messages in the conversation, in any folder. */
  count: number;
  /** Any of them is unread. */
  unread: boolean;
  /** Its messages in this folder: what an action on the line reaches. */
  folderIds: string[];
}

/** The list's rows from one JMAP answer: the emails (one per conversation, `collapseThreads`), the
 *  conversations (`Thread/get`) and the flags and folders of every message in them. */
export function conversationRows(
  emails: EmailSummary[],
  threads: { id: string; emailIds: string[] }[],
  flags: { id: string; keywords: Record<string, boolean> | null; mailboxIds?: Record<string, boolean> | null }[],
  folder: string,
  /** A view that is not a folder (Starred, All mail): an action reaches the whole conversation. */
  whole = false,
): Row[] {
  const members = new Map(threads.map((t) => [t.id, t.emailIds]));
  const known = new Map(flags.map((f) => [f.id, f]));
  return emails.map((e) => {
    const ids = members.get(e.threadId) ?? [e.id];
    const unread = ids.some((id) => !(known.get(id) ? !!known.get(id)!.keywords?.$seen : !!e.keywords?.$seen));
    const here = ids.filter((id) => (whole || id === e.id ? true : !!known.get(id)?.mailboxIds?.[folder]));
    return { ...e, count: ids.length, unread, folderIds: here };
  });
}

/** The messages of a conversation that open expanded: the newest, and any not read yet. */
export function expandedIds(messages: { id: string; keywords: Record<string, boolean> | null }[]): string[] {
  return messages.filter((m, i) => i === messages.length - 1 || !m.keywords?.$seen).map((m) => m.id);
}

/** The messages of a conversation an action on it reaches: those in the folder it is seen from. */
export function inFolder(messages: Pick<EmailSummary, "id" | "mailboxIds">[], folder: string | undefined, fallback: string): string[] {
  const ids = messages.filter((m) => folder && m.mailboxIds[folder]).map((m) => m.id);
  return ids.length ? ids : [fallback];
}

/** "3 messages" for a conversation's count. */
export const messagesIn = (n: number) => `${n} ${n === 1 ? "message" : "messages"}`;

// ───────────────────────────── keyboard ─────────────────────────────

export type MailKey = "label" | "select" | "move" | "undo" | "read" | "next" | "previous" | "open" | "back" | "reply" | "replyAll" | "forward" | "archive" | "delete" | "spam" | "unread" | "star" | "compose" | "search" | "help";

/** What the keys do, for the list of shortcuts. */
export const SHORTCUTS: { keys: string[]; action: MailKey; label: string }[] = [
  { keys: ["j"], action: "next", get label() { return tr("Next conversation"); } },
  { keys: ["k"], action: "previous", get label() { return tr("Previous conversation"); } },
  { get keys() { return [tr("Enter"), "o"]; }, action: "open", get label() { return tr("Open the conversation"); } },
  { get keys() { return ["u", tr("Esc")]; }, action: "back", get label() { return tr("Back to the list"); } },
  { keys: ["r"], action: "reply", get label() { return tr("Reply"); } },
  { keys: ["a"], action: "replyAll", get label() { return tr("Reply to all"); } },
  { keys: ["f"], action: "forward", get label() { return tr("Forward"); } },
  { keys: ["e"], action: "archive", get label() { return tr("Archive"); } },
  { keys: ["#"], action: "delete", get label() { return tr("Delete"); } },
  { keys: ["!"], action: "spam", get label() { return tr("Mark as spam"); } },
  { keys: ["Shift", "U"], action: "unread", get label() { return tr("Mark as unread"); } },
  { keys: ["Shift", "I"], action: "read", get label() { return tr("Mark as read"); } },
  { keys: ["x"], action: "select", get label() { return tr("Select the conversation"); } },
  { keys: ["v"], action: "move", get label() { return tr("Move to a folder"); } },
  { keys: ["l"], action: "label", get label() { return tr("Also file under a folder"); } },
  { keys: ["z"], action: "undo", get label() { return tr("Undo the last action"); } },
  { keys: ["s"], action: "star", get label() { return tr("Star or unstar"); } },
  { keys: ["c"], action: "compose", get label() { return tr("Write a message"); } },
  { keys: ["/"], action: "search", get label() { return tr("Search"); } },
  { keys: ["?"], action: "help", get label() { return tr("Show these shortcuts"); } },
];

/** Keys while writing (shown in the same help; the editor and the composer handle them). */
export const WRITING_SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Ctrl", "Enter"], get label() { return tr("Send"); } },
  { keys: ["Ctrl", "K"], get label() { return tr("Add or change a link (also Ctrl+Shift+K)"); } },
  { keys: ["Ctrl", "B"], get label() { return tr("Bold"); } },
  { keys: ["Ctrl", "I"], get label() { return tr("Italic"); } },
  { keys: ["Ctrl", "U"], get label() { return tr("Underline"); } },
  { keys: ["Ctrl", "Shift", "8"], get label() { return tr("Bulleted list"); } },
  { keys: ["Ctrl", "Shift", "7"], get label() { return tr("Numbered list"); } },
  { keys: ["Ctrl", "\\"], get label() { return tr("Remove formatting"); } },
  { get keys() { return [tr("Esc")]; }, get label() { return tr("Save the draft and close"); } },
];

const KEYS: Record<string, MailKey> = {
  j: "next",
  k: "previous",
  Enter: "open",
  o: "open",
  u: "back",
  Escape: "back",
  r: "reply",
  a: "replyAll",
  f: "forward",
  e: "archive",
  "#": "delete",
  "!": "spam",
  U: "unread",
  I: "read",
  x: "select",
  v: "move",
  l: "label",
  z: "undo",
  s: "star",
  c: "compose",
  "/": "search",
  "?": "help",
};

let shortcutsOn = true;
/** The person turned the keyboard shortcuts off (Mail settings): no key acts then. */
export const setShortcutsOn = (on: boolean) => void (shortcutsOn = on);

/** What a key press asks for, unless it is part of a shortcut of the browser or the system, or the shortcuts are off. */
export function keyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): MailKey | null {
  return !shortcutsOn || e.ctrlKey || e.metaKey || e.altKey ? null : (KEYS[e.key] ?? null);
}

/** Whether a key press belongs to something being typed in or operated, not to the shortcuts. */
export function busyWith(target: { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null, key: string): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || target.isContentEditable) return true;
  // Enter on a button or a link presses it; it is not "open".
  if (key === "Enter" && ["BUTTON", "A", "SUMMARY"].includes(tag)) return true;
  return !!target.closest?.("[role=dialog],[role=alertdialog],dialog,[role=menu],[role=listbox],[role=combobox]");
}

/** The index after a step in the list, kept inside it. */
export const step = (index: number, count: number, by: 1 | -1) => (count ? Math.min(count - 1, Math.max(0, index + by)) : 0);

// ───────────────────────────── writing ─────────────────────────────

/** What is written in a composer: the state it saves, keeps in the browser and is opened again from. */
export interface Written {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** The editor's HTML (rich text); empty when written as plain text. */
  html: string;
  /** The words as plain text (what is sent when `plain`). */
  text: string;
  plain: boolean;
  /** The quoted original, not opened into the body yet ("…"); null once opened or left out. */
  quote: string | null;
  files: Upload[];
  identityId?: string | null;
  /** The identity's signature goes with it. */
  signature: boolean;
}

/** A message to write: new, an answer to one, or a forward of one. */
export interface Draft {
  kind: "new" | "reply" | "replyAll" | "forward";
  original?: Message;
  /** A new message's fields, filled in by another app (the `compose email` intent). */
  prefill?: { to?: string; cc?: string; subject?: string; body?: string };
  /** Files to attach first: this site's `/api/` addresses, fetched with the person's rights. */
  attach?: { url: string; name: string }[];
  /** A message already written that the person goes on with: in Drafts (`id`), in this browser (`key`), or both. */
  saved?: { id?: string; key?: string; written?: Partial<Written>; inReplyTo?: string[] | null; references?: string[] | null };
}

/** Whether there is anything written: recipients, a subject, words or a file. */
export const hasContent = (w: Pick<Written, "to" | "cc" | "bcc" | "subject" | "text" | "files">) => !!(w.to.length || w.cc.length || w.bcc.length || w.subject.trim() || w.text.trim() || w.files.length);

/** The mail server's refusal in plain words. */
const PROBLEMS: Record<string, string> = {
  get overQuota() { return tr("Your mailbox is full. Delete some mail and try again."); },
  get tooLarge() { return tr("The message is too large for the mail server. Remove an attachment or two."); },
  get invalidEmail() { return tr("The mail server could not accept the message. Check the addresses and the subject."); },
  get tooManyRecipients() { return tr("There are too many recipients for one message."); },
  get noRecipients() { return tr("The message has no recipients."); },
  get forbiddenFrom() { return tr("The mail server does not let you send as that address."); },
  get forbiddenMailFrom() { return tr("The mail server does not let you send as that address."); },
  get forbiddenToSend() { return tr("Your mailbox is not allowed to send mail."); },
  get rateLimit() { return tr("You have sent a lot of mail in a short time. Wait a little and try again."); },
};

/** The mail server's refusal of a creation (`notCreated`) in plain words. */
export function refusal(err: { type?: string; description?: string; properties?: string[] } | undefined, fallback = tr("The mail server refused it.")): string {
  if (!err) return fallback;
  if (err.type && PROBLEMS[err.type]) return PROBLEMS[err.type]!;
  if (err.type === "invalidProperties" && err.properties?.length) return tr("The mail server did not accept the message ({value}).", { value: err.properties.join(", ") });
  return err.description ? tr("The mail server said: {description}", { description: err.description }) : fallback;
}

// ───────────────────────────── drafts kept in the browser ─────────────────────────────

/** What the browser keeps of a message being written while the mail server does not have its last
 *  words (a save failed, or the tab closed between a key and the save); gone once the server has it,
 *  and after two weeks. */
export interface Kept {
  key: string;
  account: string;
  savedAt: string;
  written: Written;
  /** The message in Drafts it replaces. */
  draftId?: string;
  inReplyTo?: string[] | null;
  references?: string[] | null;
}

/** How long the browser keeps unsent words (a shared computer should not hold them for ever). */
const KEEP_DAYS = 14;

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(i: number): string | null;
}

const PREFIX = "ferrum.mail.draft.";

const local = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function keepDraft(k: Kept, store: Store | null = local()): void {
  try {
    store?.setItem(`${PREFIX}${k.account}.${k.key}`, JSON.stringify(k));
  } catch {
    // The window still holds it; it just cannot come back after a crash.
  }
}

export function dropDraft(account: string, key: string, store: Store | null = local()): void {
  try {
    store?.removeItem(`${PREFIX}${account}.${key}`);
  } catch {
    // nothing kept, nothing to drop
  }
}

/** Messages left unsent in this browser for an account, newest first. */
export function keptDrafts(account: string, store: Store | null = local()): Kept[] {
  const out: Kept[] = [];
  try {
    for (let i = 0; store && i < store.length; i++) {
      const name = store.key(i);
      if (!name?.startsWith(`${PREFIX}${account}.`)) continue;
      const k = JSON.parse(store.getItem(name) ?? "null") as (Kept & { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; files?: Upload[] }) | null;
      const old = !k?.savedAt || Date.now() - Date.parse(k.savedAt) > KEEP_DAYS * 86_400_000;
      // A copy from before rich text is its plain words.
      if (k && !k.written)
        k.written = { to: parseAddresses(k.to ?? "").list, cc: parseAddresses(k.cc ?? "").list, bcc: parseAddresses(k.bcc ?? "").list, subject: k.subject ?? "", html: "", text: k.body ?? "", plain: true, quote: null, files: k.files ?? [], signature: false };
      if (!k || old) {
        store.removeItem(name);
        i--;
      } else if (k.account === account && typeof k.key === "string") out.push(k);
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
