// Webmail (the Mail app's `/api/app/comms/mail`: the person's hosted mailbox over JMAP, RFC 8620
// and 8621): shapes and the pure parts of the mail screen.

import { useQuery } from "@tanstack/react-query";
import { api } from "@ferrum/client";

export const MAIL = "/api/app/comms/mail";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission", "urn:ietf:params:jmap:vacationresponse", "urn:stalwart:jmap"];

export interface Session {
  username: string;
  accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly: boolean }>;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
  servers?: { imap: string; smtp: string };
}

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

/** A message to read, as `GET /mail/message/...` gives it: its HTML already made safe. */
export interface Message extends Omit<EmailSummary, "hasAttachment"> {
  cc: Address[] | null;
  bcc: Address[] | null;
  replyTo: Address[] | null;
  sentAt: string | null;
  messageId: string[] | null;
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

/** Calls in one JMAP request; the answers by call id. A method error becomes an exception. */
export async function jmap(calls: Call[]): Promise<Record<string, Record<string, unknown>>> {
  const out = await api.post<{ methodResponses: [string, Record<string, unknown>, string][] }>(`${MAIL}/jmap`, { using: USING, methodCalls: calls });
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [name, args, id] of out.methodResponses) {
    if (name === "error") throw new Error(`The mail server refused it: ${String(args.description ?? args.type)}`);
    answers[id] = args;
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

export function replySubject(subject: string | null, kind: "reply" | "forward"): string {
  const s = (subject ?? "").trim();
  const prefix = kind === "reply" ? /^re:/i : /^(fwd?|fw):/i;
  if (prefix.test(s)) return s;
  return `${kind === "reply" ? "Re" : "Fwd"}: ${s}`;
}

/**
 * A reply's recipients: the sender (or Reply-To), or for one's own message its recipients; with
 * `all`, everyone else on it too, never oneself.
 */
export function replyRecipients(m: Pick<Message, "from" | "to" | "cc" | "replyTo">, me: string, all: boolean): { to: Address[]; cc: Address[] } {
  const self = me.toLowerCase();
  const others = (list: Address[] | null | undefined) => (list ?? []).filter((a) => a.email.toLowerCase() !== self);
  const sender = others(m.replyTo?.length ? m.replyTo : m.from);
  const to = sender.length ? sender : others(m.to);
  if (!all) return { to, cc: [] };
  const seen = new Set([self, ...to.map((a) => a.email.toLowerCase())]);
  const cc = [...(m.to ?? []), ...(m.cc ?? [])].filter((a) => {
    const e = a.email.toLowerCase();
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  return { to, cc };
}

/** The quoted original under a reply or forward. */
export function quote(m: Pick<Message, "from" | "receivedAt" | "text" | "subject" | "to">, kind: "reply" | "forward", when: string): string {
  if (kind === "forward") {
    return [
      "",
      "",
      "---------- Forwarded message ----------",
      `From: ${formatAddresses(m.from)}`,
      `Date: ${when}`,
      `Subject: ${m.subject ?? ""}`,
      `To: ${formatAddresses(m.to)}`,
      "",
      m.text,
    ].join("\n");
  }
  const lines = m.text.replace(/\s+$/, "").split("\n").map((l) => `> ${l}`);
  return ["", "", `On ${when}, ${addressLabel(m.from?.[0])} wrote:`, ...lines].join("\n");
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
    `<base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff;word-wrap:break-word}` +
    `img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}table{max-width:100%}</style></head><body>${html}</body></html>`
  );
}

/** Size for people: 12 KB, 3.4 MB. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
