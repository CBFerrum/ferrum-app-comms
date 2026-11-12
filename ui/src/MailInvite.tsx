// Answering an invitation from the message that brought it, and taking in the answers that come back.
// An invitation to an event in this workspace's calendar (its organiser is a colleague, or the event
// came here before) is answered on that event, which tells its organiser. One from outside goes into
// the person's calendar and its organiser gets an iCalendar REPLY by mail from the person's mailbox.
// A REPLY that arrives for an event the person organised updates that guest's answer on it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleHelp, Clock, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Input, Label, Textarea } from "@ferrum/kit/primitives";
import { toast } from "@ferrum/kit";
import { api, docPath, errorMessage, isolate, t } from "@ferrum/client";
import { CALENDAR } from "./lib/calendar";
import { answersIn, counterIcs, eventOf, ferrumEvent, replyIcs, replyWords, RESPONSE, type PartStat } from "./lib/itip";
import { fromInputIn, toInputIn } from "./lib/calendar";
import { MAIL, byRole, jmap, refusal, useServerDoes, type Mailbox } from "./lib/mail";
import { useIdentities } from "./MailCompose";

interface EventDoc {
  id: string;
  version?: number;
  owner?: string | null;
  subject?: string | null;
  attendees?: { email: string; attendee_name?: string | null; response?: string | null; comment?: string | null }[];
}

/** Events with this UID the person can see (their own, or one they are a guest of). */
async function eventsWithUid(uid: string): Promise<EventDoc[]> {
  const id = ferrumEvent(uid);
  if (id) return [await api.get<EventDoc>(docPath("CalendarEvent", id)).catch(() => null)].filter((e): e is EventDoc => !!e);
  const r = await api.get<{ rows: EventDoc[] }>(docPath("CalendarEvent"), { filters: JSON.stringify([["ical_uid", "=", uid]]), limit: 10 });
  return r.rows ?? [];
}

const KEYWORD: Record<PartStat, string> = { ACCEPTED: "ferrum-rsvp-accepted", TENTATIVE: "ferrum-rsvp-tentative", DECLINED: "ferrum-rsvp-declined" };
const SAID: Record<PartStat, () => string> = { ACCEPTED: () => t("You accepted."), TENTATIVE: () => t("You said maybe."), DECLINED: () => t("You declined.") };

/** Accept, Maybe and Decline under an invitation. */
export function InviteAnswer({ account, emailId, keywords, ics, me, boxes, title }: { account: string; emailId: string; keywords: Record<string, boolean> | null; ics: string; me: string; boxes: Mailbox[]; title: string }) {
  const qc = useQueryClient();
  const identities = useIdentities(account).data;
  const ev = eventOf(ics);
  const mine = new Set([me, ...(identities ?? []).map((i) => i.email)].map((x) => x.toLowerCase()));
  const guest = ev?.attendees.find((a) => mine.has(a.email));
  const organiser = ev?.lines.find((l) => /^ORGANIZER/i.test(l))?.replace(/^.*?:(mailto:)?/i, "").toLowerCase() ?? "";
  const was = (Object.keys(KEYWORD) as PartStat[]).find((k) => keywords?.[KEYWORD[k]]);
  const [answer, setAnswer] = useState<PartStat | null>(was ?? null);
  const [busy, setBusy] = useState<PartStat | null>(null);
  if (!ev || ev.method !== "REQUEST" || !guest || mine.has(organiser)) return null;

  const respond = async (a: PartStat) => {
    setBusy(a);
    try {
      const events = await eventsWithUid(ev.uid);
      // Someone else's event the person can see: they are one of its guests (the server checks).
      const theirs = events.find((e) => !mine.has((e.owner ?? "").toLowerCase()));
      let how: string;
      if (theirs) {
        // The organiser's event is here: answered on it, and they are told in the app.
        await api.post(`${CALENDAR}/events/${theirs.id}/rsvp`, { response: RESPONSE[a] });
        how = t("Your answer is on the event, and its organiser has been told.");
      } else {
        // From outside: into the person's calendar (not when declining), and a REPLY by mail to the organiser.
        if (a !== "DECLINED") await api.post(`${CALENDAR}/import`, { ics });
        await sendReply(account, boxes, ics, a, guest.email, identities?.find((i) => i.email.toLowerCase() === guest.email)?.name ?? null, organiser, title);
        how = a === "DECLINED" ? t("The organiser has been sent your answer.") : t("It is in your calendar, and the organiser has been sent your answer.");
      }
      await jmap([["Email/set", { accountId: account, update: { [emailId]: { ...Object.fromEntries(Object.values(KEYWORD).map((k) => [`keywords/${k}`, null])), [`keywords/${KEYWORD[a]}`]: true } } }, "0"]]);
      setAnswer(a);
      toast(`${SAID[a]()} ${how}`);
      void qc.invalidateQueries({ queryKey: ["calendar"] });
    } catch (e) {
      toast(t("Your answer was not sent: {e}", { e: errorMessage(e) }), "error");
    } finally {
      setBusy(null);
    }
  };
  const choice = (a: PartStat, label: string, Icon: typeof Check) => (
    <Button size="xs" variant={answer === a ? "default" : "outline"} aria-pressed={answer === a} disabled={!!busy} onClick={() => void respond(a)}>
      <Icon aria-hidden="true" /> {busy === a ? t("Sending…") : label}
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 ps-8" role="group" aria-label={t("Your answer to the invitation")}>
      <span className="text-sm text-muted-foreground">{answer ? SAID[answer]() : t("Going?")}</span>
      {choice("ACCEPTED", t("Yes"), Check)}
      {choice("TENTATIVE", t("Maybe"), CircleHelp)}
      {choice("DECLINED", t("No"), X)}
      <ProposeByMail ics={ics} account={account} boxes={boxes} guest={guest} name={identities?.find((i) => i.email.toLowerCase() === guest.email)?.name ?? null} organiser={organiser} title={title} />
    </div>
  );
}

/** "Propose a new time" under an invitation: on the organiser's event when it is in this workspace,
 *  otherwise a COUNTER by mail from the person's mailbox. Nothing moves unless the organiser accepts. */
function ProposeByMail({ ics, account, boxes, guest, name, organiser, title }: { ics: string; account: string; boxes: Mailbox[]; guest: { email: string }; name: string | null; organiser: string; title: string }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ev = eventOf(ics);
  if (!ev) return null;
  const begin = () => {
    // Start from the invitation's own time when it can be read (UTC lines), else from the next hour.
    const at = /DTSTART:(\d{8}T\d{6})Z/.exec(ev.lines.join("\n"))?.[1];
    const first = at ? new Date(`${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)}T${at.slice(9, 11)}:${at.slice(11, 13)}:00Z`) : new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000);
    setStart(toInputIn(first, zone));
    setEnd(toInputIn(new Date(first.getTime() + 3_600_000), zone));
    setOpen(true);
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const a = fromInputIn(start, zone);
    const z = fromInputIn(end, zone);
    if (!a || !z || z <= a) return toast(t("The time must end after it starts."), "error");
    setBusy(true);
    try {
      const events = await eventsWithUid(ev.uid);
      const theirs = events.find((x) => (x.owner ?? "").toLowerCase() === organiser);
      if (theirs) await api.post(`${CALENDAR}/events/${theirs.id}/propose`, { start: a.toISOString(), end: z.toISOString(), note: note.trim() || undefined });
      else {
        const counter = counterIcs(ics, { email: guest.email, name }, a, z, note);
        if (!counter) throw new Error(t("This invitation cannot be answered by mail."));
        await sendMail(account, boxes, guest.email, name, organiser, `New time proposed: ${title}`, `${name || guest.email} proposes ${a.toUTCString()}${note.trim() ? `: ${note.trim()}` : ""}`, counter, "COUNTER");
      }
      toast(t("Your proposal was sent. Nothing moves unless the organiser accepts it."));
      setOpen(false);
    } catch (err) {
      toast(t("Not sent: {e}", { e: errorMessage(err) }), "error");
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <Button size="xs" variant="ghost" onClick={begin}>
        <Clock aria-hidden="true" /> {t("Propose a new time")}
      </Button>
    );
  return (
    <form onSubmit={send} className="flex w-full flex-wrap items-end gap-2" aria-label={t("Propose a new time")}>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-s`}>{t("Starts")}</Label>
        <Input id={`${id}-s`} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-e`}>{t("Ends")}</Label>
        <Input id={`${id}-e`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <Textarea className="min-h-0 w-full" rows={1} maxLength={500} value={note} aria-label={t("A note for the organiser")} placeholder={t("A note for the organiser (optional)")} onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" size="xs" disabled={busy}>
        {busy ? t("Sending…") : t("Send proposal")}
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
        {t("Cancel")}
      </Button>
    </form>
  );
}

/** The REPLY by mail, from the person's mailbox to the organiser: words for people, the calendar part for their calendar. */
async function sendReply(account: string, boxes: Mailbox[], ics: string, a: PartStat, email: string, name: string | null, organiser: string, title: string) {
  const reply = replyIcs(ics, { email, name }, a);
  if (!reply) throw new Error(t("This invitation cannot be answered by mail."));
  const subject = { ACCEPTED: `Accepted: ${title}`, TENTATIVE: `Tentatively accepted: ${title}`, DECLINED: `Declined: ${title}` }[a];
  await sendMail(account, boxes, email, name, organiser, subject, replyWords(a, name || email, title), reply, "REPLY");
}

/** A calendar answer (REPLY or COUNTER) by mail, from the person's mailbox to the organiser. */
async function sendMail(account: string, boxes: Mailbox[], email: string, name: string | null, organiser: string, subject: string, words: string, part: string, method: "REPLY" | "COUNTER") {
  const drafts = byRole(boxes, "drafts");
  const sent = byRole(boxes, "sent");
  if (!drafts || !sent || !organiser) throw new Error(t("This invitation cannot be answered by mail."));
  const ident = ((await jmap([["Identity/get", { accountId: account }, "0"]]))["0"].list as { id: string; email: string }[]).find((i) => i.email.toLowerCase() === email) ;
  if (!ident) throw new Error(t("The mailbox has no address to write as."));
  const r = await jmap([
    [
      "Email/set",
      {
        accountId: account,
        create: {
          m: {
            mailboxIds: { [drafts.id]: true },
            keywords: { $seen: true, $draft: true },
            from: [name ? { name, email } : { email }],
            to: [{ email: organiser }],
            subject,
            bodyValues: { t: { value: words }, c: { value: part } },
            bodyStructure: { type: "multipart/alternative", subParts: [{ partId: "t", type: "text/plain" }, { partId: "c", type: `text/calendar; method=${method}` }] },
          },
        },
      },
      "0",
    ],
    ["EmailSubmission/set", { accountId: account, create: { s: { emailId: "#m", identityId: ident.id } }, onSuccessUpdateEmail: { "#s": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } } }, "1"],
  ]);
  const refused = (r["0"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.m ?? (r["1"].notCreated as Record<string, { type?: string; description?: string }> | undefined)?.s;
  if (refused) {
    // Nothing half-done is left behind: the answer that could not go is not kept in Drafts.
    const made = (r["0"].created as Record<string, { id: string }> | undefined)?.m;
    if (made) await jmap([["Email/set", { accountId: account, destroy: [made.id] }, "0"]]).catch(() => undefined);
    throw new Error(refusal(refused));
  }
}

/**
 * A REPLY to an event the person organised: who answered what, put on the event once (the message is
 * marked so it is not applied again), and said on the card. Events from elsewhere are left alone.
 * A server with `itip` applies it itself (the same code as when it arrives with no tab open: only the
 * sender's own answer, and only when they are invited); an older one is applied from here.
 */
export function ReplyCard({ account, emailId, keywords, ics, me }: { account: string; emailId: string; keywords: Record<string, boolean> | null; ics: string; me: string }) {
  const qc = useQueryClient();
  const got = answersIn(ics);
  const applied = !!keywords?.["ferrum-rsvp-applied"];
  const done = useRef(false);
  const server = useServerDoes("itip");
  const result = useQuery({
    queryKey: ["mail", "rsvp-apply", account, emailId, server],
    enabled: !!got?.answers.length,
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<"updated" | "same" | "none" | "refused" | "unsupported" | "unverified" | "no-organizer"> => {
      if (server) {
        const r = await api.post<{ result: "updated" | "same" | "none" | "refused" | "unsupported" | "unverified" | "no-organizer" }>(`${MAIL}/itip`, { account, email: emailId });
        if (r.result === "updated") void qc.invalidateQueries({ queryKey: ["calendar"] });
        return r.result === "updated" ? "same" : r.result;
      }
      const found = (await eventsWithUid(got!.uid)).find((e) => (e.owner ?? "").toLowerCase() === me.toLowerCase());
      if (!found) return "none";
      // A list gives no guests: the event itself does.
      const own = await api.get<EventDoc>(docPath("CalendarEvent", found.id));
      const list = own.attendees ?? [];
      let changed = false;
      const next = list.map((x) => {
        const said = got!.answers.find((y) => y.email === x.email.toLowerCase());
        if (!said || x.response === said.response) return x;
        changed = true;
        return { ...x, response: said.response };
      });
      if (changed && !applied) await api.patch(docPath("CalendarEvent", own.id), { attendees: next }, own.version !== undefined ? { ifMatch: own.version } : undefined);
      return changed && !applied ? "updated" : "same";
    },
  });
  useEffect(() => {
    if (done.current || result.data !== "updated") return;
    done.current = true;
    void jmap([["Email/set", { accountId: account, update: { [emailId]: { "keywords/ferrum-rsvp-applied": true } } }, "0"]]).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["calendar"] });
  }, [result.data, account, emailId, qc]);
  if (!got?.answers.length) return null;
  const words = { Accepted: t("accepted"), Tentative: t("might attend"), Declined: t("declined") };
  return (
    <p className="flex flex-wrap items-center gap-x-2 rounded-md border bg-muted px-3 py-2 text-sm" role="status">
      <span>{got.answers.map((a) => `${a.name || a.email} ${words[a.response]}`).map(isolate).join("; ")}.</span>
      <span className="text-muted-foreground">
        {result.isLoading
          ? t("Updating your calendar…")
          : result.error
            ? t("Your calendar could not be updated: {e}", { e: errorMessage(result.error) })
            : result.data === "none"
              ? t("This event is not in your calendar.")
              : result.data === "refused"
                ? t("Not applied: the sender is not on this event's guest list.")
                : result.data === "unverified"
                  ? t("Not applied: the sender could not be verified.")
                : result.data === "unsupported"
                  ? t("Your calendar does not take this kind of answer from mail.")
                  : t("Your calendar shows this answer.")}
      </span>
    </p>
  );
}

/** A COUNTER (a guest proposing another time) for an event the person organises: what became of it.
 *  The server keeps it as a proposal on the event when it arrives (or now, the same code), only from
 *  an invited guest whose mail the server vouches for; the organiser answers it in Calendar. */
export function CounterCard({ account, emailId }: { account: string; emailId: string }) {
  const server = useServerDoes("itip");
  const result = useQuery({
    queryKey: ["mail", "counter", account, emailId],
    enabled: server,
    staleTime: Infinity,
    retry: false,
    queryFn: () => api.post<{ result: string }>(`${MAIL}/itip`, { account, email: emailId }).then((r) => r.result),
  });
  if (!server) return null;
  const said: Record<string, string> = {
    updated: t("This proposal is on the event in your calendar: accept or decline it there."),
    same: t("This proposal is on the event in your calendar: accept or decline it there."),
    none: t("This event is not in your calendar."),
    refused: t("Not recorded: the sender is not on this event's guest list."),
    unverified: t("Not recorded: the sender could not be verified."),
    unsupported: t("This proposal could not be read."),
  };
  return (
    <p className="rounded-md border bg-muted px-3 py-2 text-sm" role="status">
      {result.isLoading ? t("Checking your calendar…") : result.error ? t("Your calendar could not be checked: {e}", { e: errorMessage(result.error) }) : (said[result.data ?? ""] ?? t("This proposal could not be read."))}
    </p>
  );
}
