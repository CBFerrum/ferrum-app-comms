// Team chat (the Mail app's `/api/app/comms/chat`): shapes and the pure parts of the chat screen.

export const CHAT = "/api/app/comms/chat";

/** Bodies are Markdown of at most this many bytes. */
export const MAX_BODY = 4096;

/** Files one message may carry. */
export const MAX_FILES = 20;

export interface ChannelSummary {
  id: string;
  name: string;
  title: string;
  type: "Public" | "Private" | "Direct" | string;
  topic?: string | null;
  archived?: boolean;
  role: "Owner" | "Member" | null;
  last_read_at?: string | null;
  last_message_at?: string | null;
  unread: number;
  last_message?: { id: string; sender: string; body: string; posted_at: string } | null;
}

export interface Channel extends Omit<ChannelSummary, "unread" | "last_message"> {
  members: { email: string; full_name?: string | null; role: string; last_read_at?: string | null }[];
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
