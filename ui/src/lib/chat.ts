// Team chat (the Mail app's `/api/app/comms/chat`): shapes and the pure parts of the chat screen.

export const CHAT = "/api/app/comms/chat";

/** Bodies are Markdown of at most this many bytes. */
export const MAX_BODY = 4096;

/** Files one message may carry. */
export const MAX_FILES = 20;

/** How loud a channel is for a person: every message, mentions and replies to them, or nothing. */
export type Loud = "All" | "Mentions" | "Nothing";

export interface ChannelSummary {
  id: string;
  name: string;
  title: string;
  type: "Public" | "Private" | "Direct" | string;
  topic?: string | null;
  archived?: boolean;
  role: "Owner" | "Member" | null;
  /** Who starts posts: every member, or only the owners (members still reply in threads). */
  post_policy?: "Members" | "Owners" | string | null;
  /** The person's own choice; none means what the kind of channel suggests. */
  notify_level?: Loud | null;
  last_read_at?: string | null;
  last_message_at?: string | null;
  unread: number;
  /** How many of the unread messages mention the person. */
  unread_mentions?: number;
  last_message?: { id: string; sender: string; body: string; posted_at: string } | null;
  /** A direct conversation's other person is about (active in the last ten minutes). */
  active?: boolean | null;
}

export interface Member {
  email: string;
  full_name?: string | null;
  role: "Owner" | "Member" | string;
  last_read_at?: string | null;
  /** About: active in the last ten minutes. Only that is known, never when they were last seen. */
  active?: boolean;
}

export interface Channel extends Omit<ChannelSummary, "unread" | "unread_mentions" | "last_message"> {
  members: Member[];
}

export interface Message {
  id: string;
  channel: string;
  sender: string;
  sender_name?: string | null;
  body: string;
  parent?: string | null;
  mentions?: string[];
  attachments?: unknown;
  deleted?: boolean;
  posted_at: string;
  edited_at?: string | null;
  reply_count?: number;
  last_reply_at?: string | null;
}

/** A file on a message, as the server lists it. */
export interface Attachment {
  id: string;
  file_name: string;
  content_type?: string;
  size?: number;
}

/** Where a message's file downloads from (for the channel's members). */
export const attachmentPath = (id: string) => `/api/app/comms/attachments/${encodeURIComponent(id)}`;

/** A message's files; anything that is not a listed file is left out. */
export function attachmentsOf(m: Pick<Message, "attachments">): Attachment[] {
  if (!Array.isArray(m.attachments)) return [];
  return m.attachments.filter(
    (a): a is Attachment => typeof a === "object" && a !== null && typeof (a as Attachment).id === "string" && typeof (a as Attachment).file_name === "string",
  );
}

/** `840 B`, `12 KB`, `3.4 MB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export interface Person {
  id: string;
  full_name?: string | null;
  email: string;
}

const MENTION = /<@([^<>\s@]+@[^<>\s@]+)>/g;

/** Emails mentioned as `<@email>` in a body. */
export function mentionsIn(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((m) => m[1]!.toLowerCase()))];
}

/** The body with `<@email>` shown as `@Name` (the people we know) for display. */
export function showMentions(body: string, people: Person[]): string {
  return body.replace(MENTION, (_, email: string) => {
    const p = people.find((x) => x.email.toLowerCase() === email.toLowerCase());
    return `@${p?.full_name || email}`;
  });
}

export function bodyTooLong(body: string): boolean {
  return new TextEncoder().encode(body).length > MAX_BODY;
}

/** Pages of messages (each newest first) as one list, oldest first, without duplicates. */
export function timeline(pages: Message[][]): Message[] {
  const seen = new Map<string, Message>();
  for (const page of pages) for (const m of page) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.id.localeCompare(b.id));
}

/** Whether `m` starts a new day compared with the message before it (for day separators). */
export function startsDay(m: Message, before: Message | undefined): boolean {
  return !before || new Date(before.posted_at).toDateString() !== new Date(m.posted_at).toDateString();
}

/** Whether `m` continues the previous message's run (same sender within five minutes). */
export function continues(m: Message, before: Message | undefined): boolean {
  if (!before || before.sender !== m.sender || before.deleted || m.deleted) return false;
  return new Date(m.posted_at).getTime() - new Date(before.posted_at).getTime() < 5 * 60_000;
}

/** Channels I am in (by last activity, as the server sends them), then public ones I could join. */
export function splitChannels(list: ChannelSummary[]): { mine: ChannelSummary[]; joinable: ChannelSummary[] } {
  return { mine: list.filter((c) => c.role), joinable: list.filter((c) => !c.role && !c.archived) };
}

// ───────────────────────────── who hears, who posts ─────────────────────────────

/** What a channel means to the person: their choice, else everything for a direct message and
 *  mentions for a channel (as the server decides whom to notify). */
export function loudness(c: Pick<ChannelSummary, "type" | "notify_level">): Loud {
  return c.notify_level === "All" || c.notify_level === "Mentions" || c.notify_level === "Nothing" ? c.notify_level : c.type === "Direct" ? "All" : "Mentions";
}

export const LOUDNESS: { value: Loud; label: string; hint: string }[] = [
  { value: "All", label: "Every message", hint: "You are told of each new message." },
  { value: "Mentions", label: "Mentions and replies", hint: "You are told when someone mentions you or answers in a thread you are in." },
  { value: "Nothing", label: "Nothing, mute it", hint: "No notifications and no unread count. A mention still marks the channel." },
];

/** The count and mention marker a channel row shows: a muted channel counts nothing, but a
 *  mention still marks it. */
export function badge(c: Pick<ChannelSummary, "type" | "notify_level" | "unread" | "unread_mentions">): { count: number; mention: boolean } {
  const mention = (c.unread_mentions ?? 0) > 0;
  return loudness(c) === "Nothing" ? { count: 0, mention } : { count: c.unread, mention };
}

/** Everything unread that should call for attention (the bar's badge). */
export function unreadTotal(list: ChannelSummary[]): number {
  return list.reduce((n, c) => (c.role ? n + badge(c).count : n), 0);
}

export type Show = "all" | "unread" | "mentions";

/** The list as the person narrowed it: by what they typed, and to unread or mentioned. */
export function filterChannels(list: ChannelSummary[], text: string, show: Show): ChannelSummary[] {
  const f = text.trim().toLowerCase();
  return list.filter((c) => {
    if (f && !c.title.toLowerCase().includes(f) && !c.name.toLowerCase().includes(f)) return false;
    if (show === "unread") return !!c.role && (badge(c).count > 0 || badge(c).mention);
    if (show === "mentions") return (c.unread_mentions ?? 0) > 0;
    return true;
  });
}

/** Direct messages, then channels, then public ones to join; muted conversations sink in each. */
export function groupChannels(list: ChannelSummary[]): { direct: ChannelSummary[]; channels: ChannelSummary[]; joinable: ChannelSummary[] } {
  const quiet = (a: ChannelSummary, b: ChannelSummary) => Number(loudness(a) === "Nothing") - Number(loudness(b) === "Nothing");
  const { mine, joinable } = splitChannels(list);
  return {
    direct: mine.filter((c) => c.type === "Direct").sort(quiet),
    channels: mine.filter((c) => c.type !== "Direct").sort(quiet),
    joinable,
  };
}

export type Posting = { state: "ok" } | { state: "join" } | { state: "archived"; why: string } | { state: "owners"; why: string };

/** Whether the person may post in the channel, as a new post or as a reply in a thread, and if
 *  not, what to tell them. */
export function posting(c: Pick<ChannelSummary, "archived" | "role" | "post_policy">, reply = false): Posting {
  if (c.archived) return { state: "archived", why: "This channel is archived. Nobody can post in it." };
  if (!c.role) return { state: "join" };
  if (c.post_policy === "Owners" && c.role !== "Owner" && !reply) {
    return { state: "owners", why: "Only the channel's owners start posts here. You can reply in a thread." };
  }
  return { state: "ok" };
}

/** Who reads and who posts, in a sentence for the channel's details. */
export function accessText(c: Pick<ChannelSummary, "type" | "post_policy" | "archived">): string {
  if (c.type === "Direct") return "Only the two of you can read this conversation.";
  const reads = c.type === "Private" ? "Only its members can read it." : "Anyone in the workspace can read it and join.";
  if (c.archived) return `${reads} It is archived, so nobody can post.`;
  return `${reads} ${c.post_policy === "Owners" ? "Only its owners start posts; members reply in threads." : "Every member can post."}`;
}

/** Members for the details panel: owners first, then by name; narrowed by what was typed. */
export function memberRows(members: Member[], text: string): Member[] {
  const f = text.trim().toLowerCase();
  const name = (m: Member) => (m.full_name || m.email).toLowerCase();
  return members
    .filter((m) => !f || name(m).includes(f) || m.email.toLowerCase().includes(f))
    .sort((a, b) => Number(b.role === "Owner") - Number(a.role === "Owner") || name(a).localeCompare(name(b)));
}

/** People who are not in the channel yet, matching what was typed, for the add box. */
export function addable(people: Person[], members: Member[], text: string, limit = 6): Person[] {
  const inside = new Set(members.map((m) => m.email.toLowerCase()));
  return matchPeople(people.filter((p) => !inside.has(p.email.toLowerCase())), text, undefined, limit);
}

// ───────────────────────────── typing a mention ─────────────────────────────

/** The `@name` being typed just before `caret`: where it starts and what follows the @. */
export function mentionAt(text: string, caret: number): { from: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([^\s@<>]{0,40})$/.exec(before);
  return m ? { from: before.length - m[2]!.length - 1, query: m[2]! } : null;
}

/** People matching a typed name or address: names starting with it first, then those containing it. */
export function matchPeople(people: Person[], query: string, me?: string, limit = 6): Person[] {
  const q = query.trim().toLowerCase();
  const own = me?.toLowerCase();
  const rank = (p: Person) => {
    const name = (p.full_name ?? "").toLowerCase();
    const words = name.split(/\s+/);
    if (!q) return 3;
    if (name.startsWith(q) || p.email.toLowerCase().startsWith(q)) return 0;
    if (words.some((w) => w.startsWith(q))) return 1;
    return name.includes(q) || p.email.toLowerCase().includes(q) ? 2 : 9;
  };
  return people
    .filter((p) => p.email.toLowerCase() !== own && rank(p) < 9)
    .sort((a, b) => rank(a) - rank(b) || (a.full_name || a.email).localeCompare(b.full_name || b.email))
    .slice(0, limit);
}

/** The text with the `@query` before `caret` turned into a mention of `person`, and where the caret goes. */
export function completeMention(text: string, caret: number, person: Person): { text: string; caret: number } {
  const at = mentionAt(text, caret);
  if (!at) return { text, caret };
  const token = `<@${person.email}> `;
  return { text: text.slice(0, at.from) + token + text.slice(caret), caret: at.from + token.length };
}

// ───────────────────────────── reading ─────────────────────────────

/** The first message the person has not read: after their marker, and not their own. */
export function firstUnread(list: Message[], readAt: string | null | undefined, me: string): Message | undefined {
  const mark = readAt ? new Date(readAt).getTime() : -Infinity;
  const mine = me.toLowerCase();
  return list.find((m) => !m.deleted && m.sender.toLowerCase() !== mine && new Date(m.posted_at).getTime() > mark);
}

export const mentionsMe = (m: Pick<Message, "mentions" | "deleted">, me: string) => !m.deleted && !!m.mentions?.some((x) => x.toLowerCase() === me.toLowerCase());

/** A search result's text around the first match, so the match can be shown in bold. */
export function snippet(body: string, term: string, width = 70): { before: string; hit: string; after: string } {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at < 0) return { before: "", hit: "", after: flat.length > width * 2 ? `${flat.slice(0, width * 2)}…` : flat };
  const from = Math.max(0, at - width);
  const to = Math.min(flat.length, at + term.length + width);
  return { before: (from > 0 ? "…" : "") + flat.slice(from, at), hit: flat.slice(at, at + term.length), after: flat.slice(at + term.length, to) + (to < flat.length ? "…" : "") };
}

// ───────────────────────────── drafts ─────────────────────────────

/** Where a channel's (or thread's) unsent text is kept in this browser. */
export const draftKey = (channel: string, parent?: string) => `ferrum.chat.draft.${channel}${parent ? `.${parent}` : ""}`;

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const browserStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** Unsent text kept for a conversation; empty when there is none or the browser keeps nothing. */
export function readDraft(key: string, store: Store | null = browserStore()): string {
  try {
    return store?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Keeps unsent text, or forgets it when there is none. */
export function writeDraft(key: string, text: string, store: Store | null = browserStore()): void {
  try {
    if (text.trim()) store?.setItem(key, text);
    else store?.removeItem(key);
  } catch {
    // The text stays on screen; it just will not come back.
  }
}

// ───────────────────────────── screen helpers ─────────────────────────────

/** The queries of the chat screens, so one can refresh what another changed. */
export const keys = {
  channels: ["chat", "channels"] as const,
  channel: (id: string) => ["chat", "channel", id] as const,
  /** The latest messages of a conversation, or the window around one (`around`). */
  messages: (id: string, around?: string | null) => (around ? (["chat", "messages", id, "around", around] as const) : (["chat", "messages", id] as const)),
  thread: (id: string) => ["chat", "thread", id] as const,
  message: (id: string) => ["chat", "message", id] as const,
};

/** Fetches again whatever shows messages, but not the files they carry (an image would flicker). */
export function refreshMessages(qc: { invalidateQueries(o: { queryKey: readonly unknown[] }): unknown }) {
  for (const queryKey of [["chat", "messages"], ["chat", "thread"], ["chat", "message"], ["chat", "channels"]]) void qc.invalidateQueries({ queryKey });
}

/** Two letters for someone's picture: their name's first letters, else their address's. */
export const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** A panel beside a conversation (a thread, its details, a search): over the page on phones and
 *  tablets, a column on wide screens. */
export const SIDE_PANEL =
  "fixed inset-y-0 right-0 z-40 grid w-full grid-rows-[auto_minmax(0,1fr)] border-l bg-background shadow-xl sm:w-[420px] xl:static xl:z-auto xl:row-span-2 xl:row-start-2 xl:w-[360px] xl:shadow-none";
