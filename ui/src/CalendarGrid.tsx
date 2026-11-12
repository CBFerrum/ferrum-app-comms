// Days of hours (day, work week, week; three days on a phone): all-day and multi-day events as bars
// across the days on top, timed ones placed by their times side by side where they overlap, the
// current time as a line, hours outside working hours shaded, and a second time zone down the side
// when one is chosen. With a pointer: drag on empty time to make an event (a click makes an hour),
// drag an event to move it and its lower edge to change its length, in steps of 15 minutes with the
// time shown while dragging. With the keyboard on an event: Alt+arrows move it, Alt+Shift+Up/Down
// change its length. Changes go to the page (onChange), which saves them and offers Undo.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Skeleton } from "@ferrum/kit/primitives";
import { cn } from "@ferrum/kit";
import { direction, isolate, t } from "@ferrum/client";
import { atMinutes, barsAcross, isoDay, minutesOf, movable, placeDay, safeColor, snap, userLocale, type Occurrence } from "./lib/calendar";

/** Pixels per hour. */
export const HOUR = 48;
const STEP = 15;

export const timeFmt = (d: Date, zone?: string) => new Intl.DateTimeFormat(userLocale(), { hour: "numeric", minute: "2-digit", timeZone: zone }).format(d);
const hourFmt = (d: Date, zone?: string) => new Intl.DateTimeFormat(userLocale(), { hour: "numeric", timeZone: zone }).format(d);
const range = (a: Date, b: Date) => `${timeFmt(a)} – ${timeFmt(b)}`;

/** The current time, again every minute. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Working hours: minutes from midnight, and the days of the week they apply to (0 Sunday). */
export interface WorkHours {
  from: number;
  to: number;
  days: number[];
}

type Drag =
  | { kind: "create"; day: number; at: number; x: number; y: number; moved: boolean }
  | { kind: "move" | "resize"; o: Occurrence; grab: number; x: number; y: number; moved: boolean; held: boolean; timer?: number };

interface Ghost {
  day: number;
  from: number;
  to: number;
  o?: Occurrence;
}

export function TimeGrid(p: {
  days: Date[];
  list: Occurrence[];
  loading: boolean;
  today: string;
  work: WorkHours;
  zone2?: string;
  onOpen: (o: Occurrence) => void;
  onCreate: (start: Date, end: Date, at: { x: number; y: number }) => void;
  onChange: (o: Occurrence, start: Date, end: Date) => void;
  onDay: (d: Date) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<Drag | null>(null);
  const suppress = useRef(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const now = useNow();
  const rtl = direction(userLocale()) === "rtl";
  useLayoutEffect(() => {
    // Opens at the start of the working day, the current time in view when it is later.
    const at = Math.max(p.work.from / 60 - 0.5, 0);
    scroller.current?.scrollTo({ top: at * HOUR });
  }, [p.work.from]);
  const bars = useMemo(() => barsAcross(p.list, p.days), [p.list, p.days]);
  const rows = bars.reduce((n, b) => Math.max(n, b.row + 1), 0);
  const timed = useMemo(() => p.list.filter((o) => !o.all_day && daysTouched(o) === 1), [p.list]);
  const gutter = p.zone2 ? "7rem" : "3.5rem";
  const template = { gridTemplateColumns: `${gutter} repeat(${p.days.length}, minmax(0, 1fr))` };

  /** The day column and minutes under a pointer. */
  const at = (x: number, y: number): { day: number; minutes: number } | null => {
    const i = cols.current.findIndex((c) => {
      const r = c?.getBoundingClientRect();
      return r && x >= r.left && x < r.right;
    });
    const col = cols.current[i] ?? cols.current[x < (cols.current[0]?.getBoundingClientRect().left ?? 0) ? (rtl ? p.days.length - 1 : 0) : rtl ? 0 : p.days.length - 1];
    if (!col) return null;
    const day = i >= 0 ? i : cols.current.indexOf(col);
    return { day, minutes: ((y - col.getBoundingClientRect().top) / HOUR) * 60 };
  };

  const startCreate = (e: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const minutes = ((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) * 60;
    drag.current = { kind: "create", day, at: minutes, x: e.clientX, y: e.clientY, moved: false };
    if (e.pointerType === "mouse") e.currentTarget.setPointerCapture(e.pointerId);
  };
  const startMove = (e: ReactPointerEvent<HTMLElement>, o: Occurrence, kind: "move" | "resize") => {
    if (e.button !== 0 || !movable(o)) return;
    e.stopPropagation();
    const start = new Date(o.start);
    const here = at(e.clientX, e.clientY);
    const d: Drag = { kind, o, grab: here ? here.minutes - minutesOf(start) : 0, x: e.clientX, y: e.clientY, moved: false, held: e.pointerType === "mouse" };
    // On touch an event moves after a short hold, so a swipe over it is not taken for a drag.
    if (!d.held) d.timer = window.setTimeout(() => (d.held = true), 300);
    drag.current = d;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    if (d.kind !== "create" && !d.held) {
      window.clearTimeout(d.timer);
      drag.current = null;
      return;
    }
    d.moved = true;
    const here = at(e.clientX, e.clientY);
    if (!here) return;
    if (d.kind === "create") {
      const a = snap(Math.min(d.at, here.minutes), STEP);
      const z = Math.max(a + STEP, snap(Math.max(d.at, here.minutes), STEP));
      setGhost({ day: d.day, from: a, to: z });
    } else {
      const s = new Date(d.o.start);
      const length = (Date.parse(d.o.end) - s.getTime()) / 60_000;
      if (d.kind === "move") {
        const from = Math.min(1440 - STEP, snap(here.minutes - d.grab, STEP));
        setGhost({ day: here.day, from, to: Math.min(1440, from + length), o: d.o });
      } else {
        const day = p.days.findIndex((x) => isoDay(x) === isoDay(s));
        const from = minutesOf(s);
        setGhost({ day: day < 0 ? 0 : day, from, to: Math.max(from + STEP, snap(here.minutes, STEP)), o: d.o });
      }
    }
  };
  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind !== "create") window.clearTimeout(d.timer);
    const g = ghost;
    setGhost(null);
    if (d.kind === "create") {
      const day = p.days[d.day]!;
      if (!d.moved || !g) {
        const from = Math.min(1440 - 60, snap(d.at - 15, 30));
        p.onCreate(atMinutes(day, from), atMinutes(day, from + 60), { x: e.clientX, y: e.clientY });
      } else p.onCreate(atMinutes(day, g.from), atMinutes(day, g.to), { x: e.clientX, y: e.clientY });
      return;
    }
    if (!d.moved || !g) return;
    suppress.current = true;
    const day = p.days[g.day]!;
    if (d.kind === "resize") {
      const s = new Date(d.o.start);
      p.onChange(d.o, s, atMinutes(new Date(s.getFullYear(), s.getMonth(), s.getDate()), g.to));
    } else p.onChange(d.o, atMinutes(day, g.from), atMinutes(day, g.to));
  };
  const cancel = () => {
    if (drag.current && drag.current.kind !== "create") window.clearTimeout(drag.current.timer);
    drag.current = null;
    setGhost(null);
  };

  /** Alt+arrows move a focused event (a day sideways, 15 minutes up and down); with Shift, up and down change its end. */
  const onKey = (e: KeyboardEvent<HTMLElement>, o: Occurrence) => {
    if (!e.altKey || !movable(o) || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const s = new Date(o.start);
    const z = new Date(o.end);
    const sign = e.key === "ArrowUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft") ? -1 : 1;
    if (e.shiftKey) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const end = new Date(z.getTime() + sign * STEP * 60_000);
      if (end.getTime() - s.getTime() >= STEP * 60_000) p.onChange(o, s, end);
      return;
    }
    const minutes = e.key === "ArrowUp" || e.key === "ArrowDown" ? sign * STEP : 0;
    const days = minutes ? 0 : sign;
    const start = new Date(s.getFullYear(), s.getMonth(), s.getDate() + days, s.getHours(), s.getMinutes() + minutes);
    p.onChange(o, start, new Date(start.getTime() + z.getTime() - s.getTime()));
  };

  const working = (d: Date) => p.work.days.includes(d.getDay());
  const shade = (d: Date) =>
    working(d)
      ? `linear-gradient(to bottom, var(--muted) 0, var(--muted) ${(p.work.from / 60) * HOUR}px, transparent ${(p.work.from / 60) * HOUR}px, transparent ${(p.work.to / 60) * HOUR}px, var(--muted) ${(p.work.to / 60) * HOUR}px)`
      : "linear-gradient(var(--muted), var(--muted))";
  const lines = `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${HOUR}px)`;

  return (
    <div className="overflow-hidden rounded-lg border bg-card" aria-busy={p.loading || undefined}>
      <div className="grid border-b text-xs font-medium text-muted-foreground" style={template}>
        <div className="grid content-end px-1 pb-1 text-end text-xs font-normal">
          {p.zone2 && <span className="truncate" title={p.zone2}>{isolate(zoneShort(p.zone2))}</span>}
        </div>
        {p.days.map((d) => {
          const key = isoDay(d);
          return (
            <button
              key={key}
              type="button"
              onClick={() => p.onDay(d)}
              aria-label={t("Show {day}", { day: d.toLocaleDateString(userLocale(), { weekday: "long", day: "numeric", month: "long" }) })}
              aria-current={key === p.today ? "date" : undefined}
              className={cn("grid min-w-0 justify-items-center gap-0.5 px-1 py-1.5 hover:bg-accent focus-visible:-outline-offset-2", key === p.today && "text-primary")}
            >
              <span className="truncate uppercase">{isolate(d.toLocaleDateString(userLocale(), { weekday: "short" }))}</span>
              <span className={cn("grid size-7 place-items-center rounded-full text-base font-semibold text-foreground tabular-nums", key === p.today && "bg-primary text-primary-foreground")}>{isolate(d.toLocaleDateString(userLocale(), { day: "numeric" }))}</span>
            </button>
          );
        })}
      </div>
      <div className="grid border-b" style={template}>
        <div className="px-1 py-1.5 text-end text-xs text-muted-foreground">{t("All day")}</div>
        <div className="relative grid min-h-7 gap-0.5 py-0.5" style={{ gridColumn: `2 / span ${p.days.length}`, gridTemplateColumns: `repeat(${p.days.length}, minmax(0, 1fr))`, gridTemplateRows: rows ? `repeat(${rows}, 1.375rem)` : undefined }}>
          {p.days.map((d, i) => (
            <div key={isoDay(d)} aria-hidden="true" className="border-s" style={{ gridColumn: i + 1, gridRow: `1 / span ${Math.max(rows, 1)}` }} />
          ))}
          {p.loading && <Skeleton className="m-0.5 h-5" style={{ gridColumn: "1 / span 2", gridRow: 1 }} />}
          {bars.map((b) => (
            <EventBar key={b.o.id} o={b.o} style={{ gridColumn: `${b.col + 1} / span ${b.span}`, gridRow: b.row + 1 }} before={b.before} after={b.after} onOpen={() => p.onOpen(b.o)} />
          ))}
        </div>
      </div>
      <div ref={scroller} className="max-h-[calc(100dvh-14rem)] min-h-80 overflow-y-auto overscroll-contain">
        <div className="grid" style={{ ...template, height: 24 * HOUR }}>
          <div className="relative" aria-hidden="true">
            {Array.from({ length: 23 }, (_, h) => {
              const at = atMinutes(p.days[0]!, (h + 1) * 60);
              return (
                <span key={h} className="absolute end-1 flex -translate-y-1/2 gap-2 text-xs text-muted-foreground tabular-nums" style={{ top: (h + 1) * HOUR }}>
                  {p.zone2 && <span className="w-12 text-end opacity-75">{isolate(hourFmt(at, p.zone2))}</span>}
                  <span>{isolate(hourFmt(at))}</span>
                </span>
              );
            })}
          </div>
          {p.days.map((d, i) => {
            const key = isoDay(d);
            const ghostHere = ghost && ghost.day === i ? ghost : null;
            return (
              <div
                key={key}
                ref={(el) => {
                  cols.current[i] = el;
                }}
                role="group"
                aria-label={d.toLocaleDateString(userLocale(), { weekday: "long", day: "numeric", month: "long" })}
                className="relative touch-pan-y border-s select-none"
                style={{ backgroundImage: `${lines}, ${shade(d)}` }}
                onPointerDown={(e) => startCreate(e, i)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={cancel}
              >
                {key === p.today && (
                  <div className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-destructive" style={{ top: (minutesOf(now) / 60) * HOUR }}>
                    <span className="absolute -start-1 -top-1 size-2.5 rounded-full bg-destructive" />
                  </div>
                )}
                {placeDay(timed, d).map((pl) => {
                  const dragged = ghost?.o?.id === pl.o.id;
                  const color = safeColor(pl.o.color) ?? "var(--primary)";
                  const off = pl.o.status === "Cancelled" || pl.o.my_response === "Declined";
                  const can = movable(pl.o);
                  const s = new Date(pl.o.start);
                  const z = new Date(pl.o.end);
                  const short = pl.to - pl.from < 45;
                  return (
                    <div
                      key={pl.o.id}
                      className={cn("absolute z-10 overflow-hidden rounded-sm border-s-4 bg-primary-soft text-xs leading-tight shadow-xs", dragged && "opacity-40", off && "text-muted-foreground line-through")}
                      style={{ top: (pl.from / 60) * HOUR + 1, height: Math.max(((pl.to - pl.from) / 60) * HOUR - 2, 18), insetInlineStart: `calc(${(pl.lane / pl.lanes) * 100}% + 1px)`, width: `calc(${100 / pl.lanes}% - 3px)`, borderInlineStartColor: color }}
                    >
                      <button
                        type="button"
                        className={cn("block size-full px-1 text-start focus-visible:-outline-offset-2", can && "cursor-grab touch-none active:cursor-grabbing", short && "flex items-baseline gap-1")}
                        aria-label={t("{subject}, {time}", { subject: pl.o.subject, time: range(s, z) })}
                        aria-keyshortcuts={can ? "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                        onPointerDown={(e) => startMove(e, pl.o, "move")}
                        onPointerMove={onMove}
                        onPointerUp={onUp}
                        onPointerCancel={cancel}
                        onClick={() => {
                          if (suppress.current) suppress.current = false;
                          else p.onOpen(pl.o);
                        }}
                        onKeyDown={(e) => onKey(e, pl.o)}
                      >
                        <span dir="auto" className="block truncate font-medium">{pl.o.subject}</span>
                        <span dir="ltr" className="block truncate text-start text-muted-foreground tabular-nums">{range(s, z)}</span>
                      </button>
                      {can && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize touch-none"
                          onPointerDown={(e) => startMove(e, pl.o, "resize")}
                          onPointerMove={onMove}
                          onPointerUp={onUp}
                          onPointerCancel={cancel}
                        />
                      )}
                    </div>
                  );
                })}
                {ghostHere && (
                  <div className="pointer-events-none absolute inset-x-0.5 z-30 rounded-sm border-2 border-primary bg-primary/15 px-1 text-xs font-medium text-primary" style={{ top: (ghostHere.from / 60) * HOUR, height: Math.max(((ghostHere.to - ghostHere.from) / 60) * HOUR, 16) }}>
                    {ghostHere.o && <span dir="auto" className="block truncate">{ghostHere.o.subject}</span>}
                    <span dir="ltr" className="tabular-nums" role="status">{range(atMinutes(d, ghostHere.from), atMinutes(d, ghostHere.to))}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const daysTouched = (o: Occurrence) => {
  const s = new Date(o.start);
  const last = new Date(Math.max(s.getTime(), Date.parse(o.end) - 1));
  return Math.round((new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime() - new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()) / 86_400_000) + 1;
};

/** "GMT+5:30" or "PST" for a zone, now. */
export function zoneShort(zone: string): string {
  try {
    return new Intl.DateTimeFormat(userLocale(), { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}

/** An all-day or multi-day event as a bar across days; its ends square off where it goes on beyond what is shown. */
export function EventBar({ o, style, before, after, onOpen }: { o: Occurrence; style: React.CSSProperties; before?: boolean; after?: boolean; onOpen: () => void }) {
  const color = safeColor(o.color) ?? "var(--primary)";
  const off = o.status === "Cancelled" || o.my_response === "Declined";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("z-10 mx-0.5 flex min-w-0 items-center gap-1 overflow-hidden rounded-sm px-1.5 text-start text-xs font-medium text-primary-foreground hover:brightness-95 focus-visible:outline-offset-1", before && "ms-0 rounded-s-none", after && "me-0 rounded-e-none", off && "line-through opacity-60")}
      style={{ ...style, background: o.kind === "away" ? "var(--secondary)" : color, color: o.kind === "away" ? "var(--secondary-foreground)" : undefined }}
    >
      {!o.all_day && <span dir="ltr" className="shrink-0 tabular-nums">{timeFmt(new Date(o.start))}</span>}
      <span dir="auto" className="truncate">{o.kind === "away" ? t("Out of office") : o.subject}</span>
    </button>
  );
}
