// The calendar on Comms' calendar API: my events, invitations and public events with recurrences
// expanded by the server, as a day, a work week, a week (three days on a phone), a month, an agenda
// or a year, the view and date kept in the address so a link opens the same view. A side panel has
// a small month to jump to a date. Events are made by clicking or dragging on empty time (a quick
// form; "More options" opens the full editor, CalendarEditor.tsx), moved and resized by dragging or
// by keyboard, and for a repeating event every change and deletion asks which occurrences it is
// for. Every change waits for the server before it shows as done, and offers Undo.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Download, Keyboard, Link2, MapPin, MoreHorizontal, Plus, Repeat, Search, Upload, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Badge, Button, Input, Label, Skeleton, Textarea } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { api, docPath, errorMessage, isolate, t } from "@ferrum/client";
import { announce, cn, ListSkeleton, StatePanel, toast, useDismiss, useLiveEntity } from "@ferrum/kit";
import { meetLink, meetPath, openCall, useMeetAvailable } from "./lib/meet";
import {
  AGENDA_DAYS,
  answerWord,
  barsAcross as barsOf,
  byDay,
  CALENDAR,
  dayFrom,
  daysShown,
  firstDayOf,
  isoDay,
  matches,
  monthGrid,
  moved,
  parseGuests,
  safeColor,
  safeLink,
  stepped,
  tally,
  VIEWS,
  weekendOf,
  type Guest,
  DEFAULT_HOURS,
  type Occurrence,
  type PersonHours,
  type Scope,
  type View,
  userLocale,
} from "./lib/calendar";
import { changeTimes, removeOccurrence, type Undo } from "./lib/calendarChanges";
import { EventBar, TimeGrid, timeFmt, useNow, type WorkHours } from "./CalendarGrid";
import { Failure } from "./States";

const VIEW_KEY = "ferrum.calendar.view";
const ZONE_KEY = "ferrum.calendar.zone2";
/** Working hours: the person's own, else 09:00 to 17:00 on the locale's working days. */
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const workHours = (weekend: number[], own?: PersonHours): WorkHours =>
  own ? { from: minutes(own.from), to: minutes(own.to), days: own.days } : { from: 9 * 60, to: 17 * 60, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => !weekend.includes(d)) };

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, v: string | null) => {
  try {
    if (v) localStorage.setItem(key, v);
    else localStorage.removeItem(key);
  } catch {
    // for this visit only
  }
};

function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

const viewName = (v: View) => ({ day: t("Day"), workweek: t("Work week"), week: t("Week"), month: t("Month"), agenda: t("Agenda"), year: t("Year") })[v];
const VIEW_KEYS: Record<string, View> = { d: "day", x: "workweek", w: "week", m: "month", a: "agenda", y: "year" };
const longDay = (d: Date) => d.toLocaleDateString(userLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const plus = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Whether a key press belongs to a field or an open dialog, not to the calendar. */
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog],[role=menu],[role=listbox]"));
};

export function CalendarPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const narrow = useMedia("(max-width: 767px)");
  const lang = userLocale();
  const first = useMemo(() => firstDayOf(lang), [lang]);
  const weekend = useMemo(() => weekendOf(lang), [lang]);
  // My working hours (a server before Calendar 0.16 has none: the locale's then).
  const mine = useQuery({ queryKey: ["calendar", "hours"], queryFn: ({ signal }) => api.get<{ saved: boolean; hours: PersonHours }>(`${CALENDAR}/hours`, undefined, signal), retry: false, staleTime: 300_000 });
  const work = useMemo(() => workHours(weekend, mine.data?.saved ? mine.data.hours : undefined), [weekend, mine.data]);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  // A link to an event (`?event={id}&at={start}`: Home's My work, a notification) opens it.
  const wanted = params.get("event");
  const wantedAt = params.get("at");
  const view: View = (VIEWS as string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : ((remembered(VIEW_KEY) as View | null) ?? (narrow ? "day" : "week"));
  const anchor = useMemo(() => {
    const at = wantedAt ? new Date(wantedAt) : null;
    return dayFrom(params.get("date")) ?? (at && !Number.isNaN(at.getTime()) ? at : new Date());
  }, [params, wantedAt]);
  const go = useCallback(
    (to: { view?: View; date?: Date }, replace = false) =>
      setParams(
        (p) => {
          if (to.view) {
            p.set("view", to.view);
            remember(VIEW_KEY, to.view);
          }
          if (to.date) p.set("date", isoDay(to.date));
          return p;
        },
        { replace },
      ),
    [setParams],
  );
  const [zone2, setZone2] = useState(() => remembered(ZONE_KEY) ?? "");
  const [open, setOpenState] = useState<Occurrence | null>(null);
  // My time away opens where it is changed.
  const setOpen = (o: Occurrence | null) => (o?.kind === "away" ? setHoursOpen(true) : setOpenState(o));
  const [draft, setDraft] = useState<{ start: Date; end: Date; allDay?: boolean; at?: { x: number; y: number } } | null>(null);
  const [scopeAsk, setScopeAsk] = useState<{ title: string; resolve: (s: Scope | null) => void } | null>(null);
  const [keys, setKeys] = useState(false);
  const [feed, setFeed] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const days = useMemo(() => daysShown(view, anchor, { first, weekend, narrow }), [view, anchor, first, weekend, narrow]);
  // A day either side, so times in any zone fall inside; `to` is exclusive on the server.
  const from = isoDay(plus(days[0]!, -1));
  const to = isoDay(plus(days[days.length - 1]!, 2));
  const key = ["calendar", from, to];
  const events = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<{ occurrences: Occurrence[] }>(`${CALENDAR}/events`, { from, to }, signal) });
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ["calendar"] }), [qc]);
  useLiveEntity("CalendarEvent", refresh);
  const list = useMemo(() => events.data?.occurrences ?? [], [events.data]);
  const today = isoDay(useNow());

  // A link that names an event but not when (a notification of an invitation) goes to where it is.
  const [locating, setLocating] = useState(!!wanted && !wantedAt);
  useEffect(() => {
    if (!wanted || wantedAt) return;
    let live = true;
    api.get<{ starts_at: string; recurrence?: string | null }>(docPath("CalendarEvent", wanted)).then(
      (d) => {
        if (!live) return;
        go({ date: new Date(d.recurrence ? Math.max(Date.parse(d.starts_at), Date.now()) : Date.parse(d.starts_at)) }, true);
        setLocating(false);
      },
      () => live && setLocating(false),
    );
    return () => {
      live = false;
    };
  }, [wanted, wantedAt, go]);
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

  const askScope = (title: string) => new Promise<Scope | null>((resolve) => setScopeAsk({ title, resolve }));

  /** Shows `o` at its new times at once, saves, and puts it back with a message if the server refuses. */
  const change = async (o: Occurrence, start: Date, end: Date) => {
    const all = o.all_day;
    const next = all ? moved(o, start) : { starts_at: start.toISOString(), ends_at: end.toISOString() };
    if (next.starts_at === new Date(o.start).toISOString() && next.ends_at === new Date(o.end).toISOString()) return;
    const scope = o.recurring ? await askScope(t("Change a repeating event")) : "all";
    if (!scope) return;
    const before = qc.getQueryData(key);
    qc.setQueryData<{ occurrences: Occurrence[] }>(key, (d) => d && { ...d, occurrences: d.occurrences.map((x) => (x.id === o.id ? { ...x, start: next.starts_at, end: next.ends_at } : x)) });
    const when = all ? new Date(next.starts_at).toLocaleDateString(lang, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }) : `${longDay(start)}, ${timeFmt(start)}`;
    try {
      const undo = await changeTimes(o, new Date(next.starts_at), new Date(next.ends_at), scope);
      const said = t("{subject} moved to {when}", { subject: o.subject, when });
      announce(said);
      toast(said, "success", { action: { label: t("Undo"), onSelect: () => void undoing(undo, t("Move undone")) } });
    } catch (e) {
      qc.setQueryData(key, before);
      toast(t("Not moved: {e}", { e: errorMessage(e) }), "error");
    }
    refresh();
  };
  const undoing = async (undo: Undo, done: string) => {
    try {
      await undo();
      toast(done);
      announce(done);
    } catch (e) {
      toast(t("Could not undo: {e}", { e: errorMessage(e) }), "error");
    }
    refresh();
  };
  const remove = async (o: Occurrence) => {
    const scope = o.recurring ? await askScope(t("Delete a repeating event")) : "all";
    if (!scope) return;
    const before = qc.getQueryData(key);
    qc.setQueryData<{ occurrences: Occurrence[] }>(key, (d) => d && { ...d, occurrences: d.occurrences.filter((x) => (scope === "this" ? x.id !== o.id : x.event !== o.event || (scope === "following" && x.start < o.start))) });
    setOpen(null);
    try {
      const undo = await removeOccurrence(o, scope);
      const said = t("Deleted: {subject}", { subject: o.subject });
      announce(said);
      toast(said, "success", { action: { label: t("Undo"), onSelect: () => void undoing(undo, t("Brought back: {subject}", { subject: o.subject })) } });
    } catch (e) {
      qc.setQueryData(key, before);
      toast(t("Not deleted: {e}", { e: errorMessage(e) }), "error");
    }
    refresh();
  };

  // Keyboard: views, today, previous/next, create, search, help.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || draft || open || scopeAsk || keys || feed || hoursOpen) return;
      const k = e.key;
      const rtl = document.documentElement.dir === "rtl";
      if (VIEW_KEYS[k]) go({ view: VIEW_KEYS[k] });
      else if (k === "t") go({ date: new Date() });
      else if (k === "j" || k === "n" || k === (rtl ? "ArrowLeft" : "ArrowRight")) go({ date: stepped(view, anchor, 1, narrow) });
      else if (k === "k" || k === "p" || k === (rtl ? "ArrowRight" : "ArrowLeft")) go({ date: stepped(view, anchor, -1, narrow) });
      else if (k === "c") {
        const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), Math.max(new Date().getHours() + 1, 9));
        setDraft({ start: s, end: new Date(s.getTime() + 3_600_000) });
      } else if (k === "/") {
        setQuery((q) => q ?? "");
        window.setTimeout(() => searchBox.current?.focus(), 0);
      } else if (k === "?") setKeys(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [go, view, anchor, narrow, draft, open, scopeAsk, keys, feed, hoursOpen]);

  const title =
    view === "day"
      ? longDay(anchor)
      : view === "year"
        ? String(anchor.getFullYear())
        : view === "month"
          ? anchor.toLocaleDateString(lang, { month: "long", year: "numeric" })
          : `${days[0]!.toLocaleDateString(lang, { day: "numeric", month: "short" })} – ${days[days.length - 1]!.toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" })}`;
  const unit = viewName(view).toLowerCase();
  const create = (start: Date, end: Date, at?: { x: number; y: number }, allDay = false) => setDraft({ start, end, at, allDay });

  const body = events.error ? (
    <Failure error={events.error} onRetry={() => void events.refetch()} />
  ) : query !== null ? (
    <SearchResults q={query} onOpen={setOpen} />
  ) : view === "month" ? (
    <MonthView month={anchor} first={first} list={list} loading={events.isLoading} today={today} narrow={narrow} onOpen={setOpen} onDay={(d) => go({ view: "day", date: d })} onChange={(o, s, z) => void change(o, s, z)} onCreate={(d) => create(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9), new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10), undefined, true)} />
  ) : view === "agenda" ? (
    <AgendaView days={days} list={list} loading={events.isLoading} today={today} onOpen={setOpen} onMore={() => go({ date: stepped("agenda", anchor, 1) })} />
  ) : view === "year" ? (
    <YearView year={anchor.getFullYear()} first={first} today={today} list={list} onDay={(d) => go({ view: "day", date: d })} />
  ) : (
    <TimeGrid days={days} list={list} loading={events.isLoading} today={today} work={work} zone2={zone2 || undefined} onOpen={setOpen} onCreate={create} onChange={(o, s, z) => void change(o, s, z)} onDay={(d) => go({ view: "day", date: d })} />
  );

  return (
    <div className="grid gap-3 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="hidden content-start gap-4 md:grid" aria-label={t("Calendar side panel")}>
        <Button className="justify-self-start" onClick={() => create(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9), new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 10))}>
          <Plus /> {t("New event")}
        </Button>
        <MiniMonth selected={anchor} first={first} today={today} shown={days.length <= 7 ? days : []} onPick={(d) => go({ date: d })} />
        <div className="grid gap-1.5 text-sm">
          <Label htmlFor="cal-zone2" className="text-xs text-muted-foreground">
            {t("Second time zone")}
          </Label>
          <ZoneSelect
            id="cal-zone2"
            value={zone2}
            onChange={(z) => {
              setZone2(z);
              remember(ZONE_KEY, z || null);
            }}
          />
        </div>
      </aside>
      <div className="grid min-w-0 content-start gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <CalendarDays className="size-5 text-muted-foreground max-md:hidden" aria-hidden="true" />
          <Button variant="outline" size="sm" onClick={() => go({ date: new Date() })} aria-keyshortcuts="t">
            {t("Today")}
          </Button>
          <div className="flex items-center">
            <Button variant="ghost" size="icon-sm" aria-label={t("Previous {unit}", { unit })} aria-keyshortcuts="k" onClick={() => go({ date: stepped(view, anchor, -1, narrow) })}>
              <ChevronLeft className="rtl:rotate-180" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("Next {unit}", { unit })} aria-keyshortcuts="j" onClick={() => go({ date: stepped(view, anchor, 1, narrow) })}>
              <ChevronRight className="rtl:rotate-180" />
            </Button>
          </div>
          <h1 dir="auto" className="me-auto min-w-0 truncate text-lg font-semibold" aria-live="polite">
            {isolate(query !== null ? t("Search") : title)}
          </h1>
          {query !== null ? (
            <div className="flex min-w-0 basis-full items-center gap-1 sm:basis-80">
              <Input
                ref={searchBox}
                type="search"
                value={query}
                autoFocus
                placeholder={t("Search events: title, guest, place, notes")}
                aria-label={t("Search events")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery(null);
                }}
              />
              <Button variant="ghost" size="icon-sm" aria-label={t("Close search")} onClick={() => setQuery(null)}>
                <X />
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="icon-sm" aria-label={t("Search events")} aria-keyshortcuts="/" onClick={() => setQuery("")}>
              <Search />
            </Button>
          )}
          <select aria-label={t("View")} className="h-8 rounded-md border border-input bg-card px-2 text-sm" value={view} onChange={(e) => go({ view: e.target.value as View })}>
            {VIEWS.map((v) => (
              <option key={v} value={v}>
                {isolate(viewName(v))}
              </option>
            ))}
          </select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("More calendar actions")}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <ImportItem onDone={refresh} />
              <DropdownMenuItem asChild>
                <a href={`${CALENDAR}/export`} download="calendar.ics">
                  <Download /> {t("Export my calendar (.ics)")}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHoursOpen(true)}>
                <Clock /> {t("Working hours and time away")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFeed(true)}>
                <Link2 /> {t("Secret address for other calendars")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setKeys(true)}>
                <Keyboard /> {t("Keyboard shortcuts")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" className="md:hidden" aria-label={t("New event")} onClick={() => create(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9), new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 10))}>
            <Plus />
          </Button>
        </header>
        {body}
      </div>
      {open && <OccurrenceDialog o={open} onClose={() => setOpen(null)} onChanged={refresh} onEdit={() => navigate(`/calendar/e/${open.event}`)} onDelete={() => void remove(open)} />}
      {draft && <QuickCreate draft={draft} onClose={() => setDraft(null)} onSaved={refresh} />}
      {scopeAsk && (
        <ScopeDialog
          title={scopeAsk.title}
          onPick={(s) => {
            scopeAsk.resolve(s);
            setScopeAsk(null);
          }}
        />
      )}
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
      {feed && <FeedDialog onClose={() => setFeed(false)} />}
      {hoursOpen && <HoursDialog current={mine.data?.hours} missing={!!mine.error} first={first} onClose={() => setHoursOpen(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["calendar"] })} />}
    </div>
  );
}

/** Every IANA zone this browser knows, with "none" first. */
function ZoneSelect({ id, value, onChange }: { id: string; value: string; onChange: (z: string) => void }) {
  const zones = useMemo(() => (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [], []);
  return (
    <select id={id} className="h-8 w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("None")}</option>
      {zones.map((z) => (
        <option key={z} value={z}>
          {isolate(z.replaceAll("_", " "))}
        </option>
      ))}
    </select>
  );
}

/** A small month to jump to a date; the days shown are marked. */
export function MiniMonth({ selected, first, today, shown, onPick, compact }: { selected: Date; first: number; today: string; shown?: Date[]; onPick: (d: Date) => void; compact?: boolean }) {
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  useEffect(() => setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1)), [selected]);
  const grid = monthGrid(month, first);
  const marked = new Set((shown ?? []).map(isoDay));
  const lang = userLocale();
  return (
    <div className="grid gap-1 text-xs">
      <div className="flex items-center gap-1">
        <span className="flex-1 ps-1 text-sm font-medium">{isolate(month.toLocaleDateString(lang, { month: "long", year: "numeric" }))}</span>
        {!compact && (
          <>
            <Button variant="ghost" size="icon-xs" aria-label={t("Previous month")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
              <ChevronLeft className="rtl:rotate-180" />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={t("Next month")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
              <ChevronRight className="rtl:rotate-180" />
            </Button>
          </>
        )}
      </div>
      <div className="grid grid-cols-7 text-center text-muted-foreground" aria-hidden="true">
        {grid.slice(0, 7).map((d) => (
          <span key={d.getDay()}>{isolate(d.toLocaleDateString(lang, { weekday: "narrow" }))}</span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {grid.map((d) => {
          const k = isoDay(d);
          const other = d.getMonth() !== month.getMonth();
          return (
            <button
              key={k}
              type="button"
              onClick={() => onPick(d)}
              aria-label={longDay(d)}
              aria-current={k === today ? "date" : undefined}
              className={cn("mx-auto grid size-7 place-items-center rounded-full tabular-nums hover:bg-accent", other && "text-muted-foreground", marked.has(k) && "bg-primary-soft", k === today && "bg-primary text-primary-foreground hover:bg-primary")}
            >
              {isolate(d.toLocaleDateString(lang, { day: "numeric" }))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The month: six weeks, all-day and multi-day events as bars across days, the rest listed per day; more than fit fold into "+N more", which opens the day. On a phone each day shows dots, and the chosen day's list is beneath. */
function MonthView(p: { month: Date; first: number; list: Occurrence[]; loading: boolean; today: string; narrow: boolean; onOpen: (o: Occurrence) => void; onDay: (d: Date) => void; onChange: (o: Occurrence, s: Date, z: Date) => void; onCreate: (d: Date) => void }) {
  const grid = useMemo(() => monthGrid(p.month, p.first), [p.month, p.first]);
  const days = useMemo(() => byDay(p.list), [p.list]);
  const [picked, setPicked] = useState(() => isoDay(p.month));
  const lang = userLocale();
  const weeks = Array.from({ length: 6 }, (_, i) => grid.slice(i * 7, i * 7 + 7));
  const inMonth = (d: Date) => d.getMonth() === p.month.getMonth();
  if (p.narrow) {
    const chosen = days.get(picked) ?? [];
    return (
      <div className="grid gap-3">
        <div className="grid grid-cols-7 rounded-lg border bg-card text-center text-xs">
          {grid.slice(0, 7).map((d) => (
            <span key={`h${d.getDay()}`} className="py-1 text-muted-foreground" aria-hidden="true">
              {isolate(d.toLocaleDateString(lang, { weekday: "narrow" }))}
            </span>
          ))}
          {grid.map((d) => {
            const k = isoDay(d);
            const n = (days.get(k) ?? []).length;
            return (
              <button key={k} type="button" aria-pressed={k === picked} aria-label={`${longDay(d)}${n ? `, ${t("{n} events", { n })}` : ""}`} onClick={() => setPicked(k)} className={cn("grid min-h-11 justify-items-center gap-0.5 py-1", !inMonth(d) && "text-muted-foreground", k === picked && "bg-primary-soft")}>
                <span className={cn("grid size-6 place-items-center rounded-full tabular-nums", k === p.today && "bg-primary text-primary-foreground")}>{isolate(d.toLocaleDateString(lang, { day: "numeric" }))}</span>
                <span className="flex h-1.5 gap-0.5" aria-hidden="true">
                  {(days.get(k) ?? []).slice(0, 3).map((o) => (
                    <span key={o.id} className="size-1.5 rounded-full" style={{ background: safeColor(o.color) ?? "var(--primary)" }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <section aria-label={longDay(dayFrom(picked)!)} className="grid gap-1">
          <h2 className="text-sm font-semibold">{isolate(longDay(dayFrom(picked)!))}</h2>
          {p.loading ? <ListSkeleton rows={3} /> : chosen.length ? chosen.map((o) => <OccurrenceChip key={o.id} o={o} onOpen={() => p.onOpen(o)} large />) : <p className="text-sm text-muted-foreground">{t("Nothing on this day.")}</p>}
        </section>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="grid grid-cols-7 border-b text-xs font-medium text-muted-foreground">
        {grid.slice(0, 7).map((d) => (
          <div key={d.getDay()} className="px-2 py-1.5 uppercase">
            {isolate(d.toLocaleDateString(lang, { weekday: "short" }))}
          </div>
        ))}
      </div>
      {weeks.map((week) => {
        const keys = week.map(isoDay);
        const spanning = p.list.filter((o) => o.all_day || byDay([o]).size > 1);
        const bars = barsOf(spanning, week);
        const shown = bars.filter((b) => b.row < 2);
        return (
          <div key={keys[0]} className="relative grid min-h-28 grid-cols-7 border-b last:border-b-0" style={{ gridTemplateRows: ["auto", ...Array.from({ length: Math.min(2, bars.reduce((n, b) => Math.max(n, b.row + 1), 0)) }, () => "1.375rem"), "1fr"].join(" ") }}>
            {week.map((d, i) => (
              <div
                key={keys[i]}
                aria-hidden="true"
                className={cn("border-e last:border-e-0", !inMonth(d) && "bg-muted/40")}
                style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
                onDragOver={(e) => e.preventDefault()}
                onDoubleClick={() => p.onCreate(d)}
              />
            ))}
            {week.map((d, i) => (
              <div key={`n${keys[i]}`} className="z-10 flex px-1 pt-1" style={{ gridColumn: i + 1, gridRow: 1 }}>
                <button
                  type="button"
                  onClick={() => p.onDay(d)}
                  aria-label={t("Show {day}", { day: longDay(d) })}
                  aria-current={keys[i] === p.today ? "date" : undefined}
                  className={cn("grid size-6 place-items-center rounded-full text-xs tabular-nums hover:bg-accent", !inMonth(d) && "text-muted-foreground", keys[i] === p.today && "bg-primary text-primary-foreground hover:bg-primary")}
                >
                  {isolate(d.toLocaleDateString(lang, { day: "numeric" }))}
                </button>
              </div>
            ))}
            {shown.map((b) => (
              <EventBar key={b.o.id} o={b.o} before={b.before} after={b.after} style={{ gridColumn: `${b.col + 1} / span ${b.span}`, gridRow: b.row + 2 }} onOpen={() => p.onOpen(b.o)} />
            ))}
            {week.map((d, i) => {
              const k = keys[i]!;
              const timed = (days.get(k) ?? []).filter((o) => !spanning.includes(o));
              const hidden = bars.filter((b) => b.row >= 2 && i >= b.col && i < b.col + b.span).length;
              const room = 3;
              const extra = Math.max(0, timed.length - room) + hidden;
              return (
                <ul key={`l${k}`} className="z-10 grid min-w-0 content-start gap-0.5 overflow-hidden p-0.5" style={{ gridColumn: i + 1, gridRow: "-2 / -1" }}>
                  {p.loading && i % 3 === 0 && <Skeleton className="h-4" />}
                  {timed.slice(0, room).map((o) => (
                    <li key={o.id} className="min-w-0">
                      <OccurrenceChip o={o} onOpen={() => p.onOpen(o)} />
                    </li>
                  ))}
                  {extra > 0 && (
                    <li>
                      <button type="button" className="w-full rounded px-1 text-start text-xs font-medium text-muted-foreground hover:bg-accent" onClick={() => p.onDay(d)}>
                        {t("+{n} more", { n: extra })}
                      </button>
                    </li>
                  )}
                </ul>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Upcoming events, grouped by day, from the date shown; "Later" goes on. */
function AgendaView({ days, list, loading, today, onOpen, onMore }: { days: Date[]; list: Occurrence[]; loading: boolean; today: string; onOpen: (o: Occurrence) => void; onMore: () => void }) {
  const by = useMemo(() => byDay(list), [list]);
  const shown = days.filter((d) => by.has(isoDay(d)));
  if (loading) return <ListSkeleton rows={6} />;
  return (
    <div className="grid gap-4">
      {!shown.length && (
        <StatePanel kind="empty" title={t("Nothing in the next {n} days", { n: AGENDA_DAYS })}>
          {t("Press c to add an event, or look further on.")}
        </StatePanel>
      )}
      {shown.map((d) => {
        const k = isoDay(d);
        return (
          <section key={k} aria-label={longDay(d)} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <h2 className={cn("text-sm font-semibold", k === today && "text-primary")}>{isolate(longDay(d))}</h2>
            <ul className="grid gap-1">
              {(by.get(k) ?? []).map((o) => (
                <li key={o.id}>
                  <OccurrenceChip o={o} onOpen={() => onOpen(o)} large />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <Button variant="outline" className="justify-self-center" onClick={onMore}>
        {t("Later")}
      </Button>
    </div>
  );
}

/** Twelve small months; a day opens in the day view, days with events are marked. */
function YearView({ year, first, today, list, onDay }: { year: number; first: number; today: string; list: Occurrence[]; onDay: (d: Date) => void }) {
  const busy = useMemo(() => [...byDay(list).keys()].map((k) => dayFrom(k)!).filter(Boolean), [list]);
  return (
    <div className="grid grid-cols-1 gap-6 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 12 }, (_, m) => (
        <MiniMonth key={m} compact selected={new Date(year, m, 1)} first={first} today={today} shown={busy.filter((d) => d.getMonth() === m && d.getFullYear() === year)} onPick={onDay} />
      ))}
    </div>
  );
}

/** Events matching a search, from half a year back to a year on, grouped by day. */
function SearchResults({ q, onOpen }: { q: string; onOpen: (o: Occurrence) => void }) {
  const words = q.trim();
  const now = new Date();
  const from = isoDay(plus(now, -180));
  const to = isoDay(plus(now, 215));
  const res = useQuery({ queryKey: ["calendar", "search", words], queryFn: ({ signal }) => api.get<{ occurrences: Occurrence[]; q?: string }>(`${CALENDAR}/events`, { from, to, q: words }, signal), enabled: words.length > 1, staleTime: 30_000 });
  // A server that searches says so (`q`, and it also matches guests); one that does not yet answers with everything, matched here.
  const found = useMemo(() => (res.data?.q ? res.data.occurrences : (res.data?.occurrences ?? []).filter((o) => matches(o, words))), [res.data, words]);
  const by = useMemo(() => byDay(found), [found]);
  if (words.length < 2) return <StatePanel kind="empty">{t("Type at least two letters of a title, a guest, a place or a note.")}</StatePanel>;
  if (res.error) return <Failure error={res.error} onRetry={() => void res.refetch()} />;
  if (res.isLoading) return <ListSkeleton rows={5} />;
  if (!found.length) return <StatePanel kind="no-matches">{t("No events match “{q}” between half a year ago and a year from now.", { q: words })}</StatePanel>;
  return (
    <div className="grid gap-3" role="region" aria-label={t("Search results")}>
      <p className="text-sm text-muted-foreground" role="status">
        {t("{n} found", { n: found.length })}
      </p>
      {[...by.entries()].map(([k, list]) => (
        <section key={k} aria-label={longDay(dayFrom(k)!)} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <h2 className="text-sm font-semibold">{isolate(longDay(dayFrom(k)!))}</h2>
          <ul className="grid gap-1">
            {list.map((o) => (
              <li key={o.id}>
                <OccurrenceChip o={o} onOpen={() => onOpen(o)} large />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OccurrenceChip({ o, onOpen, large }: { o: Occurrence; onOpen: () => void; large?: boolean }) {
  const color = safeColor(o.color) ?? "var(--primary)";
  const off = o.status === "Cancelled" || o.my_response === "Declined";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("flex w-full min-w-0 items-center gap-1.5 rounded px-1 text-start hover:bg-accent focus-visible:-outline-offset-2", large ? "border bg-card p-2 text-sm pointer-coarse:min-h-11" : "text-xs", off && "text-muted-foreground line-through")}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
      {/* Times read left to right in every language: they do not mirror with the grid. */}
      {!o.all_day && <span dir="ltr" className="shrink-0 tabular-nums">{large ? `${timeFmt(new Date(o.start))} – ${timeFmt(new Date(o.end))}` : timeFmt(new Date(o.start))}</span>}
      {/* dir="auto": a left-to-right title in a right-to-left cell is cut at its end, not its start. */}
      <span dir="auto" className="min-w-0 truncate text-start" title={o.subject}>
        {o.subject}
      </span>
      {large && o.location && <span className="ms-auto hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{isolate(o.location)}</span>}
      {large && o.recurring && <Repeat className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("Repeats")} />}
    </button>
  );
}

/** The quick form a click or drag on empty time opens: title, when, guests; "More options" goes to the full editor with what is typed. */
function QuickCreate({ draft, onClose, onSaved }: { draft: { start: Date; end: Date; allDay?: boolean; at?: { x: number; y: number } }; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate();
  const box = useRef<HTMLFormElement>(null);
  const [subject, setSubject] = useState("");
  const [guests, setGuests] = useState("");
  const [allDay, setAllDay] = useState(!!draft.allDay);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const close = () => {
    onClose();
    opener.current?.focus?.();
  };
  useDismiss(box, !busy, close);
  const day = new Date(draft.start.getFullYear(), draft.start.getMonth(), draft.start.getDate());
  const when = allDay ? longDay(day) : `${longDay(draft.start)} · ${timeFmt(draft.start)} – ${timeFmt(draft.end)}`;
  const utcDay = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
  const times = allDay ? { starts_at: utcDay(day), ends_at: utcDay(plus(day, 1)) } : { starts_at: draft.start.toISOString(), ends_at: draft.end.toISOString() };
  const more = () => {
    const q = new URLSearchParams({ ...times, subject });
    if (guests.trim()) q.set("guests", guests);
    if (allDay) q.set("all_day", "1");
    navigate(`/calendar/e/new?${q}`);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const g = parseGuests(guests);
    if (g.bad.length) return setProblem(t("Not an email address: {value}", { value: g.bad.join(", ") }));
    setBusy(true);
    setProblem(null);
    try {
      const made = await api.post<{ id: string }>(docPath("CalendarEvent"), {
        subject: subject.trim() || t("(no title)"),
        ...times,
        all_day: allDay,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attendees: g.emails.map((email) => ({ email, response: "Needs Action" })),
      });
      onSaved();
      onClose();
      const said = g.emails.length ? t("Event saved. Your guests were told.") : t("Event saved");
      announce(said);
      toast(said, "success", {
        action: {
          label: t("Undo"),
          onSelect: () =>
            void api.del(docPath("CalendarEvent", made.id)).then(
              () => {
                onSaved();
                toast(t("Event removed"));
              },
              (err) => toast(t("Could not undo: {e}", { e: errorMessage(err) }), "error"),
            ),
        },
      });
    } catch (err) {
      setProblem(t("Not saved: {err}", { err: errorMessage(err) }));
      setBusy(false);
    }
  };
  // Beside the slot where there is room (on its far side in right-to-left); centred on a phone.
  const W = window.innerWidth;
  const rtl = document.documentElement.dir === "rtl";
  const pos = draft.at && W >= 768 ? { top: Math.min(Math.max(8, draft.at.y - 40), window.innerHeight - 330), [rtl ? "right" : "left"]: Math.max(8, Math.min(rtl ? W - draft.at.x + 12 : draft.at.x + 12, W - 352)) } : undefined;
  return (
    <form
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-label={t("New event")}
      onSubmit={save}
      className={cn("fixed z-50 grid w-[min(21rem,calc(100vw-2rem))] gap-3 rounded-lg border bg-popover p-4 text-sm shadow-lg", !pos && "inset-x-4 top-24 mx-auto")}
      style={pos}
    >
      <Input autoFocus aria-label={t("Title")} placeholder={t("Add a title")} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
      <p className="text-muted-foreground">{isolate(when)}</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> {t("All day")}
      </label>
      <div className="grid gap-1">
        <Label htmlFor="qc-guests" className="text-xs text-muted-foreground">
          {t("Guests (email addresses)")}
        </Label>
        <Input id="qc-guests" value={guests} placeholder={t("name@example.com, …")} onChange={(e) => setGuests(e.target.value)} />
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {isolate(problem)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="link" size="sm" className="me-auto px-0" onClick={more}>
          {t("More options")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t("Saving…") : t("Save")}
        </Button>
      </div>
    </form>
  );
}

/** Which occurrences of a repeating event a change or deletion is for. */
function ScopeDialog({ title, onPick }: { title: string; onPick: (s: Scope | null) => void }) {
  const [scope, setScope] = useState<Scope>("this");
  const options: [Scope, string][] = [
    ["this", t("This event")],
    ["following", t("This and following events")],
    ["all", t("All events")],
  ];
  return (
    <Dialog open onOpenChange={(v) => !v && onPick(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{isolate(title)}</DialogTitle>
          <DialogDescription>{t("It repeats. Which ones?")}</DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2 text-sm">
          <legend className="sr-only">{t("Which events")}</legend>
          {options.map(([v, label]) => (
            <label key={v} className="flex items-center gap-2 pointer-coarse:min-h-11">
              <input type="radio" name="scope" value={v} checked={scope === v} onChange={() => setScope(v)} /> {isolate(label)}
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={() => onPick(null)}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => onPick(scope)}>{t("OK")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const shortcuts = (): [string, string[]][] => [
  [t("Day view"), ["d"]],
  [t("Work week view"), ["x"]],
  [t("Week view"), ["w"]],
  [t("Month view"), ["m"]],
  [t("Agenda"), ["a"]],
  [t("Year view"), ["y"]],
  [t("Today"), ["t"]],
  [t("Next day, week or month"), ["j", "n", "→"]],
  [t("Previous day, week or month"), ["k", "p", "←"]],
  [t("New event"), ["c"]],
  [t("Search events"), ["/"]],
  [t("Close a dialog or search"), ["Esc"]],
  [t("Move the focused event 15 minutes"), ["Alt", "↑ ↓"]],
  [t("Move the focused event a day"), ["Alt", "← →"]],
  [t("Make the focused event shorter or longer"), ["Alt", "Shift", "↑ ↓"]],
  [t("These shortcuts"), ["?"]],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Keyboard shortcuts")}</DialogTitle>
          <DialogDescription>{t("They work on the calendar, not while you are typing.")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
          {shortcuts().map(([label, ks]) => (
            <div key={label} className="contents">
              <dt>{isolate(label)}</dt>
              <dd className="flex gap-1">
                {ks.map((k) => (
                  <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {isolate(k)}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** Import an `.ics` file into my calendar (`POST /calendar/import`). */
function ImportItem({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const read = async (file: File) => {
    if (file.size > 5_000_000) return toast(t("That file is larger than 5 MB."), "error");
    try {
      const text = await file.text();
      const r = await api.post<{ created: number; updated: number; failed: unknown[]; warnings: string[] }>(`${CALENDAR}/import`, { ics: text });
      onDone();
      const said = t("Imported {file}: {created} new, {updated} updated", { file: file.name, created: r.created, updated: r.updated });
      toast(r.failed.length ? `${said}. ${t("{n} could not be imported.", { n: r.failed.length })}` : said, r.failed.length ? "info" : "success");
      announce(said);
    } catch (e) {
      toast(t("Not imported: {e}", { e: errorMessage(e) }), "error");
    }
  };
  return (
    <>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          input.current?.click();
        }}
      >
        <Upload /> {t("Import an .ics file")}
      </DropdownMenuItem>
      <input
        ref={input}
        type="file"
        accept=".ics,text/calendar"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void read(f);
        }}
      />
    </>
  );
}

/** The secret address other calendar apps subscribe to: made (shown once, with Copy), made again (the old one stops working) or turned off. */
function FeedDialog({ onClose }: { onClose: () => void }) {
  const state = useQuery({ queryKey: ["calendar", "feed"], queryFn: ({ signal }) => api.get<{ active: boolean }>(`${CALENDAR}/feed`, undefined, signal) });
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (method: "POST" | "DELETE") => {
    setBusy(true);
    try {
      const r = method === "POST" ? await api.post<{ url?: string; path?: string }>(`${CALENDAR}/feed`) : await api.del<{ active: boolean }>(`${CALENDAR}/feed`);
      const got = method === "POST" ? ((r as { url?: string; path?: string }).url ?? new URL((r as { path?: string }).path ?? "", location.origin).href) : null;
      setUrl(got);
      void state.refetch();
      toast(method === "POST" ? t("A new secret address is ready") : t("The secret address is turned off"));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Secret address for other calendars")}</DialogTitle>
          <DialogDescription>{t("Google Calendar, Outlook and phone apps can subscribe to it and show your events. Anyone who has it can see them: share it with nobody.")}</DialogDescription>
        </DialogHeader>
        {state.isLoading ? (
          <Skeleton className="h-9" />
        ) : state.error ? (
          <Failure error={state.error} onRetry={() => void state.refetch()} />
        ) : url ? (
          <div className="grid gap-2 text-sm">
            <Label htmlFor="feed-url">{t("Copy it now: it is shown only once.")}</Label>
            <div className="flex gap-2">
              <Input id="feed-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              <Button
                onClick={() =>
                  void navigator.clipboard.writeText(url).then(
                    () => toast(t("Copied")),
                    () => toast(t("Select the address and copy it."), "info"),
                  )
                }
              >
                {t("Copy")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm">{state.data?.active ? t("You have a secret address. Make a new one if you lost it or someone else has it: the old one stops working.") : t("You have no secret address yet.")}</p>
        )}
        <DialogFooter>
          {state.data?.active && (
            <Button variant="ghost" disabled={busy} onClick={() => void act("DELETE")}>
              {t("Turn it off")}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={() => void act("POST")}>
            {state.data?.active ? t("Make a new address") : t("Make an address")}
          </Button>
          <Button onClick={onClose}>{t("Done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** My working days and hours (on my zone's clock), and time away: it shows on my calendar, can decline invitations in it with my message, and links to Mail's vacation reply. */
function HoursDialog({ current, missing, first, onClose, onSaved }: { current?: PersonHours; missing: boolean; first: number; onClose: () => void; onSaved: () => void }) {
  const [h, setH] = useState<PersonHours>(() => ({ ...DEFAULT_HOURS, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...current }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<PersonHours>) => setH((x) => ({ ...x, ...patch }));
  const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (i + first) % 7);
  const dayName = (d: number) => new Date(2026, 10, 1 + d).toLocaleDateString(userLocale(), { weekday: "short" }); // 1 Nov 2026 is a Sunday
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api.put(`${CALENDAR}/hours`, { days: h.days, from: h.from, to: h.to, timezone: h.timezone || null, away_from: h.away_from || null, away_to: h.away_to || null, away_decline: !!h.away_decline && !!h.away_from, away_message: h.away_message || null });
      onSaved();
      onClose();
      toast(t("Working hours saved"));
    } catch (err) {
      setProblem((err as { status?: number }).status === 404 ? t("This server does not keep working hours yet. Ask your administrator to update Comms.") : t("Not saved: {err}", { err: errorMessage(err) }));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("Working hours and time away")}</DialogTitle>
            <DialogDescription>{t("Colleagues finding a time see when you work and when you are away, never more.")}</DialogDescription>
          </DialogHeader>
          {missing && <p className="text-sm text-muted-foreground">{t("This server does not keep working hours yet: what you set here is not saved until Comms is updated.")}</p>}
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("Working days")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {order.map((d) => (
                <label key={d} className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm pointer-coarse:min-h-11", h.days.includes(d) && "border-primary bg-primary-soft")}>
                  <input type="checkbox" checked={h.days.includes(d)} onChange={(e) => set({ days: e.target.checked ? [...h.days, d].sort() : h.days.filter((x) => x !== d) })} /> {isolate(dayName(d))}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="wh-from">{t("From")}</Label>
              <Input id="wh-from" type="time" value={h.from} onChange={(e) => set({ from: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wh-to">{t("To")}</Label>
              <Input id="wh-to" type="time" value={h.to} onChange={(e) => set({ to: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wh-zone">{t("Time zone")}</Label>
              <ZoneSelect id="wh-zone" value={h.timezone ?? ""} onChange={(z) => set({ timezone: z || null })} />
            </div>
          </div>
          <fieldset className="grid gap-3 border-t pt-3">
            <legend className="pt-3 text-sm font-medium">{t("Out of office")}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="wh-away-from">{t("First day")}</Label>
                <Input id="wh-away-from" type="date" value={h.away_from ?? ""} onChange={(e) => set({ away_from: e.target.value || null })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wh-away-to">{t("Last day")}</Label>
                <Input id="wh-away-to" type="date" value={h.away_to ?? ""} min={h.away_from ?? undefined} onChange={(e) => set({ away_to: e.target.value || null })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!h.away_decline} disabled={!h.away_from} onChange={(e) => set({ away_decline: e.target.checked })} /> {t("Decline new invitations for events then")}
            </label>
            <div className="grid gap-1.5">
              <Label htmlFor="wh-msg">{t("Message with the answer")}</Label>
              <Textarea id="wh-msg" rows={2} maxLength={500} value={h.away_message ?? ""} placeholder={t("I am away until …")} onChange={(e) => set({ away_message: e.target.value })} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Mail can answer messages for the same days:")}{" "}
              <a className="text-primary underline" href="/mail?settings=vacation">
                {t("set the vacation reply in Mail")}
              </a>
            </p>
          </fieldset>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {isolate(problem)}
            </p>
          )}
          <DialogFooter>
            {h.away_from && (
              <Button type="button" variant="ghost" className="sm:me-auto" onClick={() => set({ away_from: null, away_to: null, away_decline: false })}>
                {t("Clear time away")}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("Saving…") : t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const RESPONSES = ["Accepted", "Tentative", "Declined"] as const;

/** Who is on an event and what each answered (`GET /calendar/events/{id}`: for the organizer and the guests). */
interface Detail {
  attendees: Guest[];
  owner: string;
  owner_name?: string | null;
}

function OccurrenceDialog({ o, onClose, onChanged, onEdit, onDelete }: { o: Occurrence; onClose: () => void; onChanged: () => void; onEdit: () => void; onDelete: () => void }) {
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
  const lang = userLocale();
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    ? new Date(o.start).toLocaleDateString(lang, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    : `${new Date(o.start).toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long" })}, ${timeFmt(new Date(o.start))} – ${timeFmt(new Date(o.end))}`;
  // The event's own zone beside mine when they differ.
  const theirs = !o.all_day && o.timezone && o.timezone !== mine ? `${timeFmt(new Date(o.start), o.timezone)} – ${timeFmt(new Date(o.end), o.timezone)} ${o.timezone.replaceAll("_", " ")}` : null;
  const rsvp = async (r: (typeof RESPONSES)[number]) => {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(`${CALENDAR}/events/${o.event}/rsvp`, { response: r, note: note.trim() });
      setResponse(r);
      setNote("");
      onChanged();
      void qc.invalidateQueries({ queryKey: ["calendar", "detail", o.event] });
      toast(`${t("Replied: {answer}.", { answer: t(answerWord(r)).toLowerCase() })} ${by ? t("{by} is told.", { by }) : ""}`.trim());
    } catch (e) {
      setProblem(t("Your answer was not sent: {e}", { e: errorMessage(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className={cn(cancelled && "line-through")}>{isolate(o.subject)}</DialogTitle>
          <DialogDescription>
            {isolate(when)}
            {theirs && (
              <span className="block text-xs">
                {t("In the event's time zone: {when}", { when: theirs })}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {o.status && o.status !== "Confirmed" && <Badge variant="secondary">{isolate(o.status)}</Badge>}
            {o.recurring && (
              <Badge variant="outline">
                <Repeat /> {t("Repeats")}
              </Badge>
            )}
            {o.category && <Badge variant="outline">{isolate(o.category)}</Badge>}
          </div>
          {o.location && (
            <p className="flex items-center gap-1.5">
              <MapPin className="size-4 text-muted-foreground" aria-hidden="true" /> {isolate(o.location)}
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
          {o.description && <p className="whitespace-pre-line text-muted-foreground">{isolate(o.description)}</p>}
          {by && !o.is_organizer && <p className="text-xs text-muted-foreground">{t("Organized by {by}", { by })}</p>}
          {response !== null && !cancelled && (
            <div className="grid gap-2 border-t pt-2">
              <span className="text-xs font-medium text-muted-foreground">{response === "Needs Action" ? t("Will you go? You have not answered yet.") : t("Will you go?")}</span>
              <div className="flex gap-2">
                {RESPONSES.map((r) => (
                  <Button key={r} size="sm" variant={response === r ? "default" : "outline"} disabled={busy} aria-pressed={response === r} onClick={() => void rsvp(r)}>
                    {t(answerWord(r))}
                  </Button>
                ))}
              </div>
              <Textarea value={note} rows={2} maxLength={500} placeholder={t("A note for {value} (sent with your next answer)", { value: by || t("the organizer") })} aria-label={t("A note with your answer")} onChange={(e) => setNote(e.target.value)} />
              {problem && (
                <p role="alert" className="text-xs text-destructive">
                  {isolate(problem)}
                </p>
              )}
            </div>
          )}
          {guests.length > 0 && (
            <div className="grid gap-1 border-t pt-2">
              <span className="text-xs font-medium text-muted-foreground">
                {guests.length} {guests.length === 1 ? t("guest") : t("guests")}: {isolate(tally(guests))}
              </span>
              <ul className="grid gap-1" aria-label={t("Guests")}>
                {guests.map((g) => (
                  <li key={g.email} className="grid">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{g.name || g.email}</span>
                      <span className={cn("shrink-0 text-xs", g.response === "Accepted" ? "text-success" : g.response === "Declined" ? "text-destructive" : "text-muted-foreground")}>{t(answerWord(g.response))}</span>
                    </span>
                    {g.comment && <span className="border-s-2 ps-2 text-xs text-muted-foreground">{isolate(g.comment)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          {o.is_organizer && (
            <Button variant="ghost" className="sm:me-auto" onClick={onDelete}>
              {t("Delete")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
          {o.is_organizer && <Button onClick={onEdit}>{t("Edit event")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
