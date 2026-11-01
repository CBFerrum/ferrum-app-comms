// Team chat on the Mail app's chat API: channels and direct conversations, threads, mentions,
// edits, read markers, all kept current by the live socket's `chat` pushes (ids only; the
// screen refetches through the API, which enforces membership). A conversation opens at its first
// unread message; a link, a search result or a notification opens it at the message itself
// (`?m=`); its threads and details open beside it (`?thread=`, `?panel=`).

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellOff, ChevronDown, Hash, Info, Lock, MessageSquare, MessagesSquare, MoreHorizontal, Paperclip, Plus, Search, Users, Video, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useContext, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Skeleton,
  Textarea,
} from "@ferrum/kit/primitives";
import { api, download, errorMessage, fetchBlob, relativeTime, shell } from "@ferrum/client";
import { cn, confirmDialog, EmptyState, ErrorState, Markdown, toast, useLivePush } from "@ferrum/kit";
import { useMe, usePeople } from "@ferrum/records";
import { Composer, PeoplePicker } from "./ChatComposer";
import { ChannelDetails, type DetailsTab } from "./ChatDetails";
import { ChannelSearch, SearchDialog } from "./ChatSearch";
import { Base } from "./chatBase";
import {
  CHAT,
  SIDE_PANEL,
  attachmentPath,
  attachmentsOf,
  badge,
  bodyTooLong,
  continues,
  fileSize,
  filterChannels,
  firstUnread,
  groupChannels,
  initials,
  keys,
  loudness,
  mentionsMe,
  posting,
  refreshMessages,
  showMentions,
  startsDay,
  timeline,
  unreadTotal,
  type Attachment,
  type Channel,
  type ChannelSummary,
  type Message,
  type Person,
  type Show,
} from "./lib/chat";
import { openCall, useMeetAvailable } from "./lib/meet";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

/** Where Chat's pages are: `/chat` on its own page, `/chat/_panel` in the bar's side panel. */
export const ChatBase = Base.Provider;

/** One page of messages: the latest, an older one, or the window around a message. */
interface Page {
  messages: Message[];
  next_cursor?: string | null;
  newer?: boolean;
  target?: Message;
}

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

  // What waits to be read, on the launcher.
  const waiting = unreadTotal(channels.data?.channels ?? []);
  useEffect(() => shell().badge(waiting), [waiting]);
  useEffect(() => () => shell().badge(0), []);

  return (
    <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 md:grid-cols-[280px_minmax(0,1fr)]">
      <aside className={cn("min-h-0 border-r", channel && "hidden md:block")} aria-label="Conversations">
        <ChannelList list={channels.data?.channels} loading={channels.isLoading} error={channels.error} onRetry={() => void channels.refetch()} active={channel} waiting={waiting} />
      </aside>
      <section className={cn("min-h-0", !channel && "hidden md:grid md:place-items-center")}>
        {channel ? (
          <Conversation key={channel} id={channel} summary={channels.data?.channels.find((c) => c.id === channel)} />
        ) : (
          <EmptyState title="Pick a conversation" icon="chat">
            <p className="text-sm text-muted-foreground">Or start a new one from the buttons beside “Chat”.</p>
          </EmptyState>
        )}
      </section>
    </div>
  );
}

const SHOWS: { id: Show; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "mentions", label: "Mentions" },
];

function ChannelList({
  list,
  loading,
  error,
  onRetry,
  active,
  waiting,
}: {
  list?: ChannelSummary[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  active?: string;
  waiting: number;
}) {
  const base = useContext(Base);
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [creating, setCreating] = useState<"channel" | "direct" | null>(null);
  const [searching, setSearching] = useState(false);
  const shown = filterChannels(list ?? [], filter, show);
  const { direct, channels, joinable } = groupChannels(shown);
  const none = !loading && !error && !shown.length;

  const readAll = async () => {
    try {
      await api.post(`${CHAT}/read-all`, {});
      void qc.invalidateQueries({ queryKey: keys.channels });
      toast("Everything is marked as read");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const row = (c: ChannelSummary) => {
    const b = badge(c);
    const quiet = loudness(c) === "Nothing";
    return (
      <li key={c.id}>
        <Link
          to={`${base}/${c.id}`}
          aria-current={c.id === active ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent pointer-coarse:min-h-11",
            c.id === active && "bg-accent font-medium",
            (b.count > 0 || b.mention) && "font-semibold",
            quiet && "text-muted-foreground",
          )}
        >
          <ChannelIcon c={c} />
          <span className="min-w-0 flex-1 truncate">{c.title || c.name}</span>
          {quiet && <BellOff className="size-3.5 shrink-0" aria-label="Muted" />}
          {b.mention && (
            <span className="grid size-5 shrink-0 place-items-center rounded-full border border-destructive bg-destructive-soft text-[11px] leading-none font-bold text-destructive" aria-hidden="true">
              @
            </span>
          )}
          {b.count > 0 && (
            <Badge className="h-5 min-w-5 justify-center px-1.5" aria-hidden="true">
              {b.count > 99 ? "99+" : b.count}
            </Badge>
          )}
          {(b.count > 0 || b.mention) && (
            <span className="sr-only">
              {b.count > 0 ? `${b.count} unread` : ""}
              {b.mention ? ", you were mentioned" : ""}
            </span>
          )}
        </Link>
      </li>
    );
  };

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={waiting === 0} onSelect={() => void readAll()}>
              Mark everything as read
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" />
      <div className="flex gap-1" role="group" aria-label="Show">
        {SHOWS.map((s) => (
          <Button key={s.id} size="xs" variant={show === s.id ? "secondary" : "ghost"} aria-pressed={show === s.id} onClick={() => setShow(s.id)}>
            {s.label}
          </Button>
        ))}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversations" aria-busy={loading}>
        {loading && <Skeleton className="h-40" />}
        {!!error && <ErrorState error={error} onRetry={onRetry} />}
        {direct.length > 0 && (
          <>
            <h2 className="px-2 pt-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Direct messages</h2>
            <ul className="mt-1 grid gap-0.5">{direct.map(row)}</ul>
          </>
        )}
        {channels.length > 0 && (
          <>
            <h2 className="mt-3 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Channels</h2>
            <ul className="mt-1 grid gap-0.5">{channels.map(row)}</ul>
          </>
        )}
        {joinable.length > 0 && (
          <>
            <h2 className="mt-4 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Channels you can join</h2>
            <ul className="mt-1 grid gap-0.5">{joinable.map(row)}</ul>
          </>
        )}
        {none && (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {filter.trim() ? `No conversation matches “${filter.trim()}”.` : show === "unread" ? "Nothing unread. You are up to date." : show === "mentions" ? "Nobody has mentioned you lately." : "No conversations yet. Start one with the buttons above."}
          </p>
        )}
      </nav>
      {creating === "channel" && <NewChannel onClose={() => setCreating(null)} />}
      {creating === "direct" && <NewDirect onClose={() => setCreating(null)} />}
      {searching && <SearchDialog base={base} onClose={() => setSearching(false)} />}
    </div>
  );
}

function Conversation({ id, summary }: { id: string; summary?: ChannelSummary }) {
  const base = useContext(Base);
  const qc = useQueryClient();
  const me = useMe().data;
  const email = me?.user.email ?? "";
  const people = usePeople().data?.users ?? [];
  const [params, setParams] = useSearchParams();
  const target = params.get("m");
  const threadId = params.get("thread");
  const panel = params.get("panel");
  const patch = useCallback(
    (change: Record<string, string | null>) =>
      setParams(
        (p) => {
          for (const [k, v] of Object.entries(change)) {
            if (v === null) p.delete(k);
            else p.set(k, v);
          }
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );

  const channel = useQuery({
    queryKey: keys.channel(id),
    queryFn: ({ signal }) => api.get<Channel>(`${CHAT}/channels/${id}`, undefined, signal),
    refetchOnMount: "always",
  });
  const feed = useInfiniteQuery({
    queryKey: keys.messages(id, target),
    queryFn: ({ pageParam, signal }) =>
      api.get<Page>(`${CHAT}/channels/${id}/messages`, pageParam ? { limit: 50, cursor: pageParam } : target ? { around: target, limit: 40 } : { limit: 50 }, signal),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
  const list = useMemo(() => timeline((feed.data?.pages ?? []).map((p) => p.messages)), [feed.data]);
  const found = target ? feed.data?.pages[0]?.target : undefined;
  const c = channel.data;
  const view = c ?? summary;
  const member = !!view?.role;
  const owner = view?.role === "Owner";
  const meet = useMeetAvailable().data === true;
  const latest = list[list.length - 1]?.id;

  // Where "new" starts is decided when the conversation opens: reading it must not move it, and
  // the list waits for it, or it would open at the bottom and then jump.
  const [readAt, setReadAt] = useState<string | null | undefined>(undefined);
  const [divider, setDivider] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (readAt === undefined && channel.data && channel.isFetchedAfterMount) setReadAt(channel.data.last_read_at ?? null);
  }, [readAt, channel.data, channel.isFetchedAfterMount]);
  useEffect(() => {
    if (divider !== undefined || feed.isLoading) return;
    if (target) setDivider(null);
    else if (readAt !== undefined) setDivider(member ? (firstUnread(list, readAt, email)?.id ?? null) : null);
  }, [divider, feed.isLoading, target, readAt, member, list, email]);
  const placing = divider === undefined && !channel.isError;

  // A message found by a link that is a reply opens its thread.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (found?.parent && opened.current !== found.id) {
      opened.current = found.id;
      patch({ thread: found.parent, panel: null });
    }
  }, [found, patch]);

  // Read up to the newest message once the person is at the bottom of an open, visible conversation;
  // not while looking at older messages, and not after they marked one unread on purpose.
  const [atBottom, setAtBottom] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const kept = useRef(false);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const waiting = summary ? summary.unread > 0 || (summary.unread_mentions ?? 0) > 0 : true;
  useEffect(() => {
    if (!member || !!target || !latest || !atBottom || !visible || kept.current || !waiting) return;
    const t = setTimeout(() => {
      void api
        .post(`${CHAT}/channels/${id}/read`, {})
        .then(() => qc.invalidateQueries({ queryKey: keys.channels }))
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [latest, member, target, atBottom, visible, waiting, id, qc]);

  const markUnread = async (m: Message) => {
    kept.current = true;
    try {
      await api.post(`${CHAT}/channels/${id}/read`, { unread_from: m.id });
      setDivider(m.id);
      void qc.invalidateQueries({ queryKey: keys.channels });
      toast("Marked as unread from that message");
    } catch (e) {
      kept.current = false;
      toast(errorMessage(e), "error");
    }
  };

  const join = async () => {
    try {
      await api.post(`${CHAT}/channels/${id}/join`, {});
      void qc.invalidateQueries({ queryKey: ["chat"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (channel.error && !summary) return <ErrorState error={channel.error} onRetry={() => void channel.refetch()} />;
  const state = view ? posting(view) : ({ state: "ok" } as const);
  const direct = view?.type === "Direct";
  const open = (tab: DetailsTab | "search") => patch({ panel: tab, thread: null });
  const side = panel === "search" ? "search" : panel ? "details" : threadId ? "thread" : null;

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_auto]">
      <div className="xl:col-span-2">
        <header className="flex items-center gap-2 border-b px-3 py-2">
          <Button asChild variant="ghost" size="icon-sm" className="md:hidden" aria-label="Back to conversations">
            <Link to={base}>
              <ArrowLeft />
            </Link>
          </Button>
          {view ? <ChannelIcon c={view} /> : null}
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{c?.title || c?.name || summary?.title || "…"}</h2>
            {c?.topic && <p className="truncate text-xs text-muted-foreground">{c.topic}</p>}
          </div>
          {c && !direct && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => open("members")} aria-label={`${c.members.length} ${c.members.length === 1 ? "member" : "members"}: see who is in`}>
              <Users aria-hidden="true" />
              <span className="tabular-nums">{c.members.length}</span>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Search this conversation" aria-pressed={side === "search"} onClick={() => (side === "search" ? patch({ panel: null }) : open("search"))}>
            <Search />
          </Button>
          {c && meet && !c.archived && (
            <Button asChild variant="ghost" size="icon-sm" aria-label="Call" title="Start or join this conversation's call">
              {/* The call opens in a window of its own, which outlives this page (docs/plan/apps-ui.md §12.6). */}
              <a href={`/meet/channel/${id}`} onClick={(e) => openCall(e, `/meet/channel/${id}`)}>
                <Video />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Details and notifications" aria-pressed={side === "details"} onClick={() => (side === "details" ? patch({ panel: null }) : open(direct ? "personal" : "general"))}>
            <Info />
          </Button>
        </header>
        {target && (
          <div role="status" className="flex items-center gap-2 border-b bg-muted px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1">{feed.error ? "That message could not be found." : "Showing the messages around the one you picked."}</span>
            <Button size="xs" variant="outline" onClick={() => patch({ m: null })}>
              Back to the latest
            </Button>
          </div>
        )}
      </div>
      <MessageList
        scope="main"
        list={placing ? [] : list}
        people={people}
        me={email}
        canModerate={owner}
        loading={feed.isLoading || placing}
        error={feed.error && !target ? feed.error : null}
        hasMore={!!feed.hasNextPage}
        loadMore={() => void feed.fetchNextPage()}
        loadingMore={feed.isFetchingNextPage}
        onThread={(m) => patch({ thread: m, panel: null })}
        onUnread={member ? (m) => void markUnread(m) : undefined}
        marks={divider ? { [divider]: "New messages" } : undefined}
        focus={target ? (found?.parent ?? found?.id ?? target) : undefined}
        start={divider ?? undefined}
        onBottom={setAtBottom}
        empty={state.state === "owners" ? "No posts yet." : "No messages yet. Say hello."}
        className="row-start-2"
      />
      <div className="row-start-3 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {!view ? (
          <Skeleton className="h-10" />
        ) : state.state === "ok" ? (
          <Composer channel={id} people={people} placeholder={`Message ${direct ? view.title : `#${view.name}`}`} onSent={target ? () => patch({ m: null }) : undefined} />
        ) : state.state === "join" ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="flex-1 text-muted-foreground">You are reading a public channel. Join it to post and to hear of new messages.</span>
            <Button onClick={() => void join()}>Join channel</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{state.why}</p>
        )}
      </div>
      {side === "thread" && threadId && (
        <Thread
          channel={id}
          root={threadId}
          highlight={target}
          people={people}
          me={email}
          canModerate={owner}
          posting={view ? posting(view, true) : { state: "ok" }}
          onJoin={() => void join()}
          onUnread={member ? (m) => void markUnread(m) : undefined}
          onClose={() => patch({ thread: null })}
        />
      )}
      {side === "details" && <ChannelDetails id={id} tab={(["general", "personal", "members"].includes(panel ?? "") ? panel : "general") as DetailsTab} onTab={(t) => patch({ panel: t })} onClose={() => patch({ panel: null })} />}
      {side === "search" && (
        <ChannelSearch
          channel={id}
          onPick={(m) => patch({ m: m.id, panel: null, thread: m.parent ?? null })}
          onClose={() => patch({ panel: null })}
        />
      )}
    </div>
  );
}

function MessageList(p: {
  /** Which list this is, so a message in two lists (a thread's first) has two places. */
  scope: string;
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
  onUnread?: (m: Message) => void;
  /** Words on a line above a message: where the new ones start, how many replies follow. */
  marks?: Record<string, string>;
  /** A message to bring into view and mark. */
  focus?: string;
  /** Where the list opens when it has no `focus`: at this message, else the bottom. */
  start?: string;
  onBottom?: (atBottom: boolean) => void;
  empty?: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const placed = useRef(false);
  const last = p.list[p.list.length - 1]?.id;
  const [seen, setSeen] = useState(last);

  const report = (el: HTMLDivElement) => {
    const now = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (now !== atBottom.current) {
      atBottom.current = now;
      p.onBottom?.(now);
    }
    if (now) setSeen(last);
  };

  // Opens at the message asked for, else the first unread one, else the newest; afterwards stays
  // with the newest unless the reader scrolled up to older ones. A new message asked for is found
  // again, and asking for none goes back to the newest.
  const asked = useRef(p.focus);
  useLayoutEffect(() => {
    const el = box.current;
    if (asked.current !== p.focus) {
      asked.current = p.focus;
      placed.current = !p.focus;
      if (!p.focus) atBottom.current = true;
    }
    if (!el || !p.list.length) return;
    if (!placed.current) {
      const wanted = p.focus ?? p.start;
      const at = wanted ? document.getElementById(p.focus ? `msg-${p.scope}-${wanted}` : `mark-${p.scope}-${wanted}`) : null;
      if (wanted && !at) return;
      placed.current = true;
      if (at) el.scrollTop = p.focus ? at.offsetTop - el.clientHeight / 3 : at.offsetTop - 8;
      else el.scrollTop = el.scrollHeight;
      report(el);
      return;
    }
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setSeen(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placing and following depend on what arrived, not on every render
  }, [last, p.list.length, p.focus, p.start]);

  const behind = !atBottom.current && seen !== last;
  return (
    <div className={cn("relative grid min-h-0 grid-rows-[minmax(0,1fr)]", p.className)}>
      <div
        ref={box}
        onScroll={(e) => report(e.currentTarget)}
        className="relative min-h-0 overflow-y-auto px-3 py-2"
        role="log"
        aria-live="polite"
        aria-label="Messages"
        tabIndex={-1}
      >
        {p.hasMore && (
          <div className="py-2 text-center">
            <Button variant="ghost" size="sm" onClick={p.loadMore} disabled={p.loadingMore}>
              {p.loadingMore ? "Loading…" : "Earlier messages"}
            </Button>
          </div>
        )}
        {p.loading && <Skeleton className="h-32" />}
        {!!p.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(p.error)}
          </p>
        )}
        {!p.loading && !p.error && !p.list.length && <p className="py-8 text-center text-sm text-muted-foreground">{p.empty ?? "No messages yet."}</p>}
        {p.list.map((m, i) => (
          <div key={m.id}>
            {startsDay(m, p.list[i - 1]) && (
              <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground" role="separator">
                <span className="h-px flex-1 bg-border" />
                {day(m.posted_at)}
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {p.marks?.[m.id] && (
              <div id={`mark-${p.scope}-${m.id}`} className="my-2 flex items-center gap-3 text-xs font-medium text-primary" role="separator" aria-label={p.marks[m.id]}>
                <span className="h-px flex-1 bg-primary/40" />
                {p.marks[m.id]}
                <span className="h-px flex-1 bg-primary/40" />
              </div>
            )}
            <MessageRow
              m={m}
              scope={p.scope}
              compact={continues(m, p.list[i - 1]) && !p.marks?.[m.id]}
              people={p.people}
              mine={m.sender.toLowerCase() === p.me.toLowerCase()}
              toMe={mentionsMe(m, p.me)}
              picked={m.id === p.focus}
              canModerate={p.canModerate}
              onThread={p.onThread}
              onUnread={p.onUnread}
            />
          </div>
        ))}
      </div>
      {behind && (
        <Button
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          onClick={() => {
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ChevronDown aria-hidden="true" /> New messages
        </Button>
      )}
    </div>
  );
}

function MessageRow({
  m,
  scope,
  compact,
  people,
  mine,
  toMe,
  picked,
  canModerate,
  onThread,
  onUnread,
}: {
  m: Message;
  scope: string;
  compact: boolean;
  people: Person[];
  mine: boolean;
  /** The message mentions the reader. */
  toMe: boolean;
  /** The message a link or a search result led to. */
  picked: boolean;
  canModerate: boolean;
  onThread?: (id: string) => void;
  onUnread?: (m: Message) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const name = m.sender_name || m.sender;
  const remove = async () => {
    if (!(await confirmDialog({ title: "Delete this message?", message: "Its text and attachments are erased for everyone.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.del(`${CHAT}/messages/${m.id}`);
      refreshMessages(qc);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const link = async () => {
    const url = `${location.origin}/open/ChatMessage/${m.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast(`Copy this link: ${url}`);
    }
  };
  const canDelete = mine || canModerate;
  return (
    // Focusable so a tap (or Tab) shows the message's actions on touch screens and keyboards.
    <article
      id={`msg-${scope}-${m.id}`}
      tabIndex={0}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a,button,input,textarea,[role=menuitem]")) e.currentTarget.focus();
      }}
      className={cn(
        "group relative flex gap-2 rounded-md px-1 outline-none hover:bg-muted/40 focus-visible:bg-muted/40",
        compact ? "py-0.5" : "mt-2 py-1",
        toMe && "border-l-2 border-primary bg-primary/5",
        picked && "bg-warning-soft ring-1 ring-warning",
      )}
      aria-label={`${name} at ${time(m.posted_at)}${toMe ? ", mentions you" : ""}`}
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
            <Button variant="ghost" size="icon-sm" aria-label="Reply in thread" title="Reply in thread" onClick={() => onThread(m.id)}>
              <MessagesSquare />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mine && <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>}
              {onUnread && <DropdownMenuItem onSelect={() => onUnread(m)}>Mark as unread from here</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => void link()}>Copy link</DropdownMenuItem>
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void remove()}>Delete</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
  const [failed, setFailed] = useState<string | null>(null);
  const save = async () => {
    if (!body.trim() || bodyTooLong(body)) return;
    setBusy(true);
    setFailed(null);
    try {
      await api.patch(`${CHAT}/messages/${m.id}`, { body });
      refreshMessages(qc);
      onDone();
    } catch (e) {
      setFailed(errorMessage(e));
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
        aria-invalid={!!failed || undefined}
        className="min-h-16"
      />
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          Not saved: {failed}
        </p>
      )}
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

function Thread({
  channel,
  root,
  highlight,
  people,
  me,
  canModerate,
  posting: allowed,
  onJoin,
  onUnread,
  onClose,
}: {
  channel: string;
  root: string;
  /** A reply to bring into view. */
  highlight?: string | null;
  people: Person[];
  me: string;
  canModerate: boolean;
  posting: ReturnType<typeof posting>;
  onJoin: () => void;
  onUnread?: (m: Message) => void;
  onClose: () => void;
}) {
  const first = useQuery({ queryKey: keys.message(root), queryFn: ({ signal }) => api.get<Message>(`${CHAT}/messages/${root}`, undefined, signal) });
  const replies = useQuery({
    queryKey: keys.thread(root),
    queryFn: ({ signal }) => api.get<{ messages: Message[] }>(`${CHAT}/channels/${channel}/messages`, { thread: root, limit: 200 }, signal),
  });
  const rows = replies.data?.messages ?? [];
  const list = useMemo(() => timeline([first.data ? [first.data] : [], rows]), [first.data, rows]);
  const marks = rows.length && first.data ? { [timeline([rows])[0]!.id]: `${rows.length} ${rows.length === 1 ? "reply" : "replies"}` } : undefined;
  return (
    <aside className={cn(SIDE_PANEL, "grid-rows-[auto_minmax(0,1fr)_auto]")} aria-label="Thread" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h3 className="flex-1 font-semibold">Thread</h3>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" onClick={onClose}>
          <X />
        </Button>
      </header>
      <MessageList
        scope="thread"
        list={list}
        people={people}
        me={me}
        canModerate={canModerate}
        loading={first.isLoading || replies.isLoading}
        error={first.error ?? replies.error}
        hasMore={false}
        loadMore={() => undefined}
        loadingMore={false}
        onUnread={onUnread}
        marks={marks}
        focus={highlight ?? undefined}
        empty="This thread has no messages."
      />
      <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {allowed.state === "ok" ? (
          <Composer channel={channel} parent={root} people={people} placeholder="Reply in thread" autoFocus={!highlight} />
        ) : allowed.state === "join" ? (
          <Button className="w-full" onClick={onJoin}>
            Join the channel to reply
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{allowed.why}</p>
        )}
      </div>
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
  const [failed, setFailed] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailed(null);
    try {
      const c = await api.post<Channel>(`${CHAT}/channels`, { name: name.trim(), type, topic: topic.trim() || undefined, members });
      void qc.invalidateQueries({ queryKey: keys.channels });
      onClose();
      navigate(`${base}/${c.id}`);
    } catch (err) {
      setFailed(errorMessage(err));
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
            <Input id="ch-name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="sales-team" aria-invalid={!!failed || undefined} />
            {failed && (
              <p role="alert" className="text-xs text-destructive">
                {failed}
              </p>
            )}
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
                <label key={p.id} className="flex items-center gap-2 pointer-coarse:min-h-11">
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
          <DialogDescription>Pick the person to talk to. They are told of each message.</DialogDescription>
        </DialogHeader>
        <PeoplePicker people={people.filter((p) => p.email.toLowerCase() !== me)} onPick={(p) => void open(p)} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

/** `/chat/m/{message}`: where a notification or a link to a message leads: the message, in its conversation. */
export function ChatMessagePage() {
  const { message = "" } = useParams();
  const base = useContext(Base);
  const navigate = useNavigate();
  const q = useQuery({ queryKey: keys.message(message), queryFn: ({ signal }) => api.get<Message>(`${CHAT}/messages/${message}`, undefined, signal), retry: false });
  useEffect(() => {
    if (q.data) navigate(`${base}/${q.data.channel}?m=${q.data.id}`, { replace: true });
  }, [q.data, base, navigate]);
  if (q.error)
    return (
      <EmptyState title="That message is not available" icon="chat">
        <p className="text-sm text-muted-foreground">It was deleted, or it is in a conversation you cannot read.</p>
        <Link className="text-primary underline" to={base}>
          Go to Chat
        </Link>
      </EmptyState>
    );
  return <Skeleton className="m-4 h-24" />;
}
