// The calendar on the Mail app's calendar API: my events, invitations and public events with
// recurrences expanded by the server, as a month grid or a week of hours (an agenda on phones),
// with answers to invitations (and a note with them). Events I organize move by dragging them to
// another day or time, or by their editor (CalendarEditor.tsx), where times are found for everyone.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus, Repeat, Video } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Badge } from "@ferrum/kit/primitives";
import { Button } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { Textarea } from "@ferrum/kit/primitives";
import { api, docPath, errorMessage, t } from "@ferrum/client";
import { meetLink, meetPath, openCall, useMeetAvailable } from "./lib/meet";
import { answerWord, byDay, CALENDAR, isoDay, monthGrid, movable, moved, placeDay, safeColor, safeLink, sameTimeOn, tally, weekOf, type Guest, type Occurrence } from "./lib/calendar";
import { useLiveEntity } from "@ferrum/kit";
import { cn } from "@ferrum/kit";
import { ErrorState, toast } from "@ferrum/kit";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const longDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
/** Week grid: pixels per hour. */
const HOUR = 48;
/** Drag data: the dragged occurrence's id. */
const DRAG = "application/x-ferrum-occurrence";
const VIEW_KEY = "ferrum.calendar.view";

type View = "month" | "week";

/** The editor for a new event of an hour from `start` (Calendar's own, with times found for everyone). */
const newEventAt = (start: Date) => {
  const end = new Date(start.getTime() + 3_600_000);
  return `/calendar/e/new?starts_at=${encodeURIComponent(start.toISOString())}&ends_at=${encodeURIComponent(end.toISOString())}`;
};
/** The editor for a new event on a day, 09:00 to 10:00 local time. */
const newEventLink = (day: string) => newEventAt(new Date(`${day}T09:00:00`));

/** Accepts a dragged occurrence: `onDrop` gets its id. */
const dropTarget = (onDrop: (id: string, e: DragEvent<HTMLElement>) => void) => ({
  onDragOver: (e: DragEvent<HTMLElement>) => {
    if (e.dataTransfer.types.includes(DRAG)) e.preventDefault();
  },
  onDrop: (e: DragEvent<HTMLElement>) => {
    const id = e.dataTransfer.getData(DRAG);
    if (!id) return;
    e.preventDefault();
    onDrop(id, e);
  },
});

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "week" ? "week" : "month";
  } catch {
    return "month";
  }
}

export function CalendarPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [view, setViewState] = useState<View>(savedView);
  // A link to an event (`?event={id}&at={start}`: Home's My work, a notification) opens it.
  const [params, setParams] = useSearchParams();
  const wanted = params.get("event");
  const wantedAt = params.get("at");
  const [anchor, setAnchor] = useState(() => {
    const at = wantedAt ? new Date(wantedAt) : null;
    return at && !Number.isNaN(at.getTime()) ? at : new Date();
  });
  const [open, setOpen] = useState<Occurrence | null>(null);
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const week = useMemo(() => weekOf(anchor), [anchor]);
  const shown = view === "week" ? week : grid;
  const from = isoDay(shown[0]!);
  const to = isoDay(shown[shown.length - 1]!);
  const events = useQuery({
    queryKey: ["calendar", from, to],
    queryFn: ({ signal }) => api.get<{ occurrences: Occurrence[] }>(`${CALENDAR}/events`, { from, to }, signal),
  });
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["calendar"] }), [qc]);
  useLiveEntity("CalendarEvent", refresh);
  const list = useMemo(() => events.data?.occurrences ?? [], [events.data]);
  // A link that names an event but not when (a notification of an invitation) goes to the month it is in.
  const [locating, setLocating] = useState(!!wanted && !wantedAt);
  useEffect(() => {
    if (!wanted || wantedAt) return;
    let live = true;
    api.get<{ starts_at: string; recurrence?: string | null }>(docPath("CalendarEvent", wanted)).then(
      (d) => {
        if (!live) return;
        setAnchor(new Date(d.recurrence ? Math.max(Date.parse(d.starts_at), Date.now()) : Date.parse(d.starts_at)));
        setLocating(false);
      },
      () => live && setLocating(false),
    );
    return () => {
      live = false;
    };
  }, [wanted, wantedAt]);
  useEffect(() => {
    if (!wanted || !events.data || locating) return;
    const at = wantedAt ? new Date(wantedAt).getTime() : NaN;
    const o = list.find((x) => x.event === wanted && new Date(x.start).getTime() === at) ?? list.find((x) => x.event === wanted);
    if (o) setOpen(o);
    else toast(t("That event is not in your calendar any more"), "info");
    setParams(
      (p) => {
        p.delete("event");
        p.delete("at");
        return p;
      },
      { replace: true },
    );
  }, [wanted, wantedAt, events.data, list, locating, setParams]);
  const days = useMemo(() => byDay(list), [list]);
  const today = isoDay(new Date());
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // remembered for this visit only
    }
  };
  const step = (n: number) =>
    setAnchor((a) => (view === "week" ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * n) : new Date(a.getFullYear(), a.getMonth() + n, 1)));
  const inMonth = (d: Date) => d.getMonth() === anchor.getMonth();
  const agenda = shown.filter((d) => (view === "week" || inMonth(d)) && days.has(isoDay(d)));
  const title =
    view === "week"
      ? `${week[0]!.toLocaleDateString([], { day: "numeric", month: "short" })} – ${week[6]!.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`
      : anchor.toLocaleDateString([], { month: "long", year: "numeric" });
  const unit = view === "week" ? "week" : "month";
  const move = async (id: string, start: Date) => {
    const o = list.find((x) => x.id === id);
    if (!o || !movable(o)) return;
    const to = moved(o, start);
    if (to.starts_at === new Date(o.start).toISOString()) return;
    try {
      await api.patch(docPath("CalendarEvent", o.event), to);
      toast(`Moved: ${o.subject}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    refresh();
  };

  return (
    <div className="grid gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <CalendarDays className="size-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="mr-2 text-lg font-semibold">{title}</h1>
        <Button variant="outline" size="icon-sm" aria-label={`Previous ${unit}`} onClick={() => step(-1)}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>
          {t("Today")}
        </Button>
        <Button variant="outline" size="icon-sm" aria-label={`Next ${unit}`} onClick={() => step(1)}>
          <ChevronRight />
        </Button>
        <div className="flex rounded-md border p-0.5" role="group" aria-label={t("View")}>
          {(["month", "week"] as const).map((v) => (
            <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} aria-pressed={view === v} className="h-7 capitalize" onClick={() => setView(v)}>
              {v}
            </Button>
          ))}
        </div>
        <Button asChild size="sm" className="ml-auto">
          <Link to={newEventLink(today)}>
            <Plus /> {t("New event")}
          </Link>
        </Button>
      </header>
      {events.error ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <>
          {view === "week" ? (
            <WeekGrid week={week} list={list} loading={events.isLoading} today={today} onOpen={setOpen} onMove={(id, start) => void move(id, start)} onNew={(at) => navigate(newEventAt(at))} />
          ) : (
            /* Month grid: tablets and up. */
            <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
              <div className="grid grid-cols-[repeat(7,minmax(0,1fr))] border-b text-xs font-medium text-muted-foreground">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="px-2 py-1.5">
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-[repeat(7,minmax(0,1fr))] grid-rows-6">
                {grid.map((d) => {
                  const key = isoDay(d);
                  const day = days.get(key) ?? [];
                  return (
                    <div
                      key={key}
                      className={cn("min-h-24 min-w-0 overflow-hidden border-r border-b p-1 [&:nth-child(7n)]:border-r-0", !inMonth(d) && "bg-muted/30 text-muted-foreground")}
                      {...dropTarget((id) => {
                        const o = list.find((x) => x.id === id);
                        if (o) void move(id, o.all_day ? d : sameTimeOn(o, d));
                      })}
                    >
                      <div className="flex items-center justify-between">
                        <Link
                          to={newEventLink(key)}
                          aria-label={`New event on ${longDay(key)}`}
                          className={cn("grid size-6 place-items-center rounded-full text-xs hover:bg-accent", key === today && "bg-primary text-primary-foreground hover:bg-primary")}
                        >
                          {d.getDate()}
                        </Link>
                      </div>
                      <ul className="mt-0.5 grid grid-cols-1 gap-0.5">
                        {events.isLoading && <Skeleton className="h-4" />}
                        {day.slice(0, 3).map((o) => (
                          <li key={o.id}>
                            <OccurrenceChip o={o} onOpen={() => setOpen(o)} />
                          </li>
                        ))}
                        {day.length > 3 && <li className="px-1 text-xs text-muted-foreground">+{day.length - 3} more</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* Agenda: phones. */}
          <div className="grid gap-3 md:hidden">
            {events.isLoading && <Skeleton className="h-32" />}
            {!events.isLoading && !agenda.length && <p className="text-sm text-muted-foreground">{t("Nothing this {unit}.", { unit })}</p>}
            {agenda.map((d) => {
              const key = isoDay(d);
              return (
                <section key={key} aria-label={longDay(key)}>
                  <h2 className={cn("mb-1 text-sm font-semibold", key === today && "text-primary")}>{longDay(key)}</h2>
                  <ul className="grid gap-1">
                    {(days.get(key) ?? []).map((o) => (
                      <li key={o.id}>
                        <OccurrenceChip o={o} onOpen={() => setOpen(o)} large />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
      {open && <OccurrenceDialog o={open} onClose={() => setOpen(null)} onChanged={refresh} onEdit={() => navigate(`/calendar/e/${open.event}`)} />}
    </div>
  );
}

/** A week of hours (tablets and up): all-day events on top, timed ones placed by their times. */
function WeekGrid({
  week,
  list,
  loading,
  today,
  onOpen,
  onMove,
  onNew,
}: {
  week: Date[];
  list: Occurrence[];
  loading: boolean;
  today: string;
  onOpen: (o: Occurrence) => void;
  onMove: (id: string, start: Date) => void;
  onNew: (at: Date) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Minutes between the dragged event's start and where it was picked up, so it lands where it is dropped.
  const grab = useRef(0);
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 7.5 * HOUR });
  }, []);
  const allDay = useMemo(() => byDay(list.filter((o) => o.all_day)), [list]);
  const cols = "grid grid-cols-[3rem_repeat(7,minmax(0,1fr))]";
  /** The time under the pointer in a day's column, less `before` minutes, to `step` minutes. */
  const timeAt = (day: Date, e: DragEvent<HTMLElement> | MouseEvent<HTMLElement>, step: number, before = 0) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const minutes = Math.min(1440 - step, Math.max(0, Math.round(((y / HOUR) * 60 - before) / step) * step));
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
  };
  const now = new Date();
  return (
    <div className="hidden overflow-hidden rounded-lg border bg-card md:block" aria-busy={loading || undefined}>
      <div className={cn(cols, "border-b text-xs font-medium text-muted-foreground")}>
        <div />
        {week.map((d) => (
          <div key={isoDay(d)} className={cn("truncate px-2 py-1.5", isoDay(d) === today && "text-primary")}>
            {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
          </div>
        ))}
      </div>
      <div className={cn(cols, "border-b")}>
        <div className="px-1 py-1.5 text-[10px] text-muted-foreground">{t("All day")}</div>
        {week.map((d) =>
          loading ? (
            <div key={isoDay(d)} className="border-l p-1">
              <Skeleton className="h-4" />
            </div>
          ) : (
            <ul
              key={isoDay(d)}
              className="grid min-h-8 min-w-0 grid-cols-1 content-start gap-0.5 border-l p-0.5"
              {...dropTarget((id) => {
                const o = list.find((x) => x.id === id);
                if (o) onMove(id, o.all_day ? d : sameTimeOn(o, d));
              })}
            >
              {(allDay.get(isoDay(d)) ?? []).map((o) => (
                <li key={o.id}>
                  <OccurrenceChip o={o} onOpen={() => onOpen(o)} />
                </li>
              ))}
            </ul>
          ),
        )}
      </div>
      <div ref={scroller} className="max-h-[65vh] overflow-y-auto">
        <div className={cols} style={{ height: 24 * HOUR }}>
          <div className="relative" aria-hidden="true">
            {Array.from({ length: 23 }, (_, h) => (
              <span key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums" style={{ top: (h + 1) * HOUR }}>
                {new Date(2000, 0, 1, h + 1).toLocaleTimeString([], { hour: "numeric" })}
              </span>
            ))}
          </div>
          {week.map((d) => {
            const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
            return (
              <div
                key={isoDay(d)}
                className="relative border-l"
                style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${HOUR}px)` }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) onNew(timeAt(d, e, 30));
                }}
                {...dropTarget((id, e) => onMove(id, timeAt(d, e, 15, grab.current)))}
              >
                {isoDay(d) === today && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-destructive" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR }} />
                )}
                {placeDay(list, d).map((p) => {
                  const color = safeColor(p.o.color) ?? "var(--primary)";
                  const cancelled = p.o.status === "Cancelled" || p.o.my_response === "Declined";
                  return (
                    <button
                      key={p.o.id}
                      type="button"
                      draggable={movable(p.o)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG, p.o.id);
                        e.dataTransfer.effectAllowed = "move";
                        const picked = ((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) * 60;
                        grab.current = Math.round(p.from + picked - (new Date(p.o.start).getTime() - dayStart) / 60_000);
                      }}
                      onClick={() => onOpen(p.o)}
                      title={movable(p.o) ? "Drag to move" : undefined}
                      className={cn(
                        "absolute overflow-hidden rounded-sm border-l-4 bg-accent px-1 text-left text-xs leading-tight hover:brightness-95 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                        movable(p.o) && "cursor-grab active:cursor-grabbing",
                        cancelled && "text-muted-foreground line-through",
                      )}
                      style={{
                        top: (p.from / 60) * HOUR,
                        height: Math.max(((p.to - p.from) / 60) * HOUR, 18),
                        left: `calc(${(p.lane / p.lanes) * 100}% + 1px)`,
                        width: `calc(${100 / p.lanes}% - 2px)`,
                        borderLeftColor: color,
                      }}
                    >
                      <span className="block truncate font-medium">{p.o.subject}</span>
                      <span className="block truncate text-muted-foreground tabular-nums">{timeOf(p.o.start)}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OccurrenceChip({ o, onOpen, large }: { o: Occurrence; onOpen: () => void; large?: boolean }) {
  const color = safeColor(o.color) ?? "var(--primary)";
  const cancelled = o.status === "Cancelled";
  const declined = o.my_response === "Declined";
  const drag = !large && movable(o);
  return (
    <button
      type="button"
      onClick={onOpen}
      draggable={drag}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG, o.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      title={drag ? "Drag to another day to move" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded px-1 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        large ? "border p-2 text-sm pointer-coarse:min-h-11" : "text-xs",
        drag && "cursor-grab active:cursor-grabbing",
        (cancelled || declined) && "text-muted-foreground line-through",
      )}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
      {!o.all_day && <span className="shrink-0 tabular-nums">{timeOf(o.start)}</span>}
      <span className="min-w-0 truncate">{o.subject}</span>
    </button>
  );
}

const RESPONSES = ["Accepted", "Tentative", "Declined"] as const;

/** Who is on an event and what each answered (`GET /calendar/events/{id}`: for the organizer and the guests). */
interface Detail {
  attendees: Guest[];
  owner: string;
  owner_name?: string | null;
}

function OccurrenceDialog({ o, onClose, onChanged, onEdit }: { o: Occurrence; onClose: () => void; onChanged: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState(o.my_response ?? null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [meetingLink, setMeetingLink] = useState(o.meeting_link);
  const meets = useMeetAvailable();
  const meet = meets.data === true;
  const detail = useQuery({ queryKey: ["calendar", "detail", o.event], queryFn: ({ signal }) => api.get<Detail>(`${CALENDAR}/events/${o.event}`, undefined, signal), retry: false });
  const link = safeLink(meetingLink);
  // A meeting of this app opens here; any other link (another service's meeting) in a new tab.
  const meeting = meetPath(link);
  const cancelled = o.status === "Cancelled";
  const guests = detail.data?.attendees ?? [];
  const by = detail.data?.owner_name || detail.data?.owner || o.owner;
  const addMeeting = async () => {
    setBusy(true);
    try {
      const href = meetLink("event", o.event);
      await api.patch(docPath("CalendarEvent", o.event), { meeting_link: href });
      setMeetingLink(href);
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const when = o.all_day
    ? new Date(o.start).toLocaleDateString([], { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    : `${new Date(o.start).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })} – ${timeOf(o.end)}`;
  const rsvp = async (r: (typeof RESPONSES)[number]) => {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`${CALENDAR}/events/${o.event}/rsvp`, { response: r, note: note.trim() });
      setResponse(r);
      setNote("");
      onChanged();
      void qc.invalidateQueries({ queryKey: ["calendar", "detail", o.event] });
      toast(`Replied: ${answerWord(r).toLowerCase()}. ${by ? `${by} is told.` : ""}`.trim());
    } catch (e) {
      setProblem(`Your answer was not sent: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className={cn(cancelled && "line-through")}>{o.subject}</DialogTitle>
          <DialogDescription>{when}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {o.status && o.status !== "Confirmed" && <Badge variant="secondary">{o.status}</Badge>}
            {o.recurring && (
              <Badge variant="outline">
                <Repeat /> {t("Repeats")}
              </Badge>
            )}
            {o.category && <Badge variant="outline">{o.category}</Badge>}
          </div>
          {o.location && (
            <p className="flex items-center gap-1.5">
              <MapPin className="size-4 text-muted-foreground" aria-hidden="true" /> {o.location}
            </p>
          )}
          {meeting ? (
            !cancelled &&
            (meet ? (
              <p className="flex items-center gap-1.5">
                <Video className="size-4 text-muted-foreground" aria-hidden="true" />
                <a href={meeting} onClick={(e) => openCall(e, meeting)} className="text-primary underline underline-offset-2">
                  {t("Join video meeting")}
                </a>
              </p>
            ) : (
              !meets.isLoading && (
                <p className="flex items-start gap-1.5 text-muted-foreground">
                  <Video className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {t("This event has a video meeting, but video meetings are not set up on this server, so nobody can join it. An administrator can set them up.")}
                </p>
              )
            ))
          ) : (
            link && (
              <p className="flex items-center gap-1.5">
                <Video className="size-4 text-muted-foreground" aria-hidden="true" />
                <a href={link} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                  {t("Join the meeting")}
                </a>
              </p>
            )
          )}
          {!link && o.is_organizer && meet && !cancelled && (
            <Button size="sm" variant="outline" className="justify-self-start" disabled={busy} onClick={() => void addMeeting()}>
              <Video /> {t("Add video meeting")}
            </Button>
          )}
          {o.description && <p className="whitespace-pre-line text-muted-foreground">{o.description}</p>}
          {by && !o.is_organizer && <p className="text-xs text-muted-foreground">{t("Organized by {by}", { by })}</p>}
          {response !== null && !cancelled && (
            <div className="grid gap-2 border-t pt-2">
              <span className="text-xs font-medium text-muted-foreground">{response === "Needs Action" ? "Will you go? You have not answered yet." : "Will you go?"}</span>
              <div className="flex gap-2">
                {RESPONSES.map((r) => (
                  <Button key={r} size="sm" variant={response === r ? "default" : "outline"} disabled={busy} aria-pressed={response === r} onClick={() => void rsvp(r)}>
                    {answerWord(r)}
                  </Button>
                ))}
              </div>
              <Textarea value={note} rows={2} maxLength={500} placeholder={`A note for ${by || "the organizer"} (sent with your next answer)`} aria-label={t("A note with your answer")} onChange={(e) => setNote(e.target.value)} />
              {problem && (
                <p role="alert" className="text-xs text-destructive">
                  {problem}
                </p>
              )}
            </div>
          )}
          {guests.length > 0 && (
            <div className="grid gap-1 border-t pt-2">
              <span className="text-xs font-medium text-muted-foreground">
                {guests.length} {guests.length === 1 ? "guest" : "guests"}: {tally(guests)}
              </span>
              <ul className="grid gap-1" aria-label={t("Guests")}>
                {guests.map((g) => (
                  <li key={g.email} className="grid">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{g.name || g.email}</span>
                      <span className={cn("shrink-0 text-xs", g.response === "Accepted" ? "text-success" : g.response === "Declined" ? "text-destructive" : "text-muted-foreground")}>{answerWord(g.response)}</span>
                    </span>
                    {g.comment && <span className="border-l-2 pl-2 text-xs text-muted-foreground">{g.comment}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
          {o.is_organizer && <Button onClick={onEdit}>{t("Edit event")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
