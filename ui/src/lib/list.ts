// How a line of the list and the reader's sender line read: who, and when.

import { formatDateTime, formatMoment, shownTimeZone, t as tr } from "@ferrum/client";
import type { Address } from "./mail";

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Who a line shows: the sender's name (never the bare address when there is a name), "me" for the person, the recipients in Sent and Drafts. */
export function senderLabel(from: Address[] | null | undefined, to: Address[] | null | undefined, me: string, outgoing: boolean): string {
  const name = (a: Address) => (sameAddress(a.email, me) ? tr("me") : a.name?.trim() || a.email);
  if (outgoing) return (to ?? []).length ? tr("To: {value}", { value: (to ?? []).map(name).join(", ") }) : tr("(no recipients)");
  const a = from?.[0];
  return a ? name(a) : tr("(unknown sender)");
}

const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: shownTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** The date of a line: the time today, the weekday within the week, day and month this year, the year too before. In the person's language and time zone. */
export function listDate(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const days = Math.round((Date.parse(day(now)) - Date.parse(day(t))) / 86_400_000);
  if (days === 0) return formatMoment(iso, { hour: "numeric", minute: "2-digit" });
  if (days > 0 && days < 7) return formatMoment(iso, { weekday: "short" });
  if (day(now).slice(0, 4) === day(t).slice(0, 4)) return formatMoment(iso, { day: "numeric", month: "short" });
  return formatMoment(iso, { day: "numeric", month: "short", year: "numeric" });
}

/** The tooltip of a date: the whole moment. */
export const fullDate = (iso: string) => formatDateTime(iso);

/**
 * The reader's "to me, Omar, +2": who it went to, the person first as "me", at most two others by
 * name, then how many more. `all` lists every recipient with its address (the expanded view).
 */
export function recipientsLine(to: Address[] | null | undefined, cc: Address[] | null | undefined, me: string): string {
  const all = [...(to ?? []), ...(cc ?? [])];
  const mine = all.filter((a) => sameAddress(a.email, me));
  const others = all.filter((a) => !sameAddress(a.email, me)).map((a) => a.name?.trim() || a.email);
  const names = [...(mine.length ? [tr("me")] : []), ...others.slice(0, mine.length ? 1 : 2)];
  const rest = all.length - names.length;
  return tr("to {value}", { value: names.join(", ") || "—" }) + (rest > 0 ? tr(", +{n}", { n: rest }) : "");
}

/** "Name <address>" for the reader. */
export const nameAndAddress = (a: Address | undefined | null) => (a ? (a.name?.trim() ? `${a.name.trim()} <${a.email}>` : a.email) : "");
