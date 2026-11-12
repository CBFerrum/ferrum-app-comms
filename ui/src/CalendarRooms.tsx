// Rooms and resources: choosing one for an event ("Add a room", with the free ones big enough for
// the time suggested first), seeing a room's bookings, and keeping them (Comms Managers, from
// Calendar's menu). A room is a guest whose address no mail goes to; it answers at once.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DoorOpen, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Badge, Button, Input, Label, Skeleton } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { announce, confirmDialog, toast } from "@ferrum/kit";
import { api, errorMessage, isolate, t } from "@ferrum/client";
import { CALENDAR, isRoom, type Room } from "./lib/calendar";
import { Failure } from "./States";

/** Every room and resource, and whether I keep them; a server before Comms 0.18 has none (nothing is offered). */
export function useRooms() {
  return useQuery({ queryKey: ["calendar", "rooms"], queryFn: ({ signal }) => api.get<{ rooms: Room[]; manager: boolean }>(`${CALENDAR}/rooms`, undefined, signal), retry: false, staleTime: 120_000 });
}

/** A room's line: its name, size and place. */
export const roomLine = (r: Room) => [r.name, r.capacity ? t("{count} people", { count: r.capacity }) : null, r.place].filter(Boolean).join(" · ");

/** "Add a room": the free ones big enough for the time first, then every room I may book. */
export function RoomPicker({ when, people, taken, exclude, onPick }: { when: { starts: Date; ends: Date } | null; people: number; taken: string[]; exclude?: string; onPick: (r: Room) => void }) {
  const [open, setOpen] = useState(false);
  const rooms = useRooms();
  const free = useQuery({
    queryKey: ["calendar", "rooms", "suggest", when?.starts.getTime(), when?.ends.getTime(), people, exclude],
    queryFn: ({ signal }) => api.get<{ rooms: Room[] }>(`${CALENDAR}/rooms/suggest`, { from: when!.starts.toISOString(), to: when!.ends.toISOString(), people: String(Math.max(1, people)), ...(exclude ? { exclude } : {}) }, signal),
    enabled: open && !!when,
    retry: false,
  });
  if (rooms.isError || (rooms.data && rooms.data.rooms.length === 0)) return null;
  const mine = (rooms.data?.rooms ?? []).filter((r) => r.may_book && !taken.includes(r.address));
  const suggested = (free.data?.rooms ?? []).filter((r) => !taken.includes(r.address));
  const pick = (r: Room) => {
    onPick(r);
    setOpen(false);
  };
  const item = (r: Room, hint?: string) => (
    <li key={r.address}>
      <button type="button" className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-accent pointer-coarse:min-h-11" onClick={() => pick(r)}>
        <DoorOpen className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{isolate(roomLine(r))}</span>
        {hint && <span className="shrink-0 text-xs text-success">{hint}</span>}
      </button>
    </li>
  );
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setOpen(true)}>
        <DoorOpen /> {t("Add a room")}
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("Add a room")}</DialogTitle>
              <DialogDescription>{t("A room answers at once: yes when it is free and can be booked then, no with the reason otherwise.")}</DialogDescription>
            </DialogHeader>
            {when && (
              <section className="grid gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">{t("Free then, for {count} or more", { count: Math.max(1, people) })}</h3>
                {free.isLoading ? (
                  <Skeleton className="h-16" />
                ) : free.error ? (
                  <Failure error={free.error} onRetry={() => void free.refetch()} title={t("Free rooms could not be found")} />
                ) : suggested.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("No room is free then for this many people. Try another time.")}</p>
                ) : (
                  <ul aria-label={t("Free rooms")}>{suggested.map((r) => item(r, t("Free")))}</ul>
                )}
              </section>
            )}
            <section className="grid gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t("All rooms and resources you may book")}</h3>
              {rooms.isLoading ? <Skeleton className="h-16" /> : mine.length === 0 ? <p className="text-sm text-muted-foreground">{t("None you may book.")}</p> : <ul aria-label={t("Rooms and resources")}>{mine.map((r) => item(r))}</ul>}
            </section>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("Close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

const DAYS = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d: number) => new Date(2027, 0, 3 + d).toLocaleDateString([], { weekday: "short" });

interface Draft {
  id?: string;
  name: string;
  kind: "Room" | "Resource";
  capacity: string;
  place: string;
  limited: boolean;
  days: number[];
  from: string;
  to: string;
  timezone: string;
  bookers: string;
}

const blank = (): Draft => ({ name: "", kind: "Room", capacity: "", place: "", limited: true, days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, bookers: "" });

/** Calendar's settings for Comms Managers: the workspace's rooms and resources. */
export function RoomsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const rooms = useRooms();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const edit = (r?: Room) =>
    setDraft(
      r
        ? {
            id: r.id,
            name: r.name,
            kind: r.kind,
            capacity: r.capacity ? String(r.capacity) : "",
            place: r.place ?? "",
            limited: !!r.hours,
            days: r.hours?.days ?? [1, 2, 3, 4, 5],
            from: r.hours?.from ?? "08:00",
            to: r.hours?.to ?? "18:00",
            timezone: r.hours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            bookers: r.bookers.map((b) => b.role ?? b.person).join(", "),
          }
        : blank(),
    );
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setProblem(null);
    const bookers = draft.bookers
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (x.includes("@") ? { person: x } : { role: x }));
    const body = {
      name: draft.name.trim(),
      kind: draft.kind,
      capacity: draft.capacity ? Number(draft.capacity) : null,
      place: draft.place.trim() || null,
      hours: draft.limited ? { days: draft.days, from: draft.from, to: draft.to, timezone: draft.timezone || null } : null,
      bookers,
    };
    try {
      if (draft.id) await api.patch(`${CALENDAR}/rooms/${draft.id}`, body);
      else await api.post(`${CALENDAR}/rooms`, body);
      await qc.invalidateQueries({ queryKey: ["calendar", "rooms"] });
      const said = t("{name} saved", { name: body.name });
      toast(said);
      announce(said);
      setDraft(null);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: Room) => {
    if (!(await confirmDialog({ title: t("Remove {name}?", { name: r.name }), message: t("It can no longer be booked. Events that booked it keep it in their guest list."), confirmLabel: t("Remove"), danger: true }))) return;
    try {
      await api.del(`${CALENDAR}/rooms/${r.id}`);
      await qc.invalidateQueries({ queryKey: ["calendar", "rooms"] });
      toast(t("{name} removed", { name: r.name }));
    } catch (err) {
      toast(t("Not removed: {e}", { e: errorMessage(err) }), "error");
    }
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Rooms and resources")}</DialogTitle>
          <DialogDescription>{t("People add a room to an event like a guest. It accepts when it is free and can be booked then.")}</DialogDescription>
        </DialogHeader>
        {rooms.isLoading ? (
          <Skeleton className="h-24" />
        ) : rooms.error ? (
          <Failure error={rooms.error} onRetry={() => void rooms.refetch()} title={t("Rooms could not be read")} />
        ) : draft ? (
          <form onSubmit={save} className="grid gap-3" aria-label={draft.id ? t("Change {name}", { name: draft.name }) : t("New room or resource")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-name`}>{t("Name")}</Label>
                <Input id={`${id}-name`} autoFocus required maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-kind`}>{t("Kind")}</Label>
                <select id={`${id}-kind`} className="h-(--control-h) rounded-md border border-input bg-card px-2 text-sm" value={draft.kind} onChange={(e) => set({ kind: e.target.value as Draft["kind"] })}>
                  <option value="Room">{t("Room")}</option>
                  <option value="Resource">{t("Resource (a projector, a car)")}</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-cap`}>{t("Holds (people)")}</Label>
                <Input id={`${id}-cap`} type="number" min={1} inputMode="numeric" value={draft.capacity} onChange={(e) => set({ capacity: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-place`}>{t("Where it is")}</Label>
                <Input id={`${id}-place`} maxLength={200} value={draft.place} onChange={(e) => set({ place: e.target.value })} />
              </div>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t("When it can be booked")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!draft.limited} onChange={(e) => set({ limited: !e.target.checked })} /> {t("Any time")}
              </label>
              {draft.limited && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((d) => (
                      <label key={d} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm pointer-coarse:min-h-11">
                        <input type="checkbox" checked={draft.days.includes(d)} onChange={(e) => set({ days: e.target.checked ? [...draft.days, d] : draft.days.filter((x) => x !== d) })} /> {isolate(dayName(d))}
                      </label>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <div className="grid gap-1">
                      <Label htmlFor={`${id}-from`}>{t("From")}</Label>
                      <Input id={`${id}-from`} type="time" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`${id}-to`}>{t("To")}</Label>
                      <Input id={`${id}-to`} type="time" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
                    </div>
                    <div className="col-span-2 grid gap-1 sm:col-span-1">
                      <Label htmlFor={`${id}-zone`}>{t("Time zone")}</Label>
                      <Input id={`${id}-zone`} dir="ltr" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} />
                    </div>
                  </div>
                </>
              )}
            </fieldset>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-who`}>{t("Who may book it")}</Label>
              <Input id={`${id}-who`} value={draft.bookers} placeholder={t("Everyone, if left empty")} onChange={(e) => set({ bookers: e.target.value })} />
              <p className="text-xs text-muted-foreground">{t("Emails of people, or names of groups (roles), separated by commas.")}</p>
            </div>
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {isolate(problem)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={busy || !draft.name.trim()}>
                {busy ? t("Saving…") : t("Save")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            {rooms.data!.rooms.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("No rooms or resources yet.")}</p>
            ) : (
              <ul className="grid gap-1" aria-label={t("Rooms and resources")}>
                {rooms.data!.rooms.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                    <DoorOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{isolate(roomLine(r))}</span>
                      <span className="block text-xs text-muted-foreground">{r.everyone ? t("Everyone may book it") : t("Only some people may book it")}</span>
                    </span>
                    {r.kind === "Resource" && <Badge variant="outline">{t("Resource")}</Badge>}
                    {rooms.data!.manager && (
                      <>
                        <Button size="xs" variant="ghost" onClick={() => edit(r)}>
                          {t("Change")}
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label={t("Remove {name}", { name: r.name })} onClick={() => void remove(r)}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("Close")}
              </Button>
              {rooms.data!.manager && (
                <Button type="button" onClick={() => edit()}>
                  <Plus /> {t("Add a room or resource")}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { isRoom };
