// What Comms does for other apps (Ferrum docs/plan/apps-ui.md §11.3, §11.4), each in the asking
// app's dialog or beside its page, talking to it only through the shell:
//   compose email   (mail/_intent/compose)     {to?, cc?, subject?, body?, attachments?: [{url, name}]} → {sent: true}
//   schedule event  (calendar/_intent/schedule) {subject?, starts_at?, ends_at?, attendees?, location?, description?, meeting?, record?: {entity, id}} → {id}
//   share record    (chat/_intent/share)       {entity, id, title?} → {channel}
// and Chat as the bar's side panel (chat/_panel).

import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Route, Routes } from "react-router";
import { api, docPath, errorMessage, shell, type IntentRequest, t, isolate } from "@ferrum/client";
import { EmptyState, Spinner, toast } from "@ferrum/kit";
import { Button, Input, Label, Textarea } from "@ferrum/kit/primitives";
import { useMe, usePeople } from "@ferrum/records";
import { ChatBase, ChatPage } from "./Chat";
import { Compose, MailUnavailable, useMailboxes } from "./Mail";
import { CHAT, type ChannelSummary } from "./lib/chat";
import { mailAccount, useMailSession } from "./lib/mail";
import { CALENDAR, clashes, fromInput, parseGuests, stretch, suggestSlots, toInput, type BusyMap } from "./lib/calendar";
import { meetLink, useMeetAvailable } from "./lib/meet";

/** The intent this page answers, once the asking page has said. */
function useIntent() {
  const [req, setReq] = useState<IntentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    shell()
      .intent.request()
      .then(setReq, (e: unknown) => setError(errorMessage(e)));
  }, []);
  return { req, error };
}

const text = (v: unknown, max = 10_000) => (typeof v === "string" ? v.slice(0, max) : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** `compose email`: Mail's composer, filled in by the asking app. */
export function ComposeIntentPage() {
  const { req, error } = useIntent();
  const session = useMailSession(!!req);
  const account = mailAccount(session.data);
  const boxes = useMailboxes(account);
  if (error) return <EmptyState title={t("Nothing to write")}>{isolate(error)}</EmptyState>;
  if (session.error) return <MailUnavailable error={session.error} />;
  if (!req || !session.data || !account || !boxes.data) return <Spinner label={t("Opening Mail")} />;
  const d = (req.data ?? {}) as Record<string, unknown>;
  const attachments = (Array.isArray(d.attachments) ? d.attachments : [])
    .map((a) => a as { url?: unknown; name?: unknown })
    .filter((a): a is { url: string; name: string } => typeof a.url === "string" && typeof a.name === "string")
    .slice(0, 20);
  return (
    <Compose
      account={account}
      me={session.data.accounts[account]?.name ?? session.data.username}
      boxes={boxes.data}
      draft={{ kind: "new", prefill: { to: list(d.to).join(", "), cc: list(d.cc).join(", "), subject: text(d.subject, 900), body: text(d.body) }, attach: attachments }}
      onSent={() => shell().intent.done({ sent: true })}
      onClose={() => shell().intent.cancel()}
    />
  );
}

/** A date for `<input type="datetime-local">`, in this browser's time. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `schedule event`: a meeting on the person's calendar, with the asking app's details. */
export function ScheduleIntentPage() {
  const { req, error } = useIntent();
  const ids = useId();
  const meets = useMeetAvailable().data === true;
  const me = useMe().data?.user.email.toLowerCase();
  const people = usePeople().data?.users ?? [];
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ subject: string; starts: string; ends: string; attendees: string; location: string; description: string; meeting: boolean } | null>(null);
  useEffect(() => {
    if (!req || form) return;
    const d = (req.data ?? {}) as Record<string, unknown>;
    const at = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
    // The next whole hour, for half an hour, unless the asking app says when.
    const next = new Date();
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    const starts = at(d.starts_at) ?? next;
    const ends = at(d.ends_at) ?? new Date(starts.getTime() + 30 * 60_000);
    setForm({
      subject: text(d.subject, 200) ?? "",
      starts: localInput(starts),
      ends: localInput(ends > starts ? ends : new Date(starts.getTime() + 30 * 60_000)),
      attendees: list(d.attendees).join(", "),
      location: text(d.location, 200) ?? "",
      description: text(d.description) ?? "",
      meeting: d.meeting === true,
    });
  }, [req, form]);
  // Colleagues among the guests: when they are free, so a clash shows before the invitation goes.
  const guests = parseGuests(form?.attendees ?? "").emails.filter((e) => people.some((p) => p.email.toLowerCase() === e));
  const span = form ? { starts: fromInput(form.starts), ends: fromInput(form.ends) } : null;
  const day = span?.starts ? new Date(span.starts.getFullYear(), span.starts.getMonth(), span.starts.getDate()) : null;
  const free = useQuery({
    queryKey: ["calendar", "busy", "intent", guests.join(","), day?.toISOString()],
    queryFn: ({ signal }) =>
      api.post<{ busy: BusyMap }>(`${CALENDAR}/freebusy`, { users: [...new Set([me, ...guests])].filter(Boolean), from: day!.toISOString(), to: new Date(day!.getTime() + 8 * 86_400_000).toISOString() }, { signal }).then((r) => r.busy),
    enabled: !!me && guests.length > 0 && !!day,
    staleTime: 60_000,
  });
  if (error) return <EmptyState title={t("Nothing to schedule")}>{isolate(error)}</EmptyState>;
  if (!req || !form) return <Spinner label={t("Opening Calendar")} />;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const names = (list: string[]) => list.map((e) => (e === me ? "You" : people.find((p) => p.email.toLowerCase() === e)?.full_name || e));
  const clash = free.data && span?.starts && span.ends ? clashes(free.data, span.starts, span.ends) : [];
  const minutes = span?.starts && span.ends ? Math.max(15, Math.round((span.ends.getTime() - span.starts.getTime()) / 60_000)) : 30;
  const better = clash.length && free.data && span?.starts ? suggestSlots(free.data, { from: new Date(Math.max(Date.now(), span.starts.getTime() - 3_600_000)), days: 8, minutes, limit: 3 }) : [];
  const record = (req.data as { record?: { entity?: unknown; id?: unknown } } | null)?.record;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const starts = new Date(form.starts);
    const ends = new Date(form.ends);
    if (!form.subject.trim()) return toast(t("Give the meeting a subject."), "error");
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) return toast(t("The meeting must end after it starts."), "error");
    const emails = form.attendees
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      const made = await api.post<{ id: string }>(docPath("CalendarEvent"), {
        subject: form.subject.trim(),
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        location: form.location.trim() || null,
        description: form.description.trim() || null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attendees: emails.map((email) => ({ email })),
        reference_entity: typeof record?.entity === "string" ? record.entity : null,
        reference_id: typeof record?.id === "string" ? record.id : null,
      });
      if (form.meeting && meets) await api.patch(docPath("CalendarEvent", made.id), { meeting_link: meetLink("event", made.id) });
      shell().intent.done({ id: made.id });
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-3 p-4" onSubmit={save}>
      <h1 className="text-lg font-semibold">{t("Schedule a meeting")}</h1>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-s`}>{t("Subject")}</Label>
        <Input id={`${ids}-s`} autoFocus value={form.subject} maxLength={200} onChange={(e) => set({ subject: e.target.value })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-from`}>{t("Starts")}</Label>
          <Input id={`${ids}-from`} type="datetime-local" value={form.starts} onChange={(e) => set({ starts: e.target.value })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-to`}>{t("Ends")}</Label>
          <Input id={`${ids}-to`} type="datetime-local" value={form.ends} onChange={(e) => set({ ends: e.target.value })} />
        </div>
      </div>
      {clash.length > 0 && span?.starts && span.ends && (
        <div role="status" className="grid gap-1.5 rounded-md border border-warning bg-warning-soft px-3 py-2 text-sm">
          <span>
            {isolate(names(clash).join(" and "))} {clash.length === 1 ? t("is") : t("are")} {t("busy (")}{isolate(clash.map((c) => (free.data?.[c] ?? []).filter((b) => Date.parse(b.start) < span.ends!.getTime() && Date.parse(b.end) > span.starts!.getTime()).map(stretch).join(", ")).join("; "))}{t(") then.")}
          </span>
          {better.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {t("Everyone is free:")}
              {better.map((b) => (
                <Button key={b.getTime()} type="button" size="xs" variant="outline" onClick={() => set({ starts: toInput(b), ends: toInput(new Date(b.getTime() + minutes * 60_000)) })}>
                  {isolate(b.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))}, {isolate(b.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
                </Button>
              ))}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-a`}>{t("Guests")}</Label>
        <Input id={`${ids}-a`} value={form.attendees} placeholder="ana@acme.example, …" onChange={(e) => set({ attendees: e.target.value })} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-l`}>{t("Where")}</Label>
        <Input id={`${ids}-l`} value={form.location} maxLength={200} onChange={(e) => set({ location: e.target.value })} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-d`}>{t("Notes")}</Label>
        <Textarea id={`${ids}-d`} rows={4} value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </div>
      {meets ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.meeting} onChange={(e) => set({ meeting: e.target.checked })} /> {t("Add a video meeting")}
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">{t("Video meetings are not set up on this server, so this one will not have a call.")}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => shell().intent.cancel()} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? t("Scheduling…") : t("Schedule")}
        </Button>
      </div>
    </form>
  );
}

/** `share record`: a link to a record, posted to a conversation the person picks. */
export function ShareIntentPage() {
  const { req, error } = useIntent();
  const ids = useId();
  const [channel, setChannel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const channels = useQuery({
    queryKey: ["chat", "channels", "mine"],
    queryFn: ({ signal }) => api.get<{ channels: ChannelSummary[] }>(`${CHAT}/channels`, undefined, signal).then((r) => r.channels.filter((c) => !c.archived)),
    enabled: !!req,
  });
  if (error) return <EmptyState title={t("Nothing to share")}>{isolate(error)}</EmptyState>;
  const d = (req?.data ?? {}) as { entity?: unknown; id?: unknown; title?: unknown };
  if (req && (typeof d.entity !== "string" || typeof d.id !== "string")) return <EmptyState title={t("Nothing to share")}>{t("The app did not say which record.")}</EmptyState>;
  if (!req || !channels.data) return channels.error ? <EmptyState title={t("Chat is not available")}>{isolate(errorMessage(channels.error))}</EmptyState> : <Spinner label={t("Opening Chat")} />;
  const title = (typeof d.title === "string" && d.title.trim()) || `${d.entity} ${d.id}`;
  const link = `/open/${encodeURIComponent(d.entity as string)}/${encodeURIComponent(d.id as string)}`;
  const share = async (e: FormEvent) => {
    e.preventDefault();
    if (!channel) return toast(t("Pick a conversation."), "error");
    setBusy(true);
    try {
      // Markdown's brackets in a title would end the link early.
      const label = title.replace(/[[\]]/g, "");
      await api.post(`${CHAT}/channels/${encodeURIComponent(channel)}/messages`, { body: `${note.trim() ? `${note.trim()}\n\n` : ""}[${label}](${link})` });
      shell().intent.done({ channel });
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-3 p-4" onSubmit={share}>
      <h1 className="text-lg font-semibold">{t("Share in Chat")}</h1>
      <p className="text-sm text-muted-foreground">{t("“{title}” goes to the conversation as a link; only people who may open it see it.", { title })}</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-c`}>{t("Conversation")}</Label>
        <select id={`${ids}-c`} className="h-9 rounded-md border bg-background px-2 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)} autoFocus>
          <option value="">{t("Choose…")}</option>
          {channels.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-n`}>{t("Message")}</Label>
        <Textarea id={`${ids}-n`} rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => shell().intent.cancel()} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={busy || !channel}>
          {busy ? t("Sharing…") : t("Share")}
        </Button>
      </div>
    </form>
  );
}

/** `chat/_panel/…`: Chat beside any app's page (the bar's side panel); one conversation at a
 *  time on its narrow width. */
export function ChatPanel() {
  return (
    <ChatBase value="/chat/_panel">
      <Routes>
        <Route index element={<ChatPage />} />
        <Route path=":channel" element={<ChatPage />} />
      </Routes>
    </ChatBase>
  );
}
