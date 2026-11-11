// Knowing that mail arrived: the mailbox's Email state is asked for every few seconds (one small
// request, inside the 4-at-once limit), and when it moved, Email/changes says which messages are new.
// What of that notifies: new, unread mail in the Inbox (what the filters filed elsewhere does not),
// not one's own, and with "people" only from someone the person has written to. Pure parts here.

import { t as tr } from "@ferrum/client";
import type { Address } from "./mail";

/** How often the state is asked: often while the page is in front, rarely behind. */
export const WATCH_VISIBLE_MS = 8_000;
export const WATCH_HIDDEN_MS = 30_000;

export interface Arrived {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean> | null;
  keywords: Record<string, boolean> | null;
  from: Address[] | null;
  subject: string | null;
}

/** The messages that notify. `known` says whether the person has written to an address (for "people"). */
export function notifying(list: Arrived[], inbox: string | undefined, own: string[], choice: "all" | "people" | "none", known: (email: string) => boolean): Arrived[] {
  if (choice === "none" || !inbox) return [];
  const mine = new Set(own.map((a) => a.toLowerCase()));
  return list.filter((m) => {
    const from = m.from?.[0]?.email?.toLowerCase() ?? "";
    if (!m.mailboxIds?.[inbox] || m.keywords?.$seen || m.keywords?.$draft || mine.has(from)) return false;
    return choice === "all" || known(from);
  });
}

/** The notification's words: one message by its sender and subject, several by how many and from whom. */
export function notificationText(list: Arrived[]): { title: string; body: string } {
  const who = (m: Arrived) => m.from?.[0]?.name?.trim() || m.from?.[0]?.email || tr("(unknown sender)");
  if (list.length === 1) return { title: who(list[0]!), body: list[0]!.subject || tr("(no subject)") };
  const names = [...new Set(list.map(who))];
  return { title: tr("{n} new messages", { n: list.length }), body: names.slice(0, 3).join(", ") + (names.length > 3 ? tr(", +{n}", { n: names.length - 3 }) : "") };
}

/** Snoozed mail carries its wake time as a keyword (`$ferrum_wake_YYYYMMDDHHMM`, UTC). */
const WAKE = "$ferrum_wake_";
export const wakeKeyword = (at: Date) => WAKE + at.toISOString().replace(/[-:T]/g, "").slice(0, 12);
export function wakeOf(keywords: Record<string, boolean> | null | undefined): Date | null {
  const k = Object.keys(keywords ?? {}).find((x) => x.toLowerCase().startsWith(WAKE));
  const m = k && /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(k);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)) : null;
}
export const wakeKeys = (keywords: Record<string, boolean> | null | undefined) => Object.keys(keywords ?? {}).filter((x) => x.toLowerCase().startsWith(WAKE));

/** The choices of Snooze, as moments, on the person's clock: `toLocal` gives an instant as `YYYY-MM-DDTHH:mm` there and `fromLocal` reads one back (the kit's toZonedInput / fromZonedInput). */
export function snoozeChoices(now: Date, toLocal: (iso: string) => string, fromLocal: (wall: string) => string | null): { id: string; at: Date }[] {
  const wall = toLocal(now.toISOString());
  const [y, m, d] = wall.slice(0, 10).split("-").map(Number) as [number, number, number];
  const hour = Number(wall.slice(11, 13));
  const at = (days: number, h: number) => {
    const day = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    return new Date(fromLocal(`${day}T${String(h).padStart(2, "0")}:00`) ?? now.toISOString());
  };
  const out: { id: string; at: Date }[] = [];
  if (hour < 17) out.push({ id: "later", at: at(0, 18) });
  out.push({ id: "tomorrow", at: at(1, 8) });
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  out.push({ id: "week", at: at((8 - weekday) % 7 || 7, 8) });
  return out;
}
