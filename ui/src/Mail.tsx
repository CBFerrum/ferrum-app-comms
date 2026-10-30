// Webmail on the Mail app's mail API: the person's hosted mailbox over JMAP, and the shared
// mailboxes they are a member of (sales@: one more account in their session). Folders, messages
// (searched, read in a sandboxed frame with remote images on request), writing with attachments,
// replies and forwards, spam training ("Spam" / "Not spam" teach the server's filter), filing a
// mail onto a record, and settings: the vacation reply and app passwords for mail programs.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  Pencil,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
  FolderInput,
  FolderOpen,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Badge } from "@ferrum/kit/primitives";
import { Button } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { Input } from "@ferrum/kit/primitives";
import { Label } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ferrum/kit/primitives";
import { Textarea } from "@ferrum/kit/primitives";
import { api, download, errorMessage, fetchBlob, request, shell } from "@ferrum/client";
import { formatDateTime, relativeTime } from "@ferrum/client";
import {
  MAIL,
  addressLabel,
  addressList,
  byRole,
  formatAddresses,
  frameDocument,
  jmap,
  mailAccount,
  parseAddresses,
  quote,
  replyRecipients,
  replySubject,
  sizeLabel,
  sortMailboxes,
  useMailSession,
  type EmailSummary,
  type Mailbox,
  type Message,
  type Session,
} from "./lib/mail";
import { can, useMetaIndex } from "@ferrum/records";
import { cn } from "@ferrum/kit";
import { confirmDialog, ErrorState, toast, useCanIntent, useDebounced } from "@ferrum/kit";
import { LinkInput } from "@ferrum/records";

const PAGE = 50;
const LIST_PROPERTIES = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"];

interface Identity {
  id: string;
  name: string;
  email: string;
}

interface Draft {
  kind: "new" | "reply" | "replyAll" | "forward";
  original?: Message;
  /** A new message's fields, filled in by another app (the `compose email` intent). */
  prefill?: { to?: string; cc?: string; subject?: string; body?: string };
  /** Files to attach first: this site's `/api/` addresses, fetched with the person's rights. */
  attach?: { url: string; name: string }[];
}

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
  const boxes = useMailboxes(account);
  const inbox = byRole(boxes.data, "inbox")?.id;
  const current = mailbox ?? inbox;
  const open = (box: string, id?: string) => navigate((id ? `/mail/${box}/${id}` : `/mail/${box}`) + suffix);

  if (boxes.error) return <ErrorState error={boxes.error} onRetry={() => void boxes.refetch()} />;
  return (
    <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 md:grid-cols-[200px_340px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col gap-2 border-r p-2 md:flex" aria-label="Folders">
        <Button onClick={() => setDraft({ kind: "new" })}>
          <Pencil aria-hidden="true" /> Write
        </Button>
        {accounts.length > 1 && (
          <ul className="grid gap-0.5 border-b pb-2" aria-label="Mailboxes">
            {accounts.map(([id, a]) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => switchTo(id)}
                  aria-current={id === account ? "true" : undefined}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent pointer-coarse:min-h-11", id === account && "bg-accent font-medium")}
                >
                  {a.isPersonal ? <Mail className="size-4 shrink-0" aria-hidden="true" /> : <Users className="size-4 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Folders of the mailbox">
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
                  {b.unreadEmails > 0 && b.role !== "trash" && b.role !== "sent" && (
                    <Badge className="h-5 min-w-5 justify-center px-1.5" aria-label={`${b.unreadEmails} unread`}>
                      {b.unreadEmails > 999 ? "999+" : b.unreadEmails}
                    </Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Button variant="ghost" size="sm" className="justify-start" onClick={() => setSettings(true)}>
          <Settings aria-hidden="true" /> Mail settings
        </Button>
      </aside>
      <section className={cn("min-h-0 border-r", email && "hidden md:block")} aria-label="Messages">
        {current && (
          <MessageList
            key={account + current}
            account={account}
            accounts={accounts}
            onAccount={switchTo}
            mailbox={boxes.data?.find((b) => b.id === current)}
            mailboxId={current}
            boxes={boxes.data ?? []}
            active={email}
            onOpen={(id) => open(current, id)}
            onWrite={() => setDraft({ kind: "new" })}
            onSettings={() => setSettings(true)}
            onFolder={(id) => open(id)}
          />
        )}
      </section>
      <section className={cn("min-h-0", !email && "hidden md:grid md:place-items-center")}>
        {email && current ? (
          <Reader
            key={account + email}
            account={account}
            id={email}
            me={me}
            boxes={boxes.data ?? []}
            onBack={() => open(current)}
            onDraft={setDraft}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Pick a message to read it.</p>
        )}
      </section>
      {draft && (
        <Compose
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
    </div>
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
  onOpen: (id: string) => void;
  onWrite: () => void;
  onSettings: () => void;
  onFolder: (id: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed.trim(), 300);
  const outgoing = p.mailbox?.role === "sent" || p.mailbox?.role === "drafts";
  const list = useInfiniteQuery({
    queryKey: ["mail", "list", p.account, p.mailboxId, search],
    queryFn: async ({ pageParam }) => {
      const filter = search ? { inMailbox: p.mailboxId, text: search } : { inMailbox: p.mailboxId };
      const r = await jmap([
        ["Email/query", { accountId: p.account, filter, sort: [{ property: "receivedAt", isAscending: false }], position: pageParam, limit: PAGE, calculateTotal: true }, "q"],
        ["Email/get", { accountId: p.account, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: LIST_PROPERTIES }, "g"],
      ]);
      return { emails: r.g.list as EmailSummary[], total: Number(r.q.total ?? 0), position: pageParam };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.position + PAGE < last.total ? last.position + PAGE : undefined),
    refetchInterval: 60_000,
  });
  const emails = list.data?.pages.flatMap((pg) => pg.emails) ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      {p.accounts.length > 1 && (
        <div className="border-b p-2 md:hidden">
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" aria-label="Mailbox" value={p.account} onChange={(e) => p.onAccount(e.target.value)}>
            {p.accounts.map(([id, a]) => (
              <option key={id} value={id}>
                {a.isPersonal ? a.name : `${a.name} (shared)`}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex items-center gap-2 border-b p-2">
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm md:hidden"
          aria-label="Folder"
          value={p.mailboxId}
          onChange={(e) => p.onFolder(e.target.value)}
        >
          {p.boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.unreadEmails ? ` (${b.unreadEmails})` : ""}
            </option>
          ))}
        </select>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2 size-4 text-muted-foreground" aria-hidden="true" />
          <Input className="pl-8" type="search" placeholder={`Search ${p.mailbox?.name ?? "mail"}`} aria-label="Search mail" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
        <Button size="icon-sm" variant="outline" className="md:hidden" aria-label="Write" onClick={p.onWrite}>
          <Pencil />
        </Button>
        <Button size="icon-sm" variant="ghost" className="md:hidden" aria-label="Mail settings" onClick={p.onSettings}>
          <Settings />
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isLoading}>
        {list.isLoading && <Skeleton className="m-2 h-32" />}
        {!!list.error && <li className="p-3 text-sm text-destructive">{errorMessage(list.error)}</li>}
        {!list.isLoading && !emails.length && (
          <li className="p-6 text-center text-sm text-muted-foreground">{search ? "Nothing matches." : "No messages here."}</li>
        )}
        {emails.map((m) => {
          const unread = !m.keywords?.$seen;
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => p.onOpen(m.id)}
                aria-current={m.id === p.active ? "true" : undefined}
                className={cn("grid w-full gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-accent", m.id === p.active && "bg-accent")}
              >
                <span className="flex items-center gap-2">
                  {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold")}>
                    {outgoing ? `To: ${addressList(m.to) || "(no recipients)"}` : addressList(m.from) || "(unknown sender)"}
                  </span>
                  {m.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
                  <time className="shrink-0 text-xs text-muted-foreground" dateTime={m.receivedAt}>
                    {relativeTime(m.receivedAt)}
                  </time>
                </span>
                <span className={cn("truncate", unread && "font-medium")}>{m.subject || "(no subject)"}</span>
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

function Reader(p: { account: string; id: string; me: string; boxes: Mailbox[]; onBack: () => void; onDraft: (d: Draft) => void }) {
  const qc = useQueryClient();
  const [images, setImages] = useState(false);
  const [filing, setFiling] = useState(false);
  const comms = useMetaIndex().data?.entities.find((e) => e.name === "Communication");
  const msg = useQuery({
    queryKey: ["mail", "message", p.account, p.id, images],
    queryFn: ({ signal }) => api.get<Message>(`${MAIL}/message/${p.account}/${p.id}`, images ? { images: 1 } : undefined, signal),
  });
  const m = msg.data;
  // Folders, lists and messages (a message's view knows its folders: "Not spam" needs Junk).
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
  const update = async (patch: Record<string, unknown>, done?: string) => {
    try {
      const r = await jmap([["Email/set", { accountId: p.account, update: { [p.id]: patch } }, "0"]]);
      const failed = (r["0"].notUpdated as Record<string, { description?: string }> | undefined)?.[p.id];
      if (failed) throw new Error(failed.description ?? "The mail server refused the change.");
      if (done) toast(done);
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  // Opening a message marks it read.
  const seen = !!m?.keywords?.$seen;
  useEffect(() => {
    if (m && !seen) void update({ "keywords/$seen": true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.id, seen]);

  if (msg.error) return <ErrorState error={msg.error} onRetry={() => void msg.refetch()} />;
  if (!m) return <Skeleton className="m-4 h-64" />;
  const role = (r: string) => byRole(p.boxes, r);
  const inFolder = (r: string) => !!role(r) && !!m.mailboxIds[role(r)!.id];
  const move = async (to: Mailbox | undefined, label: string, keywords: Record<string, boolean | null> = {}) => {
    if (!to) return;
    const patch: Record<string, unknown> = { mailboxIds: { [to.id]: true } };
    for (const [k, v] of Object.entries(keywords)) patch[`keywords/${k}`] = v;
    await update(patch, label);
    p.onBack();
  };
  const remove = async () => {
    if (!inFolder("trash")) return move(role("trash"), "Moved to Trash");
    if (!(await confirmDialog({ title: "Delete this message for good?", message: "It cannot be recovered.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await jmap([["Email/set", { accountId: p.account, destroy: [p.id] }, "0"]]);
      toast("Deleted");
      await refresh();
      p.onBack();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const junk = inFolder("junk");
  return (
    <article className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]" aria-label={m.subject ?? "Message"}>
      <header className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Back to messages" onClick={p.onBack}>
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => p.onDraft({ kind: "reply", original: m })}>
          <Reply aria-hidden="true" /> Reply
        </Button>
        <Button variant="ghost" size="sm" onClick={() => p.onDraft({ kind: "replyAll", original: m })}>
          <ReplyAll aria-hidden="true" /> Reply all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => p.onDraft({ kind: "forward", original: m })}>
          <Forward aria-hidden="true" /> Forward
        </Button>
        <span className="flex-1" />
        {role("archive") && !inFolder("archive") && (
          <Button variant="ghost" size="icon-sm" aria-label="Archive" title="Archive" onClick={() => void move(role("archive"), "Archived")}>
            <Archive />
          </Button>
        )}
        {junk ? (
          <Button variant="ghost" size="sm" title="Not spam: back to the inbox, and the filter learns" onClick={() => void move(role("inbox"), "Moved to the inbox", { $junk: null, $notjunk: true })}>
            <ShieldCheck aria-hidden="true" /> Not spam
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="Spam" title="Spam: to Junk, and the filter learns" onClick={() => void move(role("junk"), "Moved to Junk", { $junk: true, $notjunk: null })}>
            <ShieldAlert />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Mark as unread" title="Mark as unread" onClick={() => void update({ "keywords/$seen": null }, "Marked as unread").then(p.onBack)}>
          <MailOpen />
        </Button>
        {comms && can(comms.permissions, "create") && (
          <Button variant="ghost" size="icon-sm" aria-label="File to a record" title="File to a record" onClick={() => setFiling(true)}>
            <FolderInput />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={inFolder("trash") ? "Delete for good" : "Delete"} title="Delete" onClick={() => void remove()}>
          <Trash2 />
        </Button>
      </header>
      <div className="grid gap-1 border-b px-4 py-3">
        <h2 className="text-lg font-semibold break-words">{m.subject || "(no subject)"}</h2>
        <p className="text-sm">
          <span className="font-medium">{addressLabel(m.from?.[0])}</span>{" "}
          {m.from?.[0]?.name && <span className="text-muted-foreground">&lt;{m.from[0].email}&gt;</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          To {addressList(m.to) || "—"}
          {m.cc?.length ? ` · Cc ${addressList(m.cc)}` : ""} · {formatDateTime(m.receivedAt)}
        </p>
        {m.remote_images > 0 && !images && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {m.remote_images === 1 ? "1 remote image is hidden" : `${m.remote_images} remote images are hidden`} to protect your privacy.
            <Button variant="link" size="xs" className="h-auto p-0" onClick={() => setImages(true)}>
              Show images
            </Button>
          </p>
        )}
        {m.attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 pt-1" aria-label="Attachments">
            {m.attachments.map((a) => (
              <li key={a.blobId}>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    void download(`${MAIL}/blob/${p.account}/${a.blobId}`, a.name ?? "attachment", { name: a.name ?? "attachment", type: a.type }).catch((e: unknown) =>
                      toast(errorMessage(e), "error"),
                    )
                  }
                >
                  <Paperclip aria-hidden="true" /> {a.name ?? "attachment"} <span className="text-muted-foreground">{sizeLabel(a.size)}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <iframe
        title="Message body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-white"
        srcDoc={frameDocument(m.html || "<p>(This message has no text.)</p>", images)}
      />
      {filing && <FileDialog account={p.account} email={m} onClose={() => setFiling(false)} />}
    </article>
  );
}

function FileDialog({ account, email, onClose }: { account: string; email: Message; onClose: () => void }) {
  const entities = useMetaIndex().data?.entities.filter((e) => can(e.permissions, "read") && e.kind !== "child" && e.name !== "Communication") ?? [];
  const [entity, setEntity] = useState("");
  const [record, setRecord] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!entity || !record) return;
    setBusy(true);
    try {
      await api.post(`${MAIL}/file`, { account, email: email.id, entity, record });
      toast("Filed: the record's timeline shows it.");
      onClose();
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
            <DialogTitle>File to a record</DialogTitle>
            <DialogDescription>
              "{email.subject || "(no subject)"}" goes onto the record's timeline with its attachments, for everyone who can see the record.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="file-entity">Kind of record</Label>
            <select
              id="file-entity"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value);
                setRecord(null);
              }}
            >
              <option value="">Choose…</option>
              {entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
          {entity && (
            <div className="grid gap-1.5">
              <Label htmlFor="file-record">Record</Label>
              <LinkInput key={entity} id="file-record" to={entity} value={record} onChange={(id) => setRecord(id)} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!entity || !record || busy}>
              File
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Upload {
  blobId: string;
  name: string;
  type: string;
  size: number;
}

export function Compose({
  account,
  me,
  boxes,
  draft,
  onClose,
  onSent,
}: {
  account: string;
  me: string;
  boxes: Mailbox[];
  draft: Draft;
  onClose: () => void;
  onSent?: () => void;
}) {
  const qc = useQueryClient();
  const original = draft.original;
  const start = useMemo(() => {
    if (!original) return { to: draft.prefill?.to ?? "", cc: draft.prefill?.cc ?? "", subject: draft.prefill?.subject ?? "", body: draft.prefill?.body ?? "" };
    const when = formatDateTime(original.receivedAt);
    if (draft.kind === "forward") return { to: "", cc: "", subject: replySubject(original.subject, "forward"), body: quote(original, "forward", when) };
    const r = replyRecipients(original, me, draft.kind === "replyAll");
    return { to: formatAddresses(r.to), cc: formatAddresses(r.cc), subject: replySubject(original.subject, "reply"), body: quote(original, "reply", when) };
  }, [original, draft.kind, draft.prefill, me]);
  const [to, setTo] = useState(start.to);
  const [cc, setCc] = useState(start.cc);
  const [bcc, setBcc] = useState("");
  const [more, setMore] = useState(!!start.cc);
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const [files, setFiles] = useState<Upload[]>(
    draft.kind === "forward" && original ? original.attachments.map((a) => ({ blobId: a.blobId, name: a.name ?? "attachment", type: a.type, size: a.size })) : [],
  );
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const identities = useQuery({
    queryKey: ["mail", "identities", account],
    queryFn: async () => (await jmap([["Identity/get", { accountId: account }, "0"]]))["0"].list as Identity[],
    staleTime: 10 * 60_000,
  });
  const [fromId, setFromId] = useState<string | null>(null);
  const identity =
    identities.data?.find((i) => i.id === fromId) ?? identities.data?.find((i) => i.email.toLowerCase() === me.toLowerCase()) ?? identities.data?.[0];

  const attach = async (list: FileList | File[] | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        const up = await request<{ blobId: string; type: string; size: number }>(`${MAIL}/upload/${account}`, { method: "POST", body: f });
        setFiles((x) => [...x, { blobId: up.blobId, name: f.name, type: f.type || up.type || "application/octet-stream", size: up.size ?? f.size }]);
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  };
  // Files from this site (Drive's, a printed record) attach as copies, fetched with the person's own rights.
  const attachFrom = async (list: { url: string; name: string }[]) => {
    const own = list.filter((f) => f.url.startsWith("/api/") && !f.url.startsWith("//"));
    try {
      const got = await Promise.all(own.map(async (f) => new File([await fetchBlob(f.url)], f.name)));
      await attach(got);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const fromDrive = useCanIntent("pick", "file");
  const pickFromDrive = async () => {
    const out = await shell()
      .intent<{ files: { url: string; name: string }[] }>({ action: "pick", type: "file", data: { multiple: true, title: "Attach files from Drive" } })
      .catch((e: unknown) => (toast(errorMessage(e), "error"), null));
    if (out?.status === "done" && out.result?.files?.length) await attachFrom(out.result.files);
  };
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current || !draft.attach?.length) return;
    attached.current = true;
    void attachFrom(draft.attach);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the files the draft came with
  }, []);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = { to: parseAddresses(to), cc: parseAddresses(cc), bcc: parseAddresses(bcc) };
    const bad = [...parsed.to.bad, ...parsed.cc.bad, ...parsed.bcc.bad];
    if (bad.length) return toast(`Not an email address: ${bad.join(", ")}`, "error");
    if (!parsed.to.list.length && !parsed.cc.list.length && !parsed.bcc.list.length) return toast("Add at least one recipient.", "error");
    const drafts = byRole(boxes, "drafts");
    const sent = byRole(boxes, "sent");
    if (!drafts || !sent || !identity) return toast("The mailbox has no Drafts or Sent folder, or no identity to send as.", "error");
    setBusy(true);
    try {
      const threading: Record<string, unknown> =
        original?.messageId?.length && draft.kind !== "forward"
          ? { inReplyTo: original.messageId, references: [...(original.references ?? []), ...original.messageId] }
          : {};
      const email = {
        mailboxIds: { [drafts.id]: true },
        keywords: { $seen: true, $draft: true },
        from: [{ name: identity.name || undefined, email: identity.email }],
        to: parsed.to.list,
        cc: parsed.cc.list,
        bcc: parsed.bcc.list,
        subject: subject.trim(),
        bodyValues: { b: { value: body } },
        textBody: [{ partId: "b", type: "text/plain" }],
        attachments: files.map((f) => ({ blobId: f.blobId, type: f.type, name: f.name, disposition: "attachment" })),
        ...threading,
      };
      const r = await jmap([
        ["Email/set", { accountId: account, create: { m: email } }, "0"],
        [
          "EmailSubmission/set",
          {
            accountId: account,
            create: { s: { emailId: "#m", identityId: identity.id } },
            onSuccessUpdateEmail: { "#s": { [`mailboxIds/${drafts.id}`]: null, [`mailboxIds/${sent.id}`]: true, "keywords/$draft": null } },
          },
          "1",
        ],
        ...(original
          ? [["Email/set", { accountId: account, update: { [original.id]: { [draft.kind === "forward" ? "keywords/$forwarded" : "keywords/$answered"]: true } } }, "2"] as [string, Record<string, unknown>, string]]
          : []),
      ]);
      const failed = (r["0"].notCreated as Record<string, { description?: string }> | undefined)?.m ?? (r["1"].notCreated as Record<string, { description?: string }> | undefined)?.s;
      if (failed) throw new Error(failed.description ?? "The mail server refused to send it.");
      toast("Sent");
      void qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] === "list" || q.queryKey[1] === "mailboxes" });
      onSent?.();
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const title = { new: "New message", reply: "Reply", replyAll: "Reply to all", forward: "Forward" }[draft.kind];
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={send} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {(identities.data?.length ?? 0) > 1 ? "Choose who it is from." : `From ${identity ? (identity.name ? `${identity.name} <${identity.email}>` : identity.email) : me}`}
            </DialogDescription>
          </DialogHeader>
          {(identities.data?.length ?? 0) > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor="mail-from">From</Label>
              <select id="mail-from" className="h-9 rounded-md border bg-background px-2 text-sm" value={identity?.id ?? ""} onChange={(e) => setFromId(e.target.value)}>
                {identities.data?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name ? `${i.name} <${i.email}>` : i.email}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="mail-to">To</Label>
            <Input id="mail-to" autoFocus={!to} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, …" autoComplete="off" />
          </div>
          {more ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="mail-cc">Cc</Label>
                <Input id="mail-cc" value={cc} onChange={(e) => setCc(e.target.value)} autoComplete="off" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mail-bcc">Bcc</Label>
                <Input id="mail-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} autoComplete="off" />
              </div>
            </>
          ) : (
            <Button type="button" variant="link" size="xs" className="justify-self-start p-0" onClick={() => setMore(true)}>
              Cc and Bcc
            </Button>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="mail-subject">Subject</Label>
            <Input id="mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={900} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mail-body">Message</Label>
            <Textarea id="mail-body" autoFocus={!!to} rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => picker.current?.click()}>
              <Paperclip aria-hidden="true" /> {uploading ? "Uploading…" : "Attach"}
            </Button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
            {fromDrive && (
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => void pickFromDrive()}>
                <FolderOpen aria-hidden="true" /> From Drive
              </Button>
            )}
            {files.map((f) => (
              <Badge key={f.blobId} variant="secondary" className="gap-1">
                {f.name} <span className="text-muted-foreground">{sizeLabel(f.size)}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.blobId !== f.blobId))}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Discard
            </Button>
            <Button type="submit" disabled={busy || uploading}>
              <Send aria-hidden="true" /> {busy ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Vacation {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string | null;
  textBody: string | null;
}

interface AppPassword {
  id: string;
  description: string;
  createdAt?: string;
}

function MailSettings({ account, me, servers, onClose }: { account: string; me: string; servers?: { imap: string; smtp: string }; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Mail settings</DialogTitle>
          <DialogDescription>{me}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="vacation">
          <TabsList>
            <TabsTrigger value="vacation">Vacation reply</TabsTrigger>
            <TabsTrigger value="apps">Mail programs</TabsTrigger>
          </TabsList>
          <TabsContent value="vacation">
            <VacationForm account={account} />
          </TabsContent>
          <TabsContent value="apps">
            <AppPasswords account={account} me={me} servers={servers} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function VacationForm({ account }: { account: string }) {
  const q = useQuery({
    queryKey: ["mail", "vacation", account],
    queryFn: async () => ((await jmap([["VacationResponse/get", { accountId: account, ids: ["singleton"] }, "0"]]))["0"].list as Vacation[])[0],
  });
  const [form, setForm] = useState<Vacation | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  if (q.error) return <p className="text-sm text-destructive">{errorMessage(q.error)}</p>;
  if (!form) return <Skeleton className="h-40" />;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const patch = {
        isEnabled: form.isEnabled,
        fromDate: form.fromDate ? `${day(form.fromDate)}T00:00:00Z` : null,
        toDate: form.toDate ? `${day(form.toDate)}T23:59:59Z` : null,
        subject: form.subject || null,
        textBody: form.textBody || null,
      };
      const r = await jmap([["VacationResponse/set", { accountId: account, update: { singleton: patch } }, "0"]]);
      const failed = (r["0"].notUpdated as Record<string, { description?: string }> | undefined)?.singleton;
      if (failed) throw new Error(failed.description ?? "The mail server refused the change.");
      toast(form.isEnabled ? "Your vacation reply is on." : "Your vacation reply is off.");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="grid gap-3 pt-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /> Answer incoming mail automatically
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="vac-from">From (optional)</Label>
          <Input id="vac-from" type="date" value={day(form.fromDate)} onChange={(e) => setForm({ ...form, fromDate: e.target.value || null })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="vac-to">Until (optional)</Label>
          <Input id="vac-to" type="date" value={day(form.toDate)} onChange={(e) => setForm({ ...form, toDate: e.target.value || null })} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="vac-subject">Subject</Label>
        <Input id="vac-subject" value={form.subject ?? ""} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Out of office" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="vac-body">Message</Label>
        <Textarea id="vac-body" rows={5} value={form.textBody ?? ""} onChange={(e) => setForm({ ...form, textBody: e.target.value })} />
      </div>
      <Button type="submit" className="justify-self-end" disabled={busy}>
        Save
      </Button>
    </form>
  );
}

function AppPasswords({ account, me, servers }: { account: string; me: string; servers?: { imap: string; smtp: string } }) {
  const qc = useQueryClient();
  const key = ["mail", "app-passwords", account];
  const list = useQuery({
    queryKey: key,
    queryFn: async () => (await jmap([["x:AppPassword/get", { accountId: account, ids: null, properties: ["description", "createdAt"] }, "0"]]))["0"].list as AppPassword[],
  });
  const [description, setDescription] = useState("");
  const [made, setMade] = useState<{ description: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await jmap([["x:AppPassword/set", { accountId: account, create: { p: { description: description.trim() } } }, "0"]]);
      const created = (r["0"].created as Record<string, { secret?: string }> | undefined)?.p;
      if (!created?.secret) throw new Error(String((r["0"].notCreated as Record<string, { description?: string }> | undefined)?.p?.description ?? "The mail server refused it."));
      setMade({ description: description.trim(), secret: created.secret });
      setDescription("");
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (a: AppPassword) => {
    if (!(await confirmDialog({ title: `Remove "${a.description}"?`, message: "Mail programs using it stop getting mail.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await jmap([["x:AppPassword/set", { accountId: account, destroy: [a.id] }, "0"]]);
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <div className="grid gap-3 pt-2 text-sm">
      <p className="text-muted-foreground">
        Mail programs (Outlook, Apple Mail, Thunderbird, phones) sign in with your address <strong className="text-foreground">{me}</strong> and an app password made here, one per program.
      </p>
      {servers && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border p-3">
          <dt className="text-muted-foreground">Incoming (IMAP, SSL)</dt>
          <dd className="font-mono">{servers.imap}</dd>
          <dt className="text-muted-foreground">Outgoing (SMTP, SSL)</dt>
          <dd className="font-mono">{servers.smtp}</dd>
        </dl>
      )}
      {made && (
        <div className="grid gap-1 rounded-md border border-primary/40 bg-primary/5 p-3" role="status">
          <span>
            App password for <strong>{made.description}</strong>. Copy it now: it is not shown again.
          </span>
          <code className="rounded bg-background px-2 py-1 font-mono text-base select-all">{made.secret}</code>
          <Button variant="outline" size="xs" className="justify-self-start" onClick={() => void navigator.clipboard?.writeText(made.secret).then(() => toast("Copied"))}>
            Copy
          </Button>
        </div>
      )}
      <form onSubmit={create} className="flex gap-2">
        <Input aria-label="What the app password is for" placeholder="e.g. Phone" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={100} />
        <Button type="submit" disabled={!description.trim() || busy}>
          Make one
        </Button>
      </form>
      {list.isLoading && <Skeleton className="h-16" />}
      {!!list.error && <p className="text-destructive">{errorMessage(list.error)}</p>}
      <ul className="grid gap-1" aria-label="App passwords">
        {list.data?.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
            <Inbox className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{a.description || "(no description)"}</span>
            {a.createdAt && <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>}
            <Button variant="ghost" size="xs" onClick={() => void revoke(a)}>
              Remove
            </Button>
          </li>
        ))}
        {list.data && !list.data.length && <li className="text-muted-foreground">No app passwords yet.</li>}
      </ul>
    </div>
  );
}

