// What Comms does for other apps (Ferrum docs/plan/apps-ui.md §11.3, §11.4), each in the asking
// app's dialog or beside its page, talking to it only through the shell:
//   compose email   (mail/_intent/compose)     {to?, cc?, subject?, body?, attachments?: [{url, name}]} → {sent: true}
//   schedule event  (calendar/_intent/schedule) {subject?, starts_at?, ends_at?, attendees?, location?, description?, meeting?, record?: {entity, id}} → {id}
//   share record    (chat/_intent/share)       {entity, id, title?} → {channel}
// and Chat as the bar's side panel (chat/_panel).

import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Route, Routes } from "react-router";
import { api, docPath, errorMessage, shell, type IntentRequest } from "@ferrum/client";
import { EmptyState, Spinner, toast } from "@ferrum/kit";
import { Button, Input, Label, Textarea } from "@ferrum/kit/primitives";
import { ChatBase, ChatPage } from "./Chat";
import { Compose, MailUnavailable, useMailboxes } from "./Mail";
import { CHAT, type ChannelSummary } from "./lib/chat";
import { mailAccount, useMailSession } from "./lib/mail";
import { meetLink } from "./lib/meet";

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
  if (error) return <EmptyState title="Nothing to write">{error}</EmptyState>;
  if (session.error) return <MailUnavailable error={session.error} />;
  if (!req || !session.data || !account || !boxes.data) return <Spinner label="Opening Mail" />;
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
  if (error) return <EmptyState title="Nothing to schedule">{error}</EmptyState>;
  if (!req || !form) return <Spinner label="Opening Calendar" />;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const record = (req.data as { record?: { entity?: unknown; id?: unknown } } | null)?.record;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const starts = new Date(form.starts);
    const ends = new Date(form.ends);
    if (!form.subject.trim()) return toast("Give the meeting a subject.", "error");
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) return toast("The meeting must end after it starts.", "error");
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
      if (form.meeting) await api.patch(docPath("CalendarEvent", made.id), { meeting_link: meetLink("event", made.id) });
      shell().intent.done({ id: made.id });
    } catch (err) {
      toast(errorMessage(err), "error");
      setBusy(false);
    }
  };
  return (
    <form className="grid gap-3 p-4" onSubmit={save}>
      <h1 className="text-lg font-semibold">Schedule a meeting</h1>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-s`}>Subject</Label>
        <Input id={`${ids}-s`} autoFocus value={form.subject} maxLength={200} onChange={(e) => set({ subject: e.target.value })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-from`}>Starts</Label>
          <Input id={`${ids}-from`} type="datetime-local" value={form.starts} onChange={(e) => set({ starts: e.target.value })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-to`}>Ends</Label>
          <Input id={`${ids}-to`} type="datetime-local" value={form.ends} onChange={(e) => set({ ends: e.target.value })} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-a`}>Guests</Label>
        <Input id={`${ids}-a`} value={form.attendees} placeholder="ana@acme.example, …" onChange={(e) => set({ attendees: e.target.value })} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-l`}>Where</Label>
        <Input id={`${ids}-l`} value={form.location} maxLength={200} onChange={(e) => set({ location: e.target.value })} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-d`}>Notes</Label>
        <Textarea id={`${ids}-d`} rows={4} value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.meeting} onChange={(e) => set({ meeting: e.target.checked })} /> Add a video meeting
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => shell().intent.cancel()} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Scheduling…" : "Schedule"}
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
  if (error) return <EmptyState title="Nothing to share">{error}</EmptyState>;
  const d = (req?.data ?? {}) as { entity?: unknown; id?: unknown; title?: unknown };
  if (req && (typeof d.entity !== "string" || typeof d.id !== "string")) return <EmptyState title="Nothing to share">The app did not say which record.</EmptyState>;
  if (!req || !channels.data) return channels.error ? <EmptyState title="Chat is not available">{errorMessage(channels.error)}</EmptyState> : <Spinner label="Opening Chat" />;
  const title = (typeof d.title === "string" && d.title.trim()) || `${d.entity} ${d.id}`;
  const link = `/open/${encodeURIComponent(d.entity as string)}/${encodeURIComponent(d.id as string)}`;
  const share = async (e: FormEvent) => {
    e.preventDefault();
    if (!channel) return toast("Pick a conversation.", "error");
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
      <h1 className="text-lg font-semibold">Share in Chat</h1>
      <p className="text-sm text-muted-foreground">“{title}” goes to the conversation as a link; only people who may open it see it.</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-c`}>Conversation</Label>
        <select id={`${ids}-c`} className="h-9 rounded-md border bg-background px-2 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)} autoFocus>
          <option value="">Choose…</option>
          {channels.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-n`}>Message</Label>
        <Textarea id={`${ids}-n`} rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => shell().intent.cancel()} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !channel}>
          {busy ? "Sharing…" : "Share"}
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
