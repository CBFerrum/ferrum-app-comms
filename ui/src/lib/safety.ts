// Reading safety, from what the mail server wrote into a message's headers: did the sender pass the
// checks, does the mail claim this workspace's domain, why is it in Spam; the unsubscribe links it
// offers; the invitation it carries.

import { formatMoment, t as tr } from "@ferrum/client";
import type { Address } from "./mail";

export const domainOf = (email: string | undefined | null) => (email ?? "").slice((email ?? "").lastIndexOf("@") + 1).toLowerCase();

/** The domains this person's mail is "inside": their own address's and the shared mailboxes'. */
export function workspaceDomains(username: string, accountNames: string[] = []): string[] {
  return [...new Set([username, ...accountNames].filter((n) => n.includes("@")).map(domainOf))];
}

/** Outside the workspace: the sender's domain is none of the workspace's. */
export const isExternal = (from: Address | undefined | null, domains: string[]) => !!from?.email && domains.length > 0 && !domains.includes(domainOf(from.email));

export type AuthMethod = "spf" | "dkim" | "dmarc";

/** `Authentication-Results` (RFC 8601): every result of SPF, DKIM and DMARC, by method. */
export function authResults(header: string | null | undefined): Partial<Record<AuthMethod, string[]>> {
  const out: Partial<Record<AuthMethod, string[]>> = {};
  for (const m of (header ?? "").matchAll(/(?<![.\w])(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) {
    const k = m[1]!.toLowerCase() as AuthMethod;
    (out[k] ??= []).push(m[2]!.toLowerCase());
  }
  return out;
}

const BAD = new Set(["fail", "softfail", "permerror", "temperror"]);

export interface Warning {
  /** "failed": a check came out against the sender. "unverified": it claims the workspace's domain and nothing vouches for it. */
  kind: "failed" | "unverified";
  text: string;
}

/**
 * The warning a message deserves, or null. A message with no `Authentication-Results` (mail the server
 * did not receive from outside) says nothing either way. A failed check always warns; a message that
 * claims one of the workspace's own domains warns unless SPF, DKIM or DMARC passed.
 */
export function senderWarning(from: Address | undefined | null, header: string | null | undefined, domains: string[]): Warning | null {
  if (!header?.trim() || !from?.email) return null;
  const r = authResults(header);
  const domain = domainOf(from.email);
  const failed = (Object.entries(r) as [AuthMethod, string[]][]).filter(([, v]) => v.some((x) => BAD.has(x)) && !v.includes("pass")).map(([k]) => k.toUpperCase());
  if (failed.length) return { kind: "failed", text: tr("This message did not pass the checks for {domain} ({failed}). Be careful with links and attachments.", { domain, failed: failed.join(", ") }) };
  const passed = (["spf", "dkim", "dmarc"] as AuthMethod[]).some((k) => r[k]?.includes("pass"));
  if (domains.includes(domain) && !passed) return { kind: "unverified", text: tr("This message could not be verified as coming from {domain}. Be careful with links and attachments.", { domain }) };
  return null;
}

const SYMBOLS: Record<string, () => string> = {
  GTUBE: () => tr("it contains the standard spam test string"),
  AUTH_NA: () => tr("the sender could not be authenticated"),
  DMARC_NA: () => tr("the sender's domain publishes no DMARC policy"),
  SPF_NA: () => tr("the sender's domain publishes no SPF record"),
  SPF_FAIL: () => tr("it failed the SPF check"),
  DMARC_FAIL: () => tr("it failed the DMARC check"),
  DKIM_FAIL: () => tr("its signature did not match"),
  RDNS_NONE: () => tr("the sending server has no reverse DNS name"),
  HELO_NOT_FQDN: () => tr("the sending server introduced itself with an invalid name"),
  ENV_FROM_INVALID: () => tr("the envelope sender is not valid"),
  FROM_INVALID: () => tr("the From address is not valid"),
  PARTS_DIFFER: () => tr("its text and HTML versions differ"),
};

/** Why the server filed a message as spam: its score and the heaviest reasons, from `X-Spam-Status` and `X-Spam-Result`; null when it did not. */
export function spamReasons(status: string | null | undefined, result: string | null | undefined): { score: number; reasons: string[] } | null {
  if (!/^\s*yes/i.test(status ?? "")) return null;
  const hits = [...(result ?? "").matchAll(/([A-Z][A-Z0-9_]+)\s*\((-?\d+(?:\.\d+)?)\)/g)].map((m) => ({ name: m[1]!, n: Number(m[2]) }));
  const score = Math.round(hits.reduce((s, h) => s + h.n, 0) * 10) / 10;
  const reasons = hits
    .filter((h) => h.n >= 1)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((h) => (SYMBOLS[h.name] ? SYMBOLS[h.name]!() : h.name));
  return { score, reasons };
}

export interface Unsubscribe {
  /** A web page that takes the request. */
  web?: string;
  /** An address a message asking to be taken off goes to. */
  mail?: { to: string; subject: string };
}

/** The unsubscribe targets of a message, from its `List-Unsubscribe` links: web pages only over https or http, and mail addresses. */
export function unsubscribeTargets(links: string[] | null | undefined): Unsubscribe | null {
  const out: Unsubscribe = {};
  for (const l of links ?? []) {
    if (!out.web && /^https?:\/\/[^\s]+$/i.test(l)) out.web = l;
    const m = /^mailto:([^?\s]+)(?:\?(.*))?$/i.exec(l);
    if (m && !out.mail) out.mail = { to: decodeURIComponent(m[1]!), subject: new URLSearchParams(m[2] ?? "").get("subject") || "unsubscribe" };
  }
  return out.web || out.mail ? out : null;
}

// ───────────────────────────── invitations ─────────────────────────────

export interface Invite {
  method: string;
  title: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  where: string;
  organizer: { name: string; email: string } | null;
}

const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
const unescapeText = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/** The moment of a local time in a named zone (the zone's offset then, found by asking Intl); null for a name Intl does not know. */
function inZone(y: number, mo: number, d: number, h: number, mi: number, zone: string): Date | null {
  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const at = (ms: number) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - ms;
    };
    return new Date(guess - at(guess - at(guess)));
  } catch {
    return null;
  }
}

function icsTime(value: string, params: string): { at: Date | null; allDay: boolean } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return { at: null, allDay: false };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) // A day, not a moment: noon UTC keeps it on that day in nearly every zone.
  if (m[4] === undefined) return { at: new Date(Date.UTC(y, mo - 1, d, 12)), allDay: true };
  const [h, mi] = [Number(m[4]), Number(m[5])];
  if (m[7]) return { at: new Date(Date.UTC(y, mo - 1, d, h, mi)), allDay: false };
  const zone = /TZID=([^;:]+)/i.exec(params)?.[1];
  return { at: (zone && inZone(y, mo, d, h, mi, zone)) || new Date(y, mo - 1, d, h, mi), allDay: false };
}

/** The first event of an iCalendar part, as much as the card shows. */
export function parseInvite(ics: string | null | undefined): Invite | null {
  if (!ics) return null;
  const lines = unfold(ics);
  const method = /^METHOD:(.+)$/im.exec(ics)?.[1]?.trim().toUpperCase() ?? "";
  let inEvent = false;
  const got: Record<string, { params: string; value: string }> = {};
  for (const l of lines) {
    if (/^BEGIN:VEVENT/i.test(l)) inEvent = true;
    else if (/^END:VEVENT/i.test(l)) break;
    else if (inEvent) {
      const i = l.indexOf(":");
      if (i < 0) continue;
      const [name, ...params] = l.slice(0, i).split(";");
      got[name!.toUpperCase()] ??= { params: params.join(";"), value: l.slice(i + 1) };
    }
  }
  if (!got.DTSTART && !got.SUMMARY) return null;
  const start = got.DTSTART ? icsTime(got.DTSTART.value, got.DTSTART.params) : { at: null, allDay: false };
  const end = got.DTEND ? icsTime(got.DTEND.value, got.DTEND.params).at : null;
  const org = got.ORGANIZER;
  const email = org?.value.replace(/^mailto:/i, "").trim() ?? "";
  return {
    method,
    title: unescapeText(got.SUMMARY?.value ?? ""),
    start: start.at,
    end,
    allDay: start.allDay,
    where: unescapeText(got.LOCATION?.value ?? ""),
    organizer: org ? { name: unescapeText(/CN="?([^";:]+)"?/i.exec(org.params)?.[1] ?? "") || email, email } : null,
  };
}

/** When the event is, in the person's time zone: "Thu 13 Nov, 11:00 to 12:00 UTC". */
export function inviteWhen(i: Pick<Invite, "start" | "end" | "allDay">): string {
  if (!i.start) return "";
  if (i.allDay) return formatMoment(i.start, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const day = formatMoment(i.start, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  if (!i.end) return day;
  // The end shares the start's day nearly always; when it does not, it says its day.
  const same = formatMoment(i.start, { dateStyle: "short" }) === formatMoment(i.end, { dateStyle: "short" });
  return `${day} – ${formatMoment(i.end, same ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
}

// ───────────────────────────── images ─────────────────────────────

const imageKey = (account: string) => `ferrum.mail.images.${account}`;

const store = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** The senders whose images this person always loads, kept in this browser per mailbox. */
export function imageSenders(account: string, s: Storage | null = store()): string[] {
  try {
    const v = JSON.parse(s?.getItem(imageKey(account)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const showsImagesFrom = (account: string, email: string | undefined, s: Storage | null = store()) => !!email && imageSenders(account, s).includes(email.toLowerCase());

export function alwaysShowImagesFrom(account: string, email: string, s: Storage | null = store()): void {
  try {
    s?.setItem(imageKey(account), JSON.stringify([...new Set([...imageSenders(account, s), email.toLowerCase()])]));
  } catch {
    // This visit still shows them; it is just not remembered.
  }
}
