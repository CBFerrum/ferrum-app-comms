// The side panel's calendars: mine (with a checkbox to show or hide each, its colour, and a menu:
// rename, colour, show only this, share, make default, delete) and those shared with me under
// "Other calendars" with their owner's name and what I may do. Colour is never alone: every
// calendar has its name beside it, and events name their calendar.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button, Input, Label } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@ferrum/kit/primitives";
import { api, errorMessage, isolate, t } from "@ferrum/client";
import { announce, cn, toast } from "@ferrum/kit";
import { CALENDAR, parseGuests, TONES, toneVar, type Cal } from "./lib/calendar";

const HIDDEN_KEY = "ferrum.calendar.hidden-shared";
export const toneName = (tone: string) => ({ blue: t("Blue"), green: t("Green"), amber: t("Amber"), red: t("Red"), purple: t("Purple"), neutral: t("Grey") })[tone] ?? tone;
export const levelName = (l: string) => ({ owner: t("Owner"), edit: t("Can make changes"), details: t("Sees all details"), free_busy: t("Sees only free and busy"), "Free/busy": t("See only free and busy"), Details: t("See all details"), Edit: t("Make changes") })[l] ?? l;

/** My calendars and those shared with me; a server before Comms 0.17 has none (the page then shows every event as before). */
export function useCalendars() {
  const q = useQuery({ queryKey: ["calendar", "calendars"], queryFn: ({ signal }) => api.get<{ calendars: Cal[] }>(`${CALENDAR}/calendars`, undefined, signal).then((r) => r.calendars), retry: false, staleTime: 60_000 });
  const [sharedHidden, setSharedHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const cals = q.data ?? [];
  const hidden = new Set([...cals.filter((c) => c.level === "owner" && c.hidden).map((c) => c.id), ...[...sharedHidden].filter((id) => cals.some((c) => c.id === id && c.level !== "owner"))]);
  const hideShared = (ids: Set<string>) => {
    setSharedHidden(ids);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...ids]));
    } catch {
      // for this visit only
    }
  };
  return { q, cals, hidden, sharedHidden, hideShared };
}

export function CalendarList({ cals, hidden, sharedHidden, hideShared, failed }: { cals: Cal[]; hidden: Set<string>; sharedHidden: Set<string>; hideShared: (ids: Set<string>) => void; failed: boolean }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ kind: "new" | "rename" | "share" | "delete"; cal?: Cal } | null>(null);
  const mine = cals.filter((c) => c.level === "owner");
  const others = cals.filter((c) => c.level !== "owner");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["calendar"] });
  const patch = async (c: Cal, body: Record<string, unknown>, done?: string) => {
    try {
      await api.patch(`${CALENDAR}/calendars/${c.id}`, body);
      refresh();
      if (done) {
        toast(done);
        announce(done);
      }
    } catch (e) {
      toast(t("Not changed: {e}", { e: errorMessage(e) }), "error");
    }
  };
  const show = async (c: Cal, on: boolean) => {
    if (c.level !== "owner") {
      const next = new Set(sharedHidden);
      if (on) next.delete(c.id);
      else next.add(c.id);
      return hideShared(next);
    }
    await patch(c, { hidden: !on });
  };
  const only = async (c: Cal) => {
    hideShared(new Set(others.filter((o) => o.id !== c.id).map((o) => o.id)));
    for (const m of mine) if (m.hidden !== (m.id !== c.id)) await api.patch(`${CALENDAR}/calendars/${m.id}`, { hidden: m.id !== c.id }).catch(() => undefined);
    refresh();
    announce(t("Showing only {name}", { name: c.name }));
  };
  if (failed) return null;
  const row = (c: Cal) => (
    <li key={c.id} className="group flex min-h-8 items-center gap-2 rounded-md pe-1 hover:bg-accent pointer-coarse:min-h-11">
      <label className="flex min-w-0 flex-1 items-center gap-2 ps-1 text-sm">
        <input type="checkbox" checked={!hidden.has(c.id)} onChange={(e) => void show(c, e.target.checked)} style={{ accentColor: toneVar(c.tone) }} />
        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: toneVar(c.tone) }} aria-hidden="true" />
        <span className="min-w-0 truncate" dir="auto">
          {c.name}
        </span>
        {c.level !== "owner" && <span className="sr-only">{`, ${c.owner_name || c.owner}, ${levelName(c.level)}`}</span>}
      </label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={t("Options for {name}", { name: c.name })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void only(c)}>{t("Show only this")}</DropdownMenuItem>
          {c.level === "owner" && (
            <>
              <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", cal: c })}>{t("Rename and colour")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog({ kind: "share", cal: c })}>{t("Share")}</DropdownMenuItem>
              {!c.is_default && <DropdownMenuItem onSelect={() => void patch(c, { is_default: true }, t("New events go in {name}", { name: c.name }))}>{t("Make it the default for new events")}</DropdownMenuItem>}
              {!c.is_default && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "delete", cal: c })}>{t("Delete")}</DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
  return (
    <nav aria-label={t("Calendars")} className="grid gap-3">
      <section className="grid gap-1">
        <div className="flex items-center">
          <h2 className="flex-1 text-xs font-medium text-muted-foreground">{t("My calendars")}</h2>
          <Button variant="ghost" size="icon-xs" aria-label={t("New calendar")} onClick={() => setDialog({ kind: "new" })}>
            <Plus />
          </Button>
        </div>
        <ul className="grid">{mine.map(row)}</ul>
      </section>
      {others.length > 0 && (
        <section className="grid gap-1">
          <h2 className="text-xs font-medium text-muted-foreground">{t("Other calendars")}</h2>
          <ul className="grid">
            {others.map((c) => (
              <div key={c.id} title={`${c.owner_name || c.owner} · ${levelName(c.level)}`}>
                {row(c)}
                <p className="ps-9 text-xs text-muted-foreground">{isolate(c.owner_name || c.owner)}</p>
              </div>
            ))}
          </ul>
        </section>
      )}
      {dialog && <CalendarDialog kind={dialog.kind} cal={dialog.cal} mine={mine} onClose={() => setDialog(null)} onDone={refresh} />}
    </nav>
  );
}

function CalendarDialog({ kind, cal, mine, onClose, onDone }: { kind: "new" | "rename" | "share" | "delete"; cal?: Cal; mine: Cal[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(cal?.name ?? "");
  const [tone, setTone] = useState(cal?.tone ?? "green");
  const [shares, setShares] = useState(cal?.shares ?? []);
  const [person, setPerson] = useState("");
  const [moveTo, setMoveTo] = useState(mine.find((m) => m.is_default)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      if (kind === "new") await api.post(`${CALENDAR}/calendars`, { name, tone });
      else if (kind === "rename") await api.patch(`${CALENDAR}/calendars/${cal!.id}`, { name, tone });
      else if (kind === "share") await api.patch(`${CALENDAR}/calendars/${cal!.id}`, { shares });
      else await api.del(`${CALENDAR}/calendars/${cal!.id}?events=${moveTo === "delete" ? "delete" : `move:${moveTo}`}`);
      onDone();
      onClose();
      const said = kind === "delete" ? t("Calendar deleted") : kind === "share" ? t("Sharing saved") : t("Calendar saved");
      toast(said);
      announce(said);
    } catch (err) {
      setProblem(errorMessage(err));
      setBusy(false);
    }
  };
  const add = () => {
    const got = parseGuests(person);
    if (got.bad.length || !got.emails.length) return setProblem(t("Not an email address: {value}", { value: person }));
    setShares((s) => [...s.filter((x) => !got.emails.includes(x.person)), ...got.emails.map((p) => ({ person: p, level: "Details" as const }))]);
    setPerson("");
    setProblem(null);
  };
  const title = { new: t("New calendar"), rename: t("Rename and colour"), share: t("Share {name}", { name: cal?.name ?? "" }), delete: t("Delete {name}", { name: cal?.name ?? "" }) }[kind];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isolate(title)}</DialogTitle>
            <DialogDescription>
              {kind === "share" ? t("People you share it with see it under Other calendars. Removing someone takes their access away at once.") : kind === "delete" ? t("Its events go to another of your calendars, or are deleted (their guests are told).") : t("Its colour shows on its events in every view.")}
            </DialogDescription>
          </DialogHeader>
          {(kind === "new" || kind === "rename") && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-name">{t("Name")}</Label>
                <Input id="cal-name" autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </div>
              <fieldset className="grid gap-1.5">
                <legend className="mb-1 text-sm font-medium">{t("Colour")}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {TONES.map((x) => (
                    <label key={x} className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm pointer-coarse:min-h-11", tone === x && "border-primary")}>
                      <input type="radio" name="tone" value={x} checked={tone === x} onChange={() => setTone(x)} />
                      <span className="size-3 rounded-sm" style={{ background: toneVar(x) }} aria-hidden="true" />
                      {toneName(x)}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}
          {kind === "share" && (
            <div className="grid gap-2">
              <ul className="grid gap-1.5" aria-label={t("People with access")}>
                {shares.length === 0 && <li className="text-sm text-muted-foreground">{t("Only you.")}</li>}
                {shares.map((s) => (
                  <li key={s.person} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{isolate(s.person)}</span>
                    <select aria-label={t("What {person} may do", { person: s.person })} className="h-8 rounded-md border border-input bg-card px-2 text-sm" value={s.level} onChange={(e) => setShares((all) => all.map((x) => (x.person === s.person ? { ...x, level: e.target.value as typeof s.level } : x)))}>
                      {(["Free/busy", "Details", "Edit"] as const).map((l) => (
                        <option key={l} value={l}>
                          {levelName(l)}
                        </option>
                      ))}
                    </select>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={t("Remove {person}", { person: s.person })} onClick={() => setShares((all) => all.filter((x) => x.person !== s.person))}>
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Input
                  aria-label={t("Add a colleague by email")}
                  placeholder={t("Add a colleague by email")}
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={add} disabled={!person.trim()}>
                  {t("Add")}
                </Button>
              </div>
            </div>
          )}
          {kind === "delete" && (
            <div className="grid gap-1.5">
              <Label htmlFor="cal-move">{t("Its events")}</Label>
              <select id="cal-move" className="h-(--control-h) rounded-md border border-input bg-card px-2 text-sm" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {mine
                  .filter((m) => m.id !== cal?.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {t("Move to {name}", { name: m.name })}
                    </option>
                  ))}
                <option value="delete">{t("Delete them")}</option>
              </select>
            </div>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {isolate(problem)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || ((kind === "new" || kind === "rename") && !name.trim())} variant={kind === "delete" ? "destructive" : "default"}>
              {busy ? t("Saving…") : kind === "delete" ? t("Delete") : t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
