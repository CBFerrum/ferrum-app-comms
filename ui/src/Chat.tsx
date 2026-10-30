// Team chat on the Mail app's chat API: channels and direct conversations, threads, mentions,
// edits, read markers, all kept current by the live socket's `chat` pushes (ids only; the
// screen refetches through the API, which enforces membership).

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AtSign, Hash, Lock, MessageSquare, MessagesSquare, Paperclip, Pencil, Plus, Search, Trash2, Video, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Badge } from "@ferrum/kit/primitives";
import { Button } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { Input } from "@ferrum/kit/primitives";
import { Label } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { Textarea } from "@ferrum/kit/primitives";
import { api, download, errorMessage, fetchBlob, newKey } from "@ferrum/client";
import {
  CHAT,
  MAX_FILES,
  attachmentPath,
  attachmentsOf,
  bodyTooLong,
  continues,
  fileSize,
  mentionsIn,
  showMentions,
  splitChannels,
  startsDay,
  timeline,
  type Attachment,
  type Channel,
  type ChannelSummary,
  type Message,
  type Person,
} from "./lib/chat";
import { uploadFile, type StoredFile } from "@ferrum/client";
import { relativeTime } from "@ferrum/client";
import { openCall, useMeetAvailable } from "./lib/meet";
import { useLivePush } from "@ferrum/kit";
import { useMe } from "@ferrum/records";
import { cn } from "@ferrum/kit";
import { confirmDialog, ErrorState, toast } from "@ferrum/kit";
import { Markdown } from "@ferrum/kit";
import { usePeople } from "@ferrum/records";

const keys = {
  channels: ["chat", "channels"] as const,
  channel: (id: string) => ["chat", "channel", id] as const,
  messages: (id: string) => ["chat", "messages", id] as const,
  thread: (id: string) => ["chat", "thread", id] as const,
};

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

/** Where Chat's pages are: `/chat` on its own page, `/chat/_panel` in the bar's side panel. */
const Base = createContext("/chat");
export const ChatBase = Base.Provider;

function ChannelIcon({ c }: { c: Pick<ChannelSummary, "type"> }) {
  if (c.type === "Direct") return <MessageSquare className="size-4 shrink-0" aria-hidden="true" />;
  if (c.type === "Private") return <Lock className="size-4 shrink-0" aria-hidden="true" />;
  return <Hash className="size-4 shrink-0" aria-hidden="true" />;
}

export function ChatPage() {
  const { channel } = useParams();
  const qc = useQueryClient();
  const channels = useQuery({
    queryKey: keys.channels,
    queryFn: ({ signal }) => api.get<{ channels: ChannelSummary[] }>(`${CHAT}/channels`, { include: "public" }, signal),
  });
  const onPush = useCallback(
    (data: Record<string, unknown> | null) => {
      void qc.invalidateQueries({ queryKey: keys.channels });
      const ch = typeof data?.channel === "string" ? data.channel : undefined;
      if (!data || ch) {
        void qc.invalidateQueries({ queryKey: ch ? keys.messages(ch) : ["chat", "messages"] });
        void qc.invalidateQueries({ queryKey: ["chat", "thread"] });
      }
      if (!data || ["channel_updated", "added", "removed"].includes(String(data.event))) void qc.invalidateQueries({ queryKey: ["chat", "channel"] });
    },
    [qc],
  );
  useLivePush("chat", onPush);

  if (channels.error) return <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />;
  return (
    <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 md:grid-cols-[280px_minmax(0,1fr)]">
      <aside className={cn("min-h-0 border-r", channel && "hidden md:block")} aria-label="Conversations">
        <ChannelList list={channels.data?.channels} loading={channels.isLoading} active={channel} />
      </aside>
      <section className={cn("min-h-0", !channel && "hidden md:grid md:place-items-center")}>
        {channel ? (
          <Conversation key={channel} id={channel} summary={channels.data?.channels.find((c) => c.id === channel)} />
        ) : (
          <p className="text-sm text-muted-foreground">Pick a conversation, or start one.</p>
        )}
      </section>
    </div>
  );
}

function ChannelList({ list, loading, active }: { list?: ChannelSummary[]; loading: boolean; active?: string }) {
  const base = useContext(Base);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<"channel" | "direct" | null>(null);
  const [searching, setSearching] = useState(false);
  const f = filter.trim().toLowerCase();
  const { mine, joinable } = splitChannels((list ?? []).filter((c) => !f || c.title.toLowerCase().includes(f) || c.name.toLowerCase().includes(f)));
  const row = (c: ChannelSummary) => (
    <li key={c.id}>
      <Link
        to={`${base}/${c.id}`}
        aria-current={c.id === active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent pointer-coarse:min-h-11",
          c.id === active && "bg-accent font-medium",
          c.unread > 0 && "font-semibold",
        )}
      >
        <ChannelIcon c={c} />
        <span className="min-w-0 flex-1 truncate">{c.title || c.name}</span>
        {c.unread > 0 && (
          <Badge className="h-5 min-w-5 justify-center px-1.5" aria-label={`${c.unread} unread`}>
            {c.unread > 99 ? "99+" : c.unread}
          </Badge>
        )}
      </Link>
    </li>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-1">
        <h1 className="flex-1 px-1 font-semibold">Chat</h1>
        <Button size="icon-sm" variant="ghost" aria-label="Search messages" onClick={() => setSearching(true)}>
          <Search />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="New direct message" onClick={() => setCreating("direct")}>
          <MessageSquare />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="New channel" onClick={() => setCreating("channel")}>
          <Plus />
        </Button>
      </div>
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" />
      <nav className="min-h-0 flex-1 overflow-y-auto">
        {loading && <Skeleton className="h-40" />}
        <ul className="grid gap-0.5">{mine.map(row)}</ul>
        {!loading && !mine.length && <p className="px-2 py-4 text-sm text-muted-foreground">No conversations yet.</p>}
        {joinable.length > 0 && (
          <>
            <h2 className="mt-4 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Channels you can join</h2>
            <ul className="mt-1 grid gap-0.5">{joinable.map(row)}</ul>
          </>
        )}
      </nav>
      {creating === "channel" && <NewChannel onClose={() => setCreating(null)} />}
      {creating === "direct" && <NewDirect onClose={() => setCreating(null)} />}
      {searching && <SearchDialog onClose={() => setSearching(false)} />}
    </div>
  );
}

function Conversation({ id, summary }: { id: string; summary?: ChannelSummary }) {
  const base = useContext(Base);
  const qc = useQueryClient();
  const me = useMe().data;
  const people = usePeople().data?.users ?? [];
  const [thread, setThread] = useState<string | null>(null);
  const channel = useQuery({ queryKey: keys.channel(id), queryFn: ({ signal }) => api.get<Channel>(`${CHAT}/channels/${id}`, undefined, signal) });
  const messages = useInfiniteQuery({
    queryKey: keys.messages(id),
    queryFn: ({ pageParam, signal }) =>
      api.get<{ messages: Message[]; next_cursor?: string | null }>(`${CHAT}/channels/${id}/messages`, { limit: 50, cursor: pageParam || undefined }, signal),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const list = useMemo(() => timeline((messages.data?.pages ?? []).map((p) => p.messages)), [messages.data]);
  const member = !!(channel.data?.role ?? summary?.role);
  const owner = (channel.data?.role ?? summary?.role) === "Owner";
  const meet = useMeetAvailable().data === true;
  const latest = list[list.length - 1]?.id;

  // Read up to the newest message while the conversation is open and visible.
  useEffect(() => {
    if (!latest || !member || document.visibilityState !== "visible") return;
    const t = setTimeout(() => {
      void api
        .post(`${CHAT}/channels/${id}/read`, {})
        .then(() => qc.invalidateQueries({ queryKey: keys.channels }))
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [latest, member, id, qc]);

  const join = async () => {
    try {
      await api.post(`${CHAT}/channels/${id}/join`, {});
      void qc.invalidateQueries({ queryKey: ["chat"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (channel.error) return <ErrorState error={channel.error} onRetry={() => void channel.refetch()} />;
  const c = channel.data;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_auto]">
      <header className="flex items-center gap-2 border-b px-3 py-2 xl:col-span-2">
        <Button asChild variant="ghost" size="icon-sm" className="md:hidden" aria-label="Back to conversations">
          <Link to={base}>
            <ArrowLeft />
          </Link>
        </Button>
        {c ? <ChannelIcon c={c} /> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{c?.title || c?.name || summary?.title || "…"}</h2>
          {c?.topic && <p className="truncate text-xs text-muted-foreground">{c.topic}</p>}
        </div>
        {c && c.type !== "Direct" && (
          <span className="text-xs text-muted-foreground">
            {c.members.length} {c.members.length === 1 ? "member" : "members"}
          </span>
        )}
        {c && meet && !c.archived && (
          <Button asChild variant="ghost" size="icon-sm" aria-label="Call" title="Start or join this conversation's call">
            {/* The call opens in a window of its own, which outlives this page (docs/plan/apps-ui.md §12.6). */}
            <a href={`/meet/channel/${id}`} onClick={(e) => openCall(e, `/meet/channel/${id}`)}>
              <Video />
            </a>
          </Button>
        )}
      </header>
      <MessageList
        list={list}
        people={people}
        me={me?.user.email ?? ""}
        canModerate={owner}
        loading={messages.isLoading}
        error={messages.error}
        hasMore={!!messages.hasNextPage}
        loadMore={() => void messages.fetchNextPage()}
        loadingMore={messages.isFetchingNextPage}
        onThread={setThread}
        className="row-start-2"
      />
      <div className="row-start-3 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {member ? (
          <Composer channel={id} people={people} placeholder={`Message ${c?.type === "Direct" ? c.title : `#${c?.name ?? ""}`}`} />
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <span className="flex-1 text-muted-foreground">You are reading a public channel.</span>
            <Button onClick={() => void join()}>Join channel</Button>
          </div>
        )}
      </div>
      {thread && <Thread channel={id} root={thread} people={people} me={me?.user.email ?? ""} canModerate={owner} member={member} onClose={() => setThread(null)} />}
    </div>
  );
}

function MessageList(p: {
  list: Message[];
  people: Person[];
  me: string;
  canModerate: boolean;
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
  onThread?: (id: string) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const last = p.list[p.list.length - 1]?.id;
  // Stay at the newest message unless the reader scrolled up to older ones.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last, p.list.length]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className={cn("min-h-0 overflow-y-auto px-3 py-2", p.className)}
      role="log"
      aria-live="polite"
      aria-label="Messages"
    >
      {p.hasMore && (
        <div className="py-2 text-center">
          <Button variant="ghost" size="sm" onClick={p.loadMore} disabled={p.loadingMore}>
            {p.loadingMore ? "Loading…" : "Earlier messages"}
          </Button>
        </div>
      )}
      {p.loading && <Skeleton className="h-32" />}
      {!!p.error && <p className="text-sm text-destructive">{errorMessage(p.error)}</p>}
      {!p.loading && !p.list.length && <p className="py-8 text-center text-sm text-muted-foreground">No messages yet. Say hello.</p>}
      {p.list.map((m, i) => (
        <div key={m.id}>
          {startsDay(m, p.list[i - 1]) && (
            <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground" role="separator">
              <span className="h-px flex-1 bg-border" />
              {day(m.posted_at)}
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <MessageRow m={m} compact={continues(m, p.list[i - 1])} people={p.people} mine={m.sender.toLowerCase() === p.me.toLowerCase()} canModerate={p.canModerate} onThread={p.onThread} />
        </div>
      ))}
    </div>
  );
}

function MessageRow({ m, compact, people, mine, canModerate, onThread }: { m: Message; compact: boolean; people: Person[]; mine: boolean; canModerate: boolean; onThread?: (id: string) => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const name = m.sender_name || m.sender;
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete this message?", message: "Its text and attachments are erased for everyone.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.del(`${CHAT}/messages/${m.id}`);
      void qc.invalidateQueries({ queryKey: ["chat"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    // Focusable so a tap (or Tab) shows the message's actions on touch screens and keyboards.
    <article
      tabIndex={0}
      className={cn("group relative flex gap-2 rounded-md px-1 outline-none hover:bg-muted/40 focus-visible:bg-muted/40", compact ? "py-0.5" : "mt-2 py-1")}
      aria-label={`${name} at ${time(m.posted_at)}`}
    >
      <div className="w-8 shrink-0">
        {!compact && (
          <span className="grid size-8 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden="true">
            {initials(name)}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{name}</span>
            <time className="text-xs text-muted-foreground" dateTime={m.posted_at}>
              {time(m.posted_at)}
            </time>
          </div>
        )}
        {m.deleted ? (
          <p className="text-sm text-muted-foreground italic">This message was deleted.</p>
        ) : editing ? (
          <EditBox m={m} onDone={() => setEditing(false)} />
        ) : (
          <>
            {m.body && <Markdown source={showMentions(m.body, people)} />}
            <Attachments files={attachmentsOf(m)} />
          </>
        )}
        {((m.edited_at && !m.deleted) || (onThread && (m.reply_count ?? 0) > 0)) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
            {m.edited_at && !m.deleted && <span className="text-muted-foreground">(edited)</span>}
            {onThread && (m.reply_count ?? 0) > 0 && (
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => onThread(m.id)}>
                {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}
                {m.last_reply_at && <span className="ml-1 font-normal text-muted-foreground">· {relativeTime(m.last_reply_at)}</span>}
              </button>
            )}
          </div>
        )}
      </div>
      {!m.deleted && !editing && (
        <div className="absolute -top-3 right-1 z-10 hidden gap-0.5 rounded-md border bg-background p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
          {onThread && (
            <Button variant="ghost" size="icon-sm" aria-label="Reply in thread" onClick={() => onThread(m.id)}>
              <MessagesSquare />
            </Button>
          )}
          {mine && (
            <Button variant="ghost" size="icon-sm" aria-label="Edit message" onClick={() => setEditing(true)}>
              <Pencil />
            </Button>
          )}
          {(mine || canModerate) && (
            <Button variant="ghost" size="icon-sm" aria-label="Delete message" onClick={() => void remove()}>
              <Trash2 />
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/** A message's files: images shown, others as chips; a click downloads either. */
function Attachments({ files }: { files: Attachment[] }) {
  if (!files.length) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-2" aria-label="Attachments">
      {files.map((a) => (
        <li key={a.id} className="min-w-0 max-w-full">
          {a.content_type?.startsWith("image/") ? <AttachedImage a={a} /> : <FileChip a={a} />}
        </li>
      ))}
    </ul>
  );
}

const saveFile = (a: Attachment) => download(attachmentPath(a.id), a.file_name).catch((e: unknown) => toast(errorMessage(e), "error"));

function FileChip({ a }: { a: Attachment }) {
  return (
    <button
      type="button"
      onClick={() => void saveFile(a)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-accent pointer-coarse:min-h-11"
      aria-label={`Download ${a.file_name}`}
    >
      <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{a.file_name}</span>
      {a.size != null && <span className="shrink-0 text-muted-foreground">{fileSize(a.size)}</span>}
    </button>
  );
}

/** An image file, fetched with the session (an <img> cannot send it); a chip if it will not load. */
function AttachedImage({ a }: { a: Attachment }) {
  const q = useQuery({ queryKey: ["chat", "file", a.id], queryFn: ({ signal }) => fetchBlob(attachmentPath(a.id), signal), staleTime: Infinity, retry: 1 });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const u = URL.createObjectURL(q.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [q.data]);
  if (q.isError) return <FileChip a={a} />;
  if (!url) return <Skeleton className="h-32 w-48" />;
  return (
    <button type="button" onClick={() => void saveFile(a)} className="block overflow-hidden rounded-md border" aria-label={`Download ${a.file_name}`}>
      <img src={url} alt={a.file_name} className="max-h-48 max-w-full object-contain sm:max-w-xs" />
    </button>
  );
}

function EditBox({ m, onDone }: { m: Message; onDone: () => void }) {
  const qc = useQueryClient();
  const [body, setBody] = useState(m.body);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!body.trim() || bodyTooLong(body)) return;
    setBusy(true);
    try {
      await api.patch(`${CHAT}/messages/${m.id}`, { body });
      void qc.invalidateQueries({ queryKey: ["chat"] });
      onDone();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1.5">
      <Textarea
        value={body}
        autoFocus
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        aria-label="Edit message"
        className="min-h-16"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy || !body.trim()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A file picked for the next message: uploading, uploaded (`stored`) or refused (`error`). */
interface Pending {
  key: string;
  name: string;
  size: number;
  stored?: StoredFile;
  error?: string;
}

function Composer({ channel, parent, people, placeholder }: { channel: string; parent?: string; people: Person[]; placeholder: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [mentioning, setMentioning] = useState(false);
  const [files, setFiles] = useState<Pending[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const tooLong = bodyTooLong(body);
  const uploading = files.some((f) => !f.stored && !f.error);
  const ready = files.filter((f) => f.stored);
  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    const room = Math.max(0, MAX_FILES - files.length);
    if (picked.length > room) toast(`A message carries at most ${MAX_FILES} files.`, "error");
    for (const file of picked.slice(0, room)) {
      const key = newKey();
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size }]);
      uploadFile(file).then(
        (stored) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, stored } : f))),
        (e: unknown) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: errorMessage(e) } : f))),
      );
    }
  };
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if ((!text && !ready.length) || tooLong || busy || uploading) return;
    setBusy(true);
    try {
      const attachments = ready.map((f) => ({ id: f.stored!.id }));
      await api.post(`${CHAT}/channels/${channel}/messages`, { body: text, parent, mentions: mentionsIn(text), attachments });
      setBody("");
      setFiles([]);
      void qc.invalidateQueries({ queryKey: parent ? keys.thread(parent) : keys.messages(channel) });
      if (parent) void qc.invalidateQueries({ queryKey: keys.messages(channel) });
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const mention = (p: Person) => {
    setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}<@${p.email}> `);
    setMentioning(false);
    box.current?.focus();
  };
  return (
    <form
      onSubmit={send}
      className="grid gap-1.5"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Files to send">
          {files.map((f) => (
            <li key={f.key} className={cn("flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs", f.error && "border-destructive text-destructive")}>
              <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-muted-foreground">{f.error ? f.error : f.stored ? fileSize(f.size) : "Uploading…"}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={box}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return;
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={tooLong || undefined}
          rows={1}
          className="max-h-40 min-h-10 flex-1 resize-none"
        />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="icon" aria-label="Attach files" onClick={() => picker.current?.click()}>
          <Paperclip />
        </Button>
        <Button type="button" variant="outline" size="icon" aria-label="Mention someone" onClick={() => setMentioning((v) => !v)}>
          <AtSign />
        </Button>
        <Button type="submit" disabled={busy || uploading || (!body.trim() && !ready.length) || tooLong}>
          Send
        </Button>
      </div>
      {tooLong && <p className="text-xs text-destructive">Messages are at most 4 KB.</p>}
      {mentioning && <PeoplePicker people={people} onPick={mention} onClose={() => setMentioning(false)} />}
      <p className="text-xs text-muted-foreground">Enter sends, Shift+Enter starts a new line. **bold**, *italic*, `code` and links work.</p>
    </form>
  );
}

function PeoplePicker({ people, onPick, onClose }: { people: Person[]; onPick: (p: Person) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const f = q.trim().toLowerCase();
  const shown = people.filter((p) => !f || p.email.toLowerCase().includes(f) || (p.full_name ?? "").toLowerCase().includes(f)).slice(0, 8);
  return (
    <div className="rounded-md border bg-popover p-2 shadow-md">
      <div className="flex items-center gap-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" aria-label="Find a person" onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <ul className="mt-1 grid">
        {shown.map((p) => (
          <li key={p.id}>
            <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => onPick(p)}>
              {p.full_name || p.email} <span className="text-muted-foreground">{p.email}</span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-1.5 text-sm text-muted-foreground">Nobody matches.</li>}
      </ul>
    </div>
  );
}

function Thread({ channel, root, people, me, canModerate, member, onClose }: { channel: string; root: string; people: Person[]; me: string; canModerate: boolean; member: boolean; onClose: () => void }) {
  const replies = useQuery({
    queryKey: keys.thread(root),
    queryFn: ({ signal }) => api.get<{ messages: Message[] }>(`${CHAT}/channels/${channel}/messages`, { thread: root, limit: 200 }, signal),
  });
  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 grid w-full grid-rows-[auto_minmax(0,1fr)_auto] border-l bg-background shadow-xl sm:w-[420px] xl:static xl:z-auto xl:row-span-2 xl:row-start-2 xl:w-[360px] xl:shadow-none"
      aria-label="Thread"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h3 className="flex-1 font-semibold">Thread</h3>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" onClick={onClose}>
          <X />
        </Button>
      </header>
      <MessageList
        list={timeline([replies.data?.messages ?? []])}
        people={people}
        me={me}
        canModerate={canModerate}
        loading={replies.isLoading}
        error={replies.error}
        hasMore={false}
        loadMore={() => undefined}
        loadingMore={false}
      />
      <div className="border-t p-3">{member ? <Composer channel={channel} parent={root} people={people} placeholder="Reply in thread" /> : null}</div>
    </aside>
  );
}

function NewChannel({ onClose }: { onClose: () => void }) {
  const base = useContext(Base);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const people = usePeople().data?.users ?? [];
  const me = useMe().data?.user.email.toLowerCase();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [type, setType] = useState<"Public" | "Private">("Public");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api.post<Channel>(`${CHAT}/channels`, { name: name.trim(), type, topic: topic.trim() || undefined, members });
      void qc.invalidateQueries({ queryKey: keys.channels });
      onClose();
      navigate(`${base}/${c.id}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>Public channels are open to everyone who uses chat; private ones only to their members.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ch-name">Name</Label>
            <Input id="ch-name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="sales-team" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ch-topic">Topic (optional)</Label>
            <Input id="ch-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>
          <fieldset className="flex gap-4 text-sm">
            <legend className="mb-1 text-sm font-medium">Who can find it</legend>
            {(["Public", "Private"] as const).map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input type="radio" name="ch-type" checked={type === t} onChange={() => setType(t)} /> {t}
              </label>
            ))}
          </fieldset>
          <fieldset className="grid max-h-48 gap-1 overflow-y-auto text-sm">
            <legend className="mb-1 font-medium">Members</legend>
            {people
              .filter((p) => p.email.toLowerCase() !== me)
              .map((p) => (
                <label key={p.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={members.includes(p.email)}
                    onChange={(e) => setMembers((m) => (e.target.checked ? [...m, p.email] : m.filter((x) => x !== p.email)))}
                  />
                  {p.full_name || p.email}
                </label>
              ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewDirect({ onClose }: { onClose: () => void }) {
  const base = useContext(Base);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const people = usePeople().data?.users ?? [];
  const me = useMe().data?.user.email.toLowerCase();
  const open = async (p: Person) => {
    try {
      const c = await api.post<Channel>(`${CHAT}/direct`, { user: p.email });
      void qc.invalidateQueries({ queryKey: keys.channels });
      onClose();
      navigate(`${base}/${c.id}`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New direct message</DialogTitle>
          <DialogDescription>Pick the person to talk to.</DialogDescription>
        </DialogHeader>
        <PeoplePicker people={people.filter((p) => p.email.toLowerCase() !== me)} onPick={(p) => void open(p)} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const base = useContext(Base);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const people = usePeople().data?.users ?? [];
  const results = useQuery({
    queryKey: ["chat", "search", term],
    queryFn: ({ signal }) => api.get<{ messages: Message[] }>(`${CHAT}/search`, { q: term, limit: 50 }, signal),
    enabled: term.length >= 2,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Search messages</DialogTitle>
          <DialogDescription>In your conversations and public channels.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(q.trim());
          }}
          className="flex gap-2"
        >
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least two characters" aria-label="Search text" />
          <Button type="submit" disabled={q.trim().length < 2}>
            Search
          </Button>
        </form>
        <ul className="grid max-h-80 gap-2 overflow-y-auto">
          {results.isFetching && <Skeleton className="h-16" />}
          {results.data?.messages.map((m) => (
            <li key={m.id}>
              <Link to={`${base}/${m.channel}`} onClick={onClose} className="block rounded-md border p-2 text-sm hover:bg-accent">
                <span className="font-medium">{m.sender_name || m.sender}</span> <span className="text-xs text-muted-foreground">{relativeTime(m.posted_at)}</span>
                <span className="mt-0.5 line-clamp-2 block text-muted-foreground">{showMentions(m.body, people)}</span>
              </Link>
            </li>
          ))}
          {results.data && !results.data.messages.length && <li className="text-sm text-muted-foreground">Nothing found.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
