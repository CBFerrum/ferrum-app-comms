// Writing an event, and finding a time for it: the form on one side; on the other, when each guest
// is busy that day (only that they are, never why), the times that suit everyone, and a warning
// when the one chosen does not. Guests are colleagues (picked from the workspace) or outside
// addresses, who are sent the invitation by email with a link to answer it. Only the organizer edits.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, X } from "lucide-react";
import { useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Badge, Button, Input, Label, Skeleton, Textarea } from "@ferrum/kit/primitives";
import { Alert, confirmDialog, EmptyState, ErrorState, PageLoading, toast, useShellTitle } from "@ferrum/kit";
import { api, docPath, errorMessage, t } from "@ferrum/client";
import { useMe, usePeople } from "@ferrum/records";
import { matchPeople, type Person } from "./lib/chat";
import {
  CALENDAR,
  REMINDERS,
  REPEATS,
  answerWord,
  bars,
  clashes,
  fromInput,
  isoDay,
  mergeGuests,
  nextHour,
  parseGuests,
  reminderOf,
  repeatOf,
  ruleFor,
  stretch,
  suggestSlots,
  tally,
  toInput,
  type Busy,
  type BusyMap,
  type Guest,
  type Repeat,
} from "./lib/calendar";
import { meetLink, meetPath, useMeetAvailable } from "./lib/meet";

/** An event as the records API gives it. */
interface EventDoc {
  id: string;
  version: number;
  subject: string;
  starts_at: string;
  ends_at: string;
  all_day?: boolean;
  location?: string | null;
  meeting_link?: string | null;
  description?: string | null;
  owner?: string | null;
  visibility?: string | null;
  status?: string | null;
  recurrence?: string | null;
  attendees?: { email: string; attendee_name?: string | null; response?: string; comment?: string | null }[];
  reminders?: { minutes_before: number }[];
}

/** `/calendar/e/{id}`: the editor for the organizer; for a guest, the event opened in Calendar to be answered. `new` starts one. */
export function EventPage() {
  const { event = "new" } = useParams();
  const me = useMe().data?.user.email.toLowerCase();
  const [params] = useSearchParams();
  const doc = useQuery({ queryKey: ["calendar", "event", event], queryFn: ({ signal }) => api.get<EventDoc>(docPath("CalendarEvent", event), undefined, signal), enabled: event !== "new", gcTime: 0, retry: false });
  useShellTitle(event === "new" ? "New event" : "Edit event");
  if (event === "new") return me ? <Editor key="new" me={me} params={params} /> : <PageLoading />;
  if (doc.error) {
    return (
      <EmptyState title={t("That event is not available")} icon="calendar">
        <p className="text-sm text-muted-foreground">{t("It was deleted, or it is not on your calendar.")}</p>
        <Link className="text-primary underline" to="/calendar">
          {t("Go to Calendar")}
        </Link>
      </EmptyState>
    );
  }
  if (!doc.data || !me) return <PageLoading />;
  // A guest does not edit: the event opens in Calendar, where they answer.
  if (doc.data.owner?.toLowerCase() !== me) return <Navigate to={`/calendar?event=${event}${params.get("at") ? `&at=${encodeURIComponent(params.get("at")!)}` : ""}`} replace />;
  return <Editor key={doc.data.id + doc.data.version} me={me} doc={doc.data} params={params} />;
}

const DAY = 86_400_000;
const dayWord = (d: Date) => d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
/** The hours the day's grid shows. */
const FROM = 7;
const TO = 20;

function Editor({ me, doc, params }: { me: string; doc?: EventDoc; params: URLSearchParams }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const people = usePeople().data?.users ?? [];
  const meet = useMeetAvailable().data === true;
  const existing = !!doc;
  const first = useMemo(() => {
    const at = (v: string | null | undefined) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
    const starts = at(doc?.starts_at) ?? at(params.get("starts_at")) ?? nextHour();
    const ends = at(doc?.ends_at) ?? at(params.get("ends_at")) ?? new Date(starts.getTime() + 3_600_000);
    return { starts, ends: ends > starts ? ends : new Date(starts.getTime() + 3_600_000) };
  }, [doc, params]);
  const rule = repeatOf(doc?.recurrence);
  const remind = reminderOf((doc?.reminders ?? []).map((r) => r.minutes_before));
  const [subject, setSubject] = useState(doc?.subject ?? params.get("subject") ?? "");
  const [allDay, setAllDay] = useState(!!doc?.all_day);
  // All-day events are shown by date (the last day included), timed ones by date and time.
  const [start, setStart] = useState(() => (doc?.all_day ? doc.starts_at.slice(0, 10) : toInput(first.starts)));
  const [end, setEnd] = useState(() => (doc?.all_day ? new Date(Date.parse(doc.ends_at) - DAY).toISOString().slice(0, 10) : toInput(first.ends)));
  const [location, setLocation] = useState(doc?.location ?? "");
  const [description, setDescription] = useState(doc?.description ?? "");
  const [repeat, setRepeat] = useState<Repeat>(rule.kind);
  const [until, setUntil] = useState(rule.until);
  const [reminder, setReminder] = useState<number | "none" | "custom">(remind);
  const [visibility, setVisibility] = useState(doc?.visibility ?? "Private");
  const [guests, setGuests] = useState<string[]>((doc?.attendees ?? []).map((a) => a.email.toLowerCase()));
  const [typed, setTyped] = useState("");
  const link = doc?.meeting_link ?? null;
  const hasCall = !!meetPath(link);
  const [call, setCall] = useState(hasCall);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const answers = new Map((doc?.attendees ?? []).map((a) => [a.email.toLowerCase(), a]));
  const replies = tally((doc?.attendees ?? []).map((a) => ({ response: a.response ?? "Needs Action" })));
  const names = Object.fromEntries(people.map((p) => [p.email.toLowerCase(), p.full_name || undefined]));
  const colleague = (email: string) => !!names[email.toLowerCase()] || people.some((p) => p.email.toLowerCase() === email.toLowerCase());
  const when = useMemo(() => {
    if (allDay) {
      const a = fromInput(start.slice(0, 10));
      const z = fromInput(end.slice(0, 10));
      return a && z ? { starts: a, ends: new Date(z.getFullYear(), z.getMonth(), z.getDate() + 1) } : null;
    }
    const a = fromInput(start);
    const z = fromInput(end);
    return a && z ? { starts: a, ends: z } : null;
  }, [allDay, start, end]);
  const minutes = when ? Math.max(15, Math.round((when.ends.getTime() - when.starts.getTime()) / 60_000)) : 60;

  // Free and busy: me and the colleagues invited, for the day shown and a week on from it (this
  // event's own time left out, or its organizer would clash with it).
  const insiders = [...new Set([me, ...guests.filter(colleague)])];
  const shownDay = when ? isoDay(when.starts) : isoDay(new Date());
  const day = useMemo(() => fromInput(shownDay) ?? new Date(), [shownDay]);
  const week = useQuery({
    queryKey: ["calendar", "busy", insiders.join(","), shownDay, doc?.id],
    queryFn: ({ signal }) =>
      api
        .post<{ busy: BusyMap }>(`${CALENDAR}/freebusy`, { users: insiders.slice(0, 50), from: day.toISOString(), to: new Date(day.getTime() + 8 * DAY).toISOString(), exclude: doc?.id }, { signal })
        .then((r) => r.busy),
    enabled: !allDay && !!when,
    staleTime: 60_000,
  });
  const others: BusyMap = week.data ?? {};

  const set = (v: Date) => {
    const length = when ? when.ends.getTime() - when.starts.getTime() : 3_600_000;
    setStart(toInput(v));
    setEnd(toInput(new Date(v.getTime() + length)));
  };
  const addGuests = (text: string) => {
    const got = parseGuests(text);
    if (got.bad.length) setProblem(`Not an email address: ${got.bad.join(", ")}`);
    else setProblem(null);
    if (got.emails.length) setGuests((g) => [...g, ...got.emails.filter((e) => !g.includes(e) && e !== me)]);
    setTyped(got.bad.join(" "));
  };

  const mistakes: string[] = [];
  if (!subject.trim()) mistakes.push("Give the event a title.");
  if (!when) mistakes.push("Check the dates.");
  else if (when.ends <= when.starts) mistakes.push("The event must end after it starts.");

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const left = typed.trim() ? parseGuests(typed) : { emails: [] as string[], bad: [] as string[] };
    if (left.bad.length) return setProblem(`Not an email address: ${left.bad.join(", ")}. Fix it or take it out.`);
    if (mistakes.length || !when) return setProblem(mistakes.join(" "));
    const list = [...new Set([...guests, ...left.emails.filter((x) => x !== me)])];
    const sameDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const body: Record<string, unknown> = {
      subject: subject.trim(),
      starts_at: allDay ? new Date(sameDay(when.starts)).toISOString() : when.starts.toISOString(),
      ends_at: allDay ? new Date(sameDay(when.ends)).toISOString() : when.ends.toISOString(),
      all_day: allDay,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      location: location.trim() || null,
      description: description.trim() || null,
      visibility,
      attendees: mergeGuests((doc?.attendees ?? []).map((a) => ({ email: a.email, name: a.attendee_name, response: a.response ?? "Needs Action", comment: a.comment })) as Guest[], list, names),
    };
    if (repeat !== "custom") body.recurrence = ruleFor(repeat, until);
    if (reminder !== "custom") body.reminders = reminder === "none" ? [] : [{ minutes_before: reminder }];
    if (existing && !call && hasCall) body.meeting_link = null;
    if (doc && call && !hasCall && !link) body.meeting_link = meetLink("event", doc.id);
    setBusy(true);
    setProblem(null);
    try {
      let id = doc?.id;
      if (doc) await api.patch(docPath("CalendarEvent", doc.id), body, { ifMatch: doc.version });
      else {
        const made = await api.post<{ id: string; version?: number }>(docPath("CalendarEvent"), body);
        id = made.id;
        if (call) await api.patch(docPath("CalendarEvent", made.id), { meeting_link: meetLink("event", made.id) }, made.version ? { ifMatch: made.version } : undefined);
      }
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      toast(existing ? "Event saved" : list.length ? "Event saved. Your guests were told." : "Event saved");
      navigate(`/calendar?event=${id}&at=${encodeURIComponent(when.starts.toISOString())}`);
    } catch (err) {
      setProblem(`Not saved: ${errorMessage(err)}`);
      setBusy(false);
    }
  };
  const cancelEvent = async () => {
    if (!doc) return;
    const on = doc.status !== "Cancelled";
    if (!(await confirmDialog({ title: on ? "Cancel this event?" : "Bring this event back?", message: on ? "Your guests are told it is cancelled. It stays on the calendar, struck through." : "Your guests are told it is on again.", confirmLabel: on ? "Cancel the event" : "Bring it back", danger: on }))) return;
    try {
      await api.patch(docPath("CalendarEvent", doc.id), { status: on ? "Cancelled" : "Confirmed" }, { ifMatch: doc.version });
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      navigate("/calendar");
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };
  const remove = async () => {
    if (!doc) return;
    if (!(await confirmDialog({ title: "Delete this event?", message: "It goes from every calendar, and your guests are told it is cancelled.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.del(docPath("CalendarEvent", doc.id));
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      toast(t("Event deleted"));
      navigate("/calendar");
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  const clash = when && !allDay ? clashes(others, when.starts, when.ends) : [];
  const nameOf = (email: string) => (email === me ? "You" : names[email] || email);
  const suggestions = useMemo(() => (allDay || !week.data ? [] : suggestSlots(week.data, { from: new Date(Math.max(Date.now(), day.getTime())), days: 8, minutes })), [allDay, week.data, minutes, day]);

  return (
    <form onSubmit={save} className="mx-auto grid max-w-5xl gap-6 p-4 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]">
      <div className="grid content-start gap-4">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label={t("Back to Calendar")}>
            <Link to="/calendar">
              <ArrowLeft />
            </Link>
          </Button>
          <h1 className="flex-1 text-lg font-semibold">{existing ? "Edit event" : "New event"}</h1>
        </div>
        {problem && (
          <Alert tone="error">
            <span>{problem}</span>
          </Alert>
        )}
        {doc?.status === "Cancelled" && (
          <Alert tone="warning">
            <span>{t("This event is cancelled. Guests were told. Saving changes does not bring it back.")}</span>
          </Alert>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="ev-subject">{t("Title")}</Label>
          <Input id="ev-subject" autoFocus={!existing} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => {
              const on = e.target.checked;
              setAllDay(on);
              // The dates carry over; the times come back at the hour they were.
              if (on) {
                setStart(start.slice(0, 10));
                setEnd(end.slice(0, 10));
              } else if (when) {
                const s = new Date(when.starts.getFullYear(), when.starts.getMonth(), when.starts.getDate(), 9);
                setStart(toInput(s));
                setEnd(toInput(new Date(s.getTime() + 3_600_000)));
              }
            }}
          />{" "}
          {t("All day")}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ev-start">{allDay ? "First day" : "Starts"}</Label>
            <Input
              id="ev-start"
              type={allDay ? "date" : "datetime-local"}
              value={start}
              onChange={(e) => {
                const a = fromInput(e.target.value);
                if (a && when && !allDay) set(a);
                else setStart(e.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ev-end">{allDay ? "Last day" : "Ends"}</Label>
            <Input id="ev-end" type={allDay ? "date" : "datetime-local"} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        {clash.length > 0 && when && (
          <p role="status" className="rounded-md border border-warning bg-warning-soft px-3 py-2 text-sm">
            {clash.map((who) => `${nameOf(who)} (${(others[who] ?? []).filter((b) => Date.parse(b.start) < when.ends.getTime() && Date.parse(b.end) > when.starts.getTime()).map(stretch).join(", ")})`).join(" and ")}{" "}
            {clash.length === 1 ? "is" : "are"} {t("busy then. The times that suit everyone are on the right.")}
          </p>
        )}
        <p className="-mt-2 text-xs text-muted-foreground">{t("Times are in your time zone, {timeZone}. Guests see them in theirs.", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ev-repeat">{t("Repeats")}</Label>
            <select id="ev-repeat" className="h-9 rounded-md border bg-background px-2 text-sm" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
              {REPEATS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
              {repeat === "custom" && <option value="custom">{t("Custom (kept as it is)")}</option>}
            </select>
          </div>
          {repeat !== "none" && repeat !== "custom" && (
            <div className="grid gap-1.5">
              <Label htmlFor="ev-until">{t("Until (optional)")}</Label>
              <Input id="ev-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
          )}
        </div>
        {repeat !== "none" && existing && <p className="-mt-2 text-xs text-muted-foreground">{t("Changes apply to every time it repeats.")}</p>}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t("Guests")}</legend>
          {guests.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">{replies ? `So far: ${replies}.` : `${guests.length} invited. Colleagues are told in Ferrum, others by email.`}</p>
              <ul className="flex flex-wrap gap-1.5" aria-label={t("Guests")}>
                {guests.map((g) => (
                  <li key={g}>
                    <Badge variant="secondary" className="h-7 gap-1.5 pl-2.5">
                      <span>{names[g] || g}</span>
                      {!colleague(g) && <span className="text-muted-foreground">outside</span>}
                      {answers.has(g) && <span className="text-muted-foreground">· {answerWord(answers.get(g)?.response)}</span>}
                      <button type="button" aria-label={`Remove ${names[g] || g}`} className="grid size-5 place-items-center rounded-full hover:bg-background" onClick={() => setGuests((x) => x.filter((y) => y !== g))}>
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
          <GuestInput people={people} taken={[me, ...guests]} typed={typed} setTyped={setTyped} add={addGuests} />
        </fieldset>
        <div className="grid gap-1.5">
          <Label htmlFor="ev-where">{t("Where")}</Label>
          <Input id="ev-where" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />
        </div>
        {meet ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={call} disabled={!!link && !hasCall} onChange={(e) => setCall(e.target.checked)} /> {t("Add a video meeting")}
          </label>
        ) : hasCall ? (
          <p className="text-sm text-muted-foreground">{t("It has a video meeting, but meetings are not set up on this server, so nobody can join it.")}</p>
        ) : null}
        {link && !hasCall && (
          <p className="break-all text-sm">
            {t("Meeting link:")} <a className="text-primary underline" href={link} target="_blank" rel="noopener noreferrer">{link}</a>
          </p>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="ev-notes">{t("Notes")}</Label>
          <Textarea id="ev-notes" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ev-remind">{t("Reminder")}</Label>
            <select
              id="ev-remind"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={String(reminder)}
              onChange={(e) => setReminder(e.target.value === "none" || e.target.value === "custom" ? e.target.value : Number(e.target.value))}
            >
              <option value="none">{t("None")}</option>
              {REMINDERS.map((r) => (
                <option key={r.minutes} value={r.minutes}>
                  {r.label}
                </option>
              ))}
              {reminder === "custom" && <option value="custom">{t("Several (kept as they are)")}</option>}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ev-visible">{t("Who sees it")}</Label>
            <select id="ev-visible" className="h-9 rounded-md border bg-background px-2 text-sm" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="Private">{t("Only you and your guests (others see busy time)")}</option>
              <option value="Public">{t("Everyone in the workspace")}</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : existing ? "Save" : guests.length ? "Save and invite" : "Save"}
          </Button>
          <Button asChild variant="outline">
            <Link to="/calendar">{t("Cancel")}</Link>
          </Button>
          <span className="flex-1" />
          {doc && (
            <>
              <Button type="button" variant="ghost" onClick={() => void cancelEvent()}>
                {doc.status === "Cancelled" ? "Bring it back" : "Cancel the event"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => void remove()}>
                {t("Delete")}
              </Button>
              <Button asChild variant="link" size="sm">
                <a href={`/data/e/CalendarEvent/${doc.id}`}>{t("More options")}</a>
              </Button>
            </>
          )}
        </div>
      </div>
      <aside className="grid content-start gap-3" aria-label={t("Find a time")}>
        <h2 className="font-semibold">{t("Find a time")}</h2>
        {allDay ? (
          <p className="text-sm text-muted-foreground">{t("An all-day event has no time to find.")}</p>
        ) : (
          <FindTime day={day} insiders={insiders} outsiders={guests.filter((g) => !colleague(g))} names={names} me={me} busy={others} loading={week.isLoading} error={week.error} retry={() => void week.refetch()} when={when} suggestions={suggestions} onPick={set} onDay={(d) => set(new Date(d.getFullYear(), d.getMonth(), d.getDate(), when?.starts.getHours() ?? 9, when?.starts.getMinutes() ?? 0))} />
        )}
      </aside>
    </form>
  );
}

/** Colleagues offered by name, any address accepted; Enter, a comma or a space adds it. */
function GuestInput({ people, taken, typed, setTyped, add }: { people: Person[]; taken: string[]; typed: string; setTyped: (v: string) => void; add: (text: string) => void }) {
  const choices = typed.trim().length > 0 ? matchPeople(people.filter((p) => !taken.includes(p.email.toLowerCase())), typed.trim(), undefined, 5) : [];
  return (
    <div className="relative grid gap-1.5">
      <Label htmlFor="ev-guest" className="sr-only">
        {t("Add a guest")}
      </Label>
      <div className="flex gap-2">
        <Input
          id="ev-guest"
          value={typed}
          autoComplete="off"
          placeholder={t("Add a colleague by name, or anyone by email")}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && typed.trim()) {
              e.preventDefault();
              if (e.key === "Enter" && choices[0] && !typed.includes("@")) add(choices[0].email);
              else add(typed);
            }
          }}
        />
        <Button type="button" variant="outline" size="icon" aria-label={t("Add guest")} disabled={!typed.trim()} onClick={() => add(choices[0] && !typed.includes("@") ? choices[0].email : typed)}>
          <Plus />
        </Button>
      </div>
      {choices.length > 0 && (
        <ul className="rounded-md border bg-popover p-1 shadow-sm" aria-label={t("People to invite")}>
          {choices.map((p) => (
            <li key={p.id}>
              <button type="button" className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:min-h-11" onClick={() => add(p.email)}>
                <span className="font-medium">{p.full_name || p.email}</span>
                <span className="truncate text-xs text-muted-foreground">{p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindTime(p: {
  day: Date;
  insiders: string[];
  outsiders: string[];
  names: Record<string, string | undefined>;
  me: string;
  busy: BusyMap;
  loading: boolean;
  error: unknown;
  retry: () => void;
  when: { starts: Date; ends: Date } | null;
  suggestions: Date[];
  onPick: (at: Date) => void;
  onDay: (d: Date) => void;
}) {
  const hours = Array.from({ length: (TO - FROM) / 2 + 1 }, (_, i) => FROM + i * 2);
  const span = (TO - FROM) * 3_600_000;
  const base = new Date(p.day.getFullYear(), p.day.getMonth(), p.day.getDate(), FROM).getTime();
  const shade = p.when ? { left: Math.max(0, ((p.when.starts.getTime() - base) / span) * 100), width: Math.min(100, ((p.when.ends.getTime() - p.when.starts.getTime()) / span) * 100) } : null;
  const step = (n: number) => p.onDay(new Date(p.day.getFullYear(), p.day.getMonth(), p.day.getDate() + n));
  const label = (email: string) => (email === p.me ? "You" : p.names[email] || email);
  const pick = (e: MouseEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const minutes = Math.round((((e.clientX - box.left) / box.width) * (TO - FROM) * 60) / 30) * 30;
    p.onPick(new Date(p.day.getFullYear(), p.day.getMonth(), p.day.getDate(), FROM, minutes));
  };
  const said = (list: Busy[] | undefined) => (list?.length ? `busy ${list.map(stretch).join(", ")}` : "free");
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon-sm" aria-label={t("Previous day")} onClick={() => step(-1)}>
          <ArrowLeft />
        </Button>
        <span className="flex-1 text-center font-medium">{dayWord(p.day)}</span>
        <Button type="button" variant="outline" size="icon-sm" aria-label={t("Next day")} onClick={() => step(1)}>
          <ArrowLeft className="rotate-180" />
        </Button>
      </div>
      {p.loading ? (
        <Skeleton className="h-24" />
      ) : p.error ? (
        <ErrorState error={p.error} onRetry={p.retry} title={t("Their calendars could not be read")} />
      ) : (
        <div className="grid gap-1">
          <div className="relative ml-24 h-4 text-[10px] text-muted-foreground" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${((h - FROM) / (TO - FROM)) * 100}%` }}>
                {new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })}
              </span>
            ))}
          </div>
          <div className="relative grid gap-1">
            {p.insiders.map((who) => (
              <div key={who} className="flex items-center gap-2">
                <span className="w-22 shrink-0 truncate text-xs" title={who}>
                  {label(who)}
                </span>
                <div
                  className="relative h-6 flex-1 cursor-pointer overflow-hidden rounded bg-muted"
                  role="img"
                  aria-label={`${label(who)}: ${said(p.busy[who])} on ${dayWord(p.day)}`}
                  onClick={pick}
                >
                  {bars(p.busy[who] ?? [], p.day, FROM, TO).map((b, i) => (
                    <span key={i} className="absolute inset-y-0 bg-muted-foreground/50" style={{ left: `${b.left}%`, width: `${b.width}%` }} />
                  ))}
                  {shade && <span className="pointer-events-none absolute inset-y-0 border-x-2 border-primary bg-primary/20" style={{ left: `${shade.left}%`, width: `${shade.width}%` }} />}
                </div>
              </div>
            ))}
            {p.outsiders.map((who) => (
              <div key={who} className="flex items-center gap-2 text-muted-foreground">
                <span className="w-22 shrink-0 truncate text-xs" title={who}>
                  {who}
                </span>
                <span className="text-xs">{t("Outside your workspace: when they are free is not known.")}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("Grey is busy time (never what it is). Click a row to move the event there.")}</p>
        </div>
      )}
      <div className="grid gap-1.5">
        <h3 className="font-medium">{t("Times that suit")} {p.insiders.length > 1 ? "everyone" : "you"}</h3>
        {p.suggestions.length === 0 && !p.loading ? (
          <p className="text-muted-foreground">{t("No time in the next week (working days, 9 to 6) suits")} {p.insiders.length > 1 ? "everyone" : "you"} {t("for this long. Try a shorter event.")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("Suggested times")}>
            {p.suggestions.map((s) => (
              <li key={s.getTime()}>
                <Button type="button" size="sm" variant={p.when && s.getTime() === p.when.starts.getTime() ? "secondary" : "outline"} onClick={() => p.onPick(s)}>
                  {s.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, {s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
