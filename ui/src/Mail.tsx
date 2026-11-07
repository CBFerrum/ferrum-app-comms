// Webmail on the Mail app's mail API: the person's hosted mailbox over JMAP, and the shared
// mailboxes they are a member of (sales@: one more account in their session). Folders, the
// messages of a folder as conversations (searched, read in a sandboxed frame with remote images on
// request), writing with attachments, drafts that are kept, replies and forwards, spam training
// ("Spam" / "Not spam" teach the server's filter), filing a mail onto a record, and settings: the
// vacation reply and app passwords for mail programs. The keyboard drives all of it (? lists the keys).

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Mail, Paperclip, Pencil, Search, Settings, Star, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Skeleton } from "@ferrum/kit/primitives";
import { api, errorMessage, relativeTime, t as tr } from "@ferrum/client";
import { cn, confirmDialog, ErrorState, toast, useDebounced } from "@ferrum/kit";
import { Compose } from "./MailCompose";
import { asDraft, Conversation } from "./MailReader";
import { MailSettings } from "./MailSettings";
import {
  MAIL,
  SHORTCUTS,
  addressList,
  busyWith,
  byRole,
  conversationRows,
  dropDraft,
  jmap,
  keyAction,
  keptDrafts,
  mailAccount,
  messagesIn,
  refusal,
  sortMailboxes,
  step,
  useMailSession,
  type Draft,
  type EmailSummary,
  type Mailbox,
  type Message,
  type Row,
  type Session,
} from "./lib/mail";

export { Compose };

const PAGE = 50;
const LIST_PROPERTIES = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"];

/** `/mail/:mailbox?/:email?` */
/** Why someone has no mail here: no mailbox, a locked one, or the mail server is unavailable. */
export function MailUnavailable({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const status = (error as { status?: number }).status;
  if (status === 404 || status === 403)
    return (
      <div className="grid h-[60vh] place-items-center p-6 text-center">
        <div className="grid max-w-md gap-2">
          <Mail className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-lg font-semibold">{status === 403 ? "Your mailbox is locked" : "You have no mailbox here"}</h1>
          <p className="text-sm text-muted-foreground">
            {status === 403
              ? "An administrator deactivated it or your address left the workspace's mail domain. Your mail is kept."
              : "Mailboxes come with hosted mail: an administrator sets the workspace's mail domain, and everyone whose address is in it gets one."}
          </p>
        </div>
      </div>
    );
  return <ErrorState error={error} onRetry={onRetry} />;
}

/** An account's folders, kept fresh. */
export function useMailboxes(account: string | undefined) {
  return useQuery({
    queryKey: ["mail", "mailboxes", account],
    queryFn: async () => {
      const r = await jmap([
        ["Mailbox/get", { accountId: account, properties: ["name", "role", "parentId", "sortOrder", "totalEmails", "unreadEmails"] }, "0"],
      ]);
      return sortMailboxes(r["0"].list as Mailbox[]);
    },
    enabled: !!account,
    refetchInterval: 60_000,
  });
}

/** `/mail/…`; `/mail/compose` (the bar's Create menu) opens with a new message. */
export function MailPage({ compose = false }: { compose?: boolean }) {
  const session = useMailSession();
  if (session.isLoading) return <Skeleton className="m-4 h-64" />;
  if (session.error) return <MailUnavailable error={session.error} onRetry={() => void session.refetch()} />;
  const primary = mailAccount(session.data);
  if (!session.data || !primary) return <ErrorState error={new Error("The mail server offers no mail account.")} />;
  return <Mailroom session={session.data} primary={primary} compose={compose} />;
}

/** The person's own mailbox first, then the shared ones by address. */
const accountsOf = (s: Session) =>
  Object.entries(s.accounts).sort(([, a], [, b]) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name));

function Mailroom({ session, primary, compose }: { session: Session; primary: string; compose: boolean }) {
  const { mailbox, email } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  // `?account=` picks a shared mailbox; its own address is "me" there (replies leave it out).
  const asked = search.get("account");
  const account = asked && session.accounts[asked] ? asked : primary;
  const me = session.accounts[account]?.name ?? session.username;
  const accounts = accountsOf(session);
  const suffix = account === primary ? "" : `?account=${encodeURIComponent(account)}`;
  const switchTo = (id: string) => navigate(id === primary ? "/mail" : `/mail?account=${encodeURIComponent(id)}`);
  const [draft, setDraft] = useState<Draft | null>(compose ? { kind: "new" } : null);
  const [settings, setSettings] = useState(false);
  const [keys, setKeys] = useState(false);
  const boxes = useMailboxes(account);
  const inbox = byRole(boxes.data, "inbox")?.id;
  const current = mailbox ?? inbox;
  const open = (box: string, id?: string) => navigate((id ? `/mail/${box}/${id}` : `/mail/${box}`) + suffix);
  const folder = boxes.data?.find((b) => b.id === current);

  // Writing from the keyboard anywhere in Mail; the list of keys is a key away.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyAction(e);
      if ((k !== "compose" && k !== "help") || busyWith(e.target as HTMLElement | null, e.key)) return;
      e.preventDefault();
      if (k === "compose") setDraft((d) => d ?? { kind: "new" });
      else setKeys(true);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // A message in Drafts opens to be written on, not to be read.
  const [opening, setOpening] = useState<string | null>(null);
  const openDraft = async (id: string) => {
    setOpening(id);
    try {
      setDraft(asDraft(await api.get<Message>(`${MAIL}/message/${account}/${id}`), id));
    } catch (e) {
      toast(`The draft could not be opened: ${errorMessage(e)}`, "error");
    } finally {
      setOpening(null);
    }
  };
  const onOpen = (id: string) => (folder?.role === "drafts" ? void openDraft(id) : open(current!, id));

  if (boxes.error) return <ErrorState error={boxes.error} onRetry={() => void boxes.refetch()} />;
  return (
    <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 md:grid-cols-[200px_340px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col gap-2 border-e p-2 md:flex" aria-label={tr("Folders")}>
        <Button onClick={() => setDraft({ kind: "new" })} title={tr("Write a message (c)")}>
          <Pencil aria-hidden="true" /> {tr("Write")}
        </Button>
        {accounts.length > 1 && (
          <ul className="grid gap-0.5 border-b pb-2" aria-label={tr("Mailboxes")}>
            {accounts.map(([id, a]) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => switchTo(id)}
                  aria-current={id === account ? "true" : undefined}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent pointer-coarse:min-h-11", id === account && "bg-accent font-medium")}
                >
                  {a.isPersonal ? <Mail className="size-4 shrink-0" aria-hidden="true" /> : <Users className="size-4 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto" aria-label={tr("Folders of the mailbox")}>
          {boxes.isLoading && <Skeleton className="h-40" />}
          <ul className="grid gap-0.5">
            {boxes.data?.map((b) => (
              <li key={b.id}>
                <Link
                  to={`/mail/${b.id}${suffix}`}
                  aria-current={b.id === current ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent pointer-coarse:min-h-11",
                    b.id === current && "bg-accent font-medium",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.unreadEmails > 0 && b.role !== "trash" && b.role !== "sent" && b.role !== "drafts" && (
                    <Badge className="h-5 min-w-5 justify-center px-1.5" aria-label={`${b.unreadEmails} unread`}>
                      {b.unreadEmails > 999 ? "999+" : b.unreadEmails}
                    </Badge>
                  )}
                  {b.role === "drafts" && b.totalEmails > 0 && <span className="text-xs text-muted-foreground">{b.totalEmails}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => setKeys(true)}>
          <Keyboard aria-hidden="true" /> {tr("Keyboard shortcuts")}
        </Button>
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => setSettings(true)}>
          <Settings aria-hidden="true" /> {tr("Mail settings")}
        </Button>
      </aside>
      <section className={cn("min-h-0 border-e", email && "hidden md:block")} aria-label={tr("Messages")}>
        {current && (
          <MessageList
            key={account + current}
            account={account}
            accounts={accounts}
            onAccount={switchTo}
            mailbox={folder}
            mailboxId={current}
            boxes={boxes.data ?? []}
            active={email}
            opening={opening}
            onOpen={onOpen}
            onWrite={() => setDraft({ kind: "new" })}
            onSettings={() => setSettings(true)}
            onFolder={(id) => open(id)}
            onKept={(d) => setDraft(d)}
            writing={!!draft}
          />
        )}
      </section>
      <section className={cn("min-h-0", !email && "hidden md:grid md:place-items-center")}>
        {email && current ? (
          <Conversation key={account + email} account={account} id={email} me={me} boxes={boxes.data ?? []} folder={current} onBack={() => open(current)} onDraft={setDraft} />
        ) : (
          <p className="text-sm text-muted-foreground">{tr("Pick a message to read it.")}</p>
        )}
      </section>
      {draft && (
        <Compose
          key={draft.saved?.id ?? draft.saved?.key ?? draft.original?.id ?? "new"}
          account={account}
          me={me}
          boxes={boxes.data ?? []}
          draft={draft}
          onClose={() => {
            setDraft(null);
            if (compose) navigate("/mail", { replace: true });
          }}
        />
      )}
      {settings && <MailSettings account={primary} me={session.username} servers={session.servers} onClose={() => setSettings(false)} />}
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
    </div>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr("Keyboard shortcuts")}</DialogTitle>
          <DialogDescription>{tr("They work in the list and in an open conversation, not while you are typing.")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.action} className="contents">
              <dt>{s.label}</dt>
              <dd className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {k}
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

function MessageList(p: {
  account: string;
  accounts: [string, Session["accounts"][string]][];
  onAccount: (id: string) => void;
  mailbox?: Mailbox;
  mailboxId: string;
  boxes: Mailbox[];
  active?: string;
  opening: string | null;
  onOpen: (id: string) => void;
  onWrite: () => void;
  onSettings: () => void;
  onFolder: (id: string) => void;
  onKept: (d: Draft) => void;
  writing: boolean;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed.trim(), 300);
  const searchBox = useRef<HTMLInputElement>(null);
  const outgoing = p.mailbox?.role === "sent" || p.mailbox?.role === "drafts";
  const list = useInfiniteQuery({
    queryKey: ["mail", "list", p.account, p.mailboxId, search],
    queryFn: async ({ pageParam }) => {
      const filter = search ? { inMailbox: p.mailboxId, text: search } : { inMailbox: p.mailboxId };
      // One conversation per line (`collapseThreads`), and who is in each.
      const r = await jmap([
        ["Email/query", { accountId: p.account, filter, sort: [{ property: "receivedAt", isAscending: false }], position: pageParam, limit: PAGE, calculateTotal: true, collapseThreads: true }, "q"],
        ["Email/get", { accountId: p.account, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: LIST_PROPERTIES }, "g"],
        ["Thread/get", { accountId: p.account, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } }, "t"],
      ]);
      const emails = r.g.list as EmailSummary[];
      const threads = (r.t.list as { id: string; emailIds: string[] }[] | undefined) ?? [];
      // What is read, and where, for every message of the conversations that have more than one.
      const more = [...new Set(threads.filter((t) => t.emailIds.length > 1).flatMap((t) => t.emailIds))];
      const flags = more.length
        ? (((await jmap([["Email/get", { accountId: p.account, ids: more, properties: ["keywords", "mailboxIds"] }, "k"]])).k.list as { id: string; keywords: Record<string, boolean> | null; mailboxIds: Record<string, boolean> | null }[]) ?? [])
        : [];
      return { rows: conversationRows(emails, threads, flags, p.mailboxId), total: Number(r.q.total ?? 0), position: pageParam };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.position + PAGE < last.total ? last.position + PAGE : undefined),
    refetchInterval: 60_000,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((pg) => pg.rows) ?? [], [list.data]);
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(rows.length - 1, 0));
  useEffect(() => setCursor(0), [search]);
  // The cursor follows the conversation that is open.
  useEffect(() => {
    const i = rows.findIndex((r) => r.id === p.active);
    if (i >= 0) setCursor(i);
  }, [p.active, rows]);
  useEffect(() => {
    document.querySelector(`[data-row="${rows[at]?.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at, rows]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
  /** A change to the conversation under the cursor, as one the person asked for by key. */
  const act = async (row: Row, patch: Record<string, unknown>, done: string) => {
    try {
      const r = await jmap([["Email/set", { accountId: p.account, update: Object.fromEntries(row.folderIds.map((i) => [i, patch])) }, "0"]]);
      const failed = Object.values((r["0"].notUpdated as Record<string, { type?: string; description?: string }> | undefined) ?? {})[0];
      if (failed) throw new Error(refusal(failed, "The mail server refused the change."));
      toast(done);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    void refresh();
  };
  const role = (r: string) => byRole(p.boxes, r);

  // j and k move through the list (and through the conversations when one is open); with none
  // open, e, #, !, s and Shift+U act on the one under the cursor.
  const keys = useRef<(k: NonNullable<ReturnType<typeof keyAction>>) => void>(() => undefined);
  keys.current = (k) => {
    const row = rows[at];
    if (k === "next" || k === "previous") {
      const to = step(at, rows.length, k === "next" ? 1 : -1);
      setCursor(to);
      if (p.active && rows[to]) p.onOpen(rows[to]!.id);
    } else if (k === "open") {
      if (row) p.onOpen(row.id);
    } else if (k === "search") {
      searchBox.current?.focus();
    } else if (row && !p.active) {
      if (k === "star") void act(row, { "keywords/$flagged": row.keywords?.$flagged ? null : true }, row.keywords?.$flagged ? "Star removed" : "Starred");
      else if (k === "unread") void act(row, { "keywords/$seen": null }, "Marked as unread");
      else if (k === "archive" && role("archive") && p.mailbox?.role !== "archive") void act(row, { mailboxIds: { [role("archive")!.id]: true } }, "Archived");
      else if (k === "spam" && role("junk")) void act(row, { mailboxIds: { [role("junk")!.id]: true }, "keywords/$junk": true, "keywords/$notjunk": null }, "Moved to Junk");
      else if (k === "delete") {
        if (p.mailbox?.role === "trash") {
          void confirmDialog({ title: "Delete this conversation for good?", message: "It cannot be recovered.", confirmLabel: "Delete", danger: true }).then(async (ok) => {
            if (!ok) return;
            try {
              await jmap([["Email/set", { accountId: p.account, destroy: row.folderIds }, "0"]]);
              toast(tr("Deleted"));
            } catch (e) {
              toast(errorMessage(e), "error");
            }
            void refresh();
          });
        } else if (role("trash")) void act(row, { mailboxIds: { [role("trash")!.id]: true } }, "Moved to Trash");
      }
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyAction(e);
      if (!k || busyWith(e.target as HTMLElement | null, e.key) || p.writing) return;
      if (["next", "previous", "open", "search", "star", "unread", "archive", "spam", "delete"].includes(k)) {
        e.preventDefault();
        keys.current(k);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [p.writing]);

  // Messages written and not sent that only this browser has (the mail server never took them, or
  // not their last words); looked at again whenever the window for writing closes.
  const [gone, setGone] = useState<string[]>([]);
  const kept = useMemo(() => (p.writing ? [] : keptDrafts(p.account)), [p.account, p.writing]);
  const lost = kept.filter((k) => !gone.includes(k.key)).slice(0, 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {p.accounts.length > 1 && (
        <div className="border-b p-2 md:hidden">
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" aria-label={tr("Mailbox")} value={p.account} onChange={(e) => p.onAccount(e.target.value)}>
            {p.accounts.map(([id, a]) => (
              <option key={id} value={id}>
                {a.isPersonal ? a.name : `${a.name} (shared)`}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex items-center gap-2 border-b p-2">
        <select className="h-9 rounded-md border bg-background px-2 text-sm md:hidden" aria-label={tr("Folder")} value={p.mailboxId} onChange={(e) => p.onFolder(e.target.value)}>
          {p.boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.unreadEmails && b.role !== "drafts" ? ` (${b.unreadEmails})` : ""}
            </option>
          ))}
        </select>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-2.5 start-2 size-4 text-muted-foreground" aria-hidden="true" />
          <Input ref={searchBox} className="ps-8" type="search" placeholder={`Search ${p.mailbox?.name ?? "mail"}`} aria-label={tr("Search mail")} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        <Button size="icon-sm" variant="outline" className="md:hidden" aria-label={tr("Write")} onClick={p.onWrite}>
          <Pencil />
        </Button>
        <Button size="icon-sm" variant="ghost" className="md:hidden" aria-label={tr("Mail settings")} onClick={p.onSettings}>
          <Settings />
        </Button>
      </div>
      {lost.map((k) => (
        <div key={k.key} role="status" className="grid gap-1 border-b bg-warning-soft px-3 py-2 text-sm">
          <span>
            {tr("You have a message you did not send, from")} {relativeTime(k.savedAt)}: <strong className="font-medium">{k.subject || k.body.trim().slice(0, 40) || "(no subject)"}</strong>
          </span>
          <span className="flex gap-2">
            <Button
              size="xs"
              onClick={() =>
                p.onKept({
                  kind: "new",
                  prefill: { to: k.to, cc: k.cc, subject: k.subject, body: k.body },
                  saved: { id: k.draftId, key: k.key, files: k.files, inReplyTo: k.inReplyTo, references: k.references },
                })
              }
            >
              {tr("Continue writing")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                dropDraft(p.account, k.key);
                setGone((g) => [...g, k.key]);
              }}
            >
              {tr("Discard")}
            </Button>
          </span>
        </div>
      ))}
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isLoading}>
        {list.isLoading && <Skeleton className="m-2 h-32" />}
        {!!list.error && (
          <li>
            <ErrorState error={list.error} onRetry={() => void list.refetch()} title={tr("This folder could not be listed")} />
          </li>
        )}
        {!list.isLoading && !list.error && !rows.length && (
          <li className="p-6 text-center text-sm text-muted-foreground">{search ? `Nothing in ${p.mailbox?.name ?? "this folder"} matches “${search}”.` : p.mailbox?.role === "drafts" ? "No drafts. A message you start and leave is kept here." : "No messages here."}</li>
        )}
        {rows.map((m, i) => {
          const sender = outgoing ? `To: ${addressList(m.to) || "(no recipients)"}` : addressList(m.from) || "(unknown sender)";
          const starred = !!m.keywords?.$flagged;
          return (
            <li key={m.id}>
              <button
                type="button"
                data-row={m.id}
                disabled={p.opening === m.id}
                onClick={() => {
                  setCursor(i);
                  p.onOpen(m.id);
                }}
                aria-current={m.id === p.active ? "true" : undefined}
                className={cn(
                  "grid w-full gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  m.id === p.active && "bg-accent",
                  i === at && m.id !== p.active && "bg-accent/50",
                )}
              >
                <span className="flex items-center gap-2">
                  {m.unread && <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={tr("Unread")} />}
                  <span className={cn("min-w-0 flex-1 truncate", m.unread && "font-semibold")}>
                    {sender}
                    {m.count > 1 && (
                      <span className="ms-1 font-normal text-muted-foreground" title={messagesIn(m.count)}>
                        ({m.count})
                      </span>
                    )}
                  </span>
                  {starred && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label={tr("Starred")} />}
                  {m.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label={tr("Has attachments")} />}
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={m.receivedAt}>
                    {relativeTime(m.receivedAt)}
                  </time>
                </span>
                <span className={cn("truncate", m.unread && "font-medium")}>{m.subject || "(no subject)"}</span>
                <span className="truncate text-xs text-muted-foreground">{m.preview}</span>
              </button>
            </li>
          );
        })}
        {list.hasNextPage && (
          <li className="p-2 text-center">
            <Button variant="ghost" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : "Older messages"}
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}
