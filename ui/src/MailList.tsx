// The messages of a folder as conversations: a grid with a checkbox on every row, quick actions on
// hover, the selection toolbar over it, "Empty Trash" and "Empty Spam" at the top of those folders,
// and the keys (j k x e # ! v z s Shift+U Shift+I) acting on the selection or the row under the cursor.

import { useInfiniteQuery } from "@tanstack/react-query";
import { Archive, Menu, Paperclip, Pencil, Search, Settings, ShieldAlert, ShieldCheck, Star, Trash2, MailOpen, Mail as MailClosed } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@ferrum/kit/primitives";
import { relativeTime, t as tr, isolate } from "@ferrum/client";
import { cn, confirmDialog, ListSkeleton, SelectionToolbar, StatePanel, useDebounced } from "@ferrum/kit";
import { Failure } from "./States";
import { useMailActions } from "./MailActions";
import { useMedia } from "./MailCompose";
import { ActionBar, IconAction } from "./MailToolbar";
import { conversations, offered, rangeBetween, type Verb } from "./lib/actions";
import { ALL_MAIL, STARRED, folderName, isVirtual, purgeLine } from "./lib/folders";
import { fullDate, listDate, senderLabel } from "./lib/list";
import { busyWith, byRole, conversationRows, jmap, keyAction, keptDrafts, dropDraft, messagesIn, type Draft, type EmailSummary, type Mailbox, type MailKey, type Row } from "./lib/mail";

const PAGE = 50;
const LIST_PROPERTIES = ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "receivedAt", "preview", "hasAttachment"];

export interface ListProps {
  account: string;
  me: string;
  mailbox?: Mailbox;
  mailboxId: string;
  boxes: Mailbox[];
  active?: string;
  opening: string | null;
  onOpen: (id: string) => void;
  onWrite: () => void;
  onSettings: () => void;
  onFolders: () => void;
  onKept: (d: Draft) => void;
  writing: boolean;
}

/** What JMAP is asked for a folder: its messages, Starred (a keyword), All mail (everything but Trash and Spam). */
function folderFilter(id: string, boxes: Mailbox[]): Record<string, unknown> {
  if (id === STARRED) return { hasKeyword: "$flagged" };
  if (id === ALL_MAIL) return { inMailboxOtherThan: ["trash", "junk"].map((r) => byRole(boxes, r)?.id).filter(Boolean) };
  return { inMailbox: id };
}

const emptyText = (role: string | null | undefined) =>
  role === "junk" ? tr("Nothing in Spam. Good.")
  : role === "trash" ? tr("Trash is empty.")
  : role === "drafts" ? tr("No drafts. A message you start and leave is kept here.")
  : role === "starred" ? tr("No starred conversations. Press s on one to star it.")
  : role === "inbox" ? tr("Your inbox is empty.")
  : role === "archive" ? tr("Nothing archived yet. Press e on a conversation to put it here.")
  : role === "sent" ? tr("Nothing sent yet.")
  : tr("No messages here.");

export function MessageList(p: ListProps) {
  // A phone's width: the selection bar folds its actions into a menu.
  const phone = useMedia("(max-width: 720px)");
  const actions = useMailActions(p.account, p.boxes);
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed.trim(), 300);
  const searchBox = useRef<HTMLInputElement>(null);
  const role = p.mailbox?.role;
  const outgoing = role === "sent" || role === "drafts";
  const filter = useMemo(() => ({ ...folderFilter(p.mailboxId, p.boxes), ...(search ? { text: search } : {}) }), [p.mailboxId, p.boxes, search]);
  const whole = isVirtual(p.mailboxId);
  const list = useInfiniteQuery({
    queryKey: ["mail", "list", p.account, p.mailboxId, search],
    queryFn: async ({ pageParam }) => {
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
      return { rows: conversationRows(emails, threads, flags, p.mailboxId, whole), total: Number(r.q.total ?? 0), position: pageParam };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.position + PAGE < last.total ? last.position + PAGE : undefined),
    // New mail arrives by looking again: every minute and whenever the window is back in front.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((pg) => pg.rows) ?? [], [list.data]);
  // Offline, the query waits (it is neither loading nor empty): say so, and show what was loaded.
  const offline = list.fetchStatus === "paused";
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);

  // The cursor and the selection are kept by id, so new mail at the top moves neither.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const found = rows.findIndex((r) => r.id === cursorId);
  const at = found >= 0 ? found : 0;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useEffect(() => setSelected((s) => (s.size && [...s].some((i) => !ids.includes(i)) ? new Set([...s].filter((i) => ids.includes(i))) : s)), [ids]);
  useEffect(() => {
    setCursorId(null);
    setSelected(new Set());
  }, [search]);
  useEffect(() => {
    const i = rows.findIndex((r) => r.id === p.active);
    if (i >= 0) setCursorId(rows[i]!.id);
  }, [p.active, rows]);
  // Back from a conversation (after archiving it, say): focus goes to its row, or to the one now in its place.
  const left = useRef<{ id: string; index: number; until: number } | null>(null);
  const wasActive = useRef(p.active);
  useEffect(() => {
    if (wasActive.current && !p.active) left.current = { id: wasActive.current, index: Math.max(0, rows.findIndex((r) => r.id === wasActive.current)), until: Date.now() + 4000 };
    wasActive.current = p.active;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a conversation closes
  }, [p.active]);
  useEffect(() => {
    const l = left.current;
    if (!l || Date.now() > l.until || !rows.length) return;
    const still = rows.findIndex((r) => r.id === l.id);
    const target = rows[still >= 0 ? still : Math.min(l.index, rows.length - 1)]!;
    setCursorId(target.id);
    requestAnimationFrame(() => (document.querySelector(`[data-row="${target.id}"]`) as HTMLElement | null)?.focus());
  }, [rows]);
  const cursorRow = rows[at]?.id;
  useEffect(() => {
    if (cursorRow) document.querySelector(`[data-row="${cursorRow}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursorRow]);

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const toggle = (id: string, shift: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      if (shift && anchor.current) for (const i of rangeBetween(ids, anchor.current, id)) next.add(i);
      else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
    setCursorId(id);
  };
  const clear = () => setSelected(new Set());

  const [moveOpen, setMoveOpen] = useState(false);
  /** What an action reaches: the selection, else the row under the cursor (when no conversation is open). */
  const targets = (): Row[] => (chosen.length ? chosen : rows[at] && !p.active ? [rows[at]!] : []);
  const apply = async (verb: Verb, from: Row[], to?: Mailbox) => {
    if (!from.length) return;
    // The cursor goes to a neighbour that stays, so the keys carry on from there.
    const gone = new Set(from.map((r) => r.id));
    const next = rows.slice(at + 1).find((r) => !gone.has(r.id)) ?? [...rows.slice(0, at)].reverse().find((r) => !gone.has(r.id));
    const leaves = verb === "archive" || verb === "trash" || verb === "spam" || verb === "notSpam" || verb === "phishing" || (verb === "move" && to?.id !== p.mailboxId);
    if (leaves && !whole && next) {
      setCursorId(next.id);
      (document.querySelector(`[data-row="${next.id}"]`) as HTMLElement | null)?.focus();
    }
    if (await actions.run({ verb, ids: from.flatMap((r) => r.folderIds), count: from.length, to, from: role })) clear();
  };
  const forever = async (from: Row[]) => {
    if (!from.length) return;
    const n = from.reduce((s, r) => s + r.folderIds.length, 0);
    const ok = await confirmDialog({
      title: tr("Delete {value} for good?", { value: conversations(from.length) }),
      message: tr("{n} messages will be removed from {folder} and cannot be recovered.", { n, folder: folderName(p.mailbox ?? { name: "", role: null }) }),
      confirmLabel: tr("Delete forever"),
      danger: true,
    });
    if (ok && (await actions.destroy(from.flatMap((r) => r.folderIds)))) clear();
  };
  const empty = async () => {
    const box = p.mailbox;
    if (!box) return;
    const ok = await confirmDialog({
      title: box.role === "junk" ? tr("Empty Spam?") : tr("Empty Trash?"),
      message: tr("All {n} messages in {folder} will be deleted for good. This cannot be undone.", { n: box.totalEmails, folder: folderName(box) }),
      confirmLabel: box.role === "junk" ? tr("Empty Spam") : tr("Empty Trash"),
      danger: true,
    });
    if (ok) await actions.destroy(await actions.idsIn(box.id));
  };

  // Keys act on the selection or the row under the cursor; j and k also carry through the conversations when one is open.
  const keys = useRef<(k: MailKey) => void>(() => undefined);
  keys.current = (k) => {
    const row = rows[at];
    if (k === "next" || k === "previous") {
      const to = Math.min(rows.length - 1, Math.max(0, at + (k === "next" ? 1 : -1)));
      if (rows[to]) setCursorId(rows[to]!.id);
      if (p.active && rows[to]) p.onOpen(rows[to]!.id);
    } else if (k === "open") {
      if (row) p.onOpen(row.id);
    } else if (k === "search") searchBox.current?.focus();
    else if (k === "back") clear();
    else if (k === "select") {
      if (row) toggle(row.id, false);
    } else if (k === "move") {
      if (!chosen.length && row) setSelected(new Set([row.id]));
      if (offered(role).move) setMoveOpen(true);
    } else if (!p.active || chosen.length) {
      const t = targets();
      const o = offered(role);
      if (k === "star") void apply(t.every((r) => r.keywords?.$flagged) ? "unstar" : "star", t);
      else if (k === "unread") void apply("unread", t);
      else if (k === "read") void apply("read", t);
      else if (k === "archive" && o.archive) void apply("archive", t);
      else if (k === "spam") void apply(o.notSpam ? "notSpam" : "spam", t);
      else if (k === "delete") void (o.deleteForever ? forever(t) : apply("trash", t));
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyAction(e);
      if (!k || busyWith(e.target as HTMLElement | null, e.key) || p.writing) return;
      if (["next", "previous", "open", "search", "star", "unread", "read", "archive", "spam", "delete", "select", "move"].includes(k) || (k === "back" && !p.active)) {
        if (k === "back" && !selectedRef.current) return;
        e.preventDefault();
        keys.current(k);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [p.writing, p.active]);
  const selectedRef = useRef(false);
  selectedRef.current = selected.size > 0;

  // Messages written and not sent that only this browser has (the mail server never took them, or
  // not their last words); looked at again whenever the window for writing closes.
  const [gone, setGone] = useState<string[]>([]);
  const kept = useMemo(() => (p.writing ? [] : keptDrafts(p.account)), [p.account, p.writing]);
  const lost = kept.filter((k) => !gone.includes(k.key)).slice(0, 1);

  const anyUnread = chosen.some((r) => r.unread);
  const allStarred = chosen.length > 0 && chosen.every((r) => r.keywords?.$flagged);
  const all = chosen.length === rows.length && rows.length > 0;
  const holds = role === "trash" || role === "junk";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {chosen.length > 0 ? (
        <SelectionToolbar
          label={tr("Actions for the {n} conversations selected", { n: chosen.length })}
          count={chosen.length}
          onClear={clear}
          extend={
            // A phone's bar has no room for it: it is in the bar's menu there.
            !all && !phone && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(ids))}>
                {tr("Select all {n}", { n: rows.length })}
              </Button>
            )
          }
        >
          <span className="flex shrink-0 items-center">
            <ActionBar
              compact={phone}
              onSelectAll={all ? undefined : () => setSelected(new Set(ids))}
              role={role}
              boxes={p.boxes}
              anyUnread={anyUnread}
              allStarred={allStarred}
              folderId={p.mailboxId}
              onVerb={(v) => void apply(v, chosen)}
              onMove={(to) => void apply("move", chosen, to)}
              onForever={() => void forever(chosen)}
              moveOpen={moveOpen}
              onMoveOpen={setMoveOpen}
            />
          </span>
        </SelectionToolbar>
      ) : (
        <div className="flex items-center gap-2 border-b p-2">
          <Button size="icon" variant="ghost" className="md:hidden" aria-label={tr("Folders")} onClick={p.onFolders}>
            <Menu />
          </Button>
          <Checkbox
            aria-label={tr("Select all conversations in view")}
            checked={false}
            disabled={!rows.length}
            className="max-md:hidden"
            onClick={() => setSelected(new Set(ids))}
          />
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-2.5 start-2 size-4 text-muted-foreground" aria-hidden="true" />
            <Input ref={searchBox} className="ps-8" type="search" placeholder={tr("Search {value}", { value: p.mailbox ? folderName(p.mailbox) : "mail" })} aria-label={tr("Search mail")} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <Button size="icon" variant="outline" className="md:hidden" aria-label={tr("Write")} onClick={p.onWrite}>
            <Pencil />
          </Button>
          <Button size="icon" variant="ghost" className="md:hidden" aria-label={tr("Mail settings")} onClick={p.onSettings}>
            <Settings />
          </Button>
        </div>
      )}
      {holds && rows.length > 0 && !search && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">{purgeLine()}</span>
          <Button size="sm" variant="outline" onClick={() => void empty()}>
            <Trash2 aria-hidden="true" /> {role === "junk" ? tr("Empty Spam now") : tr("Empty Trash now")}
          </Button>
        </div>
      )}
      {lost.map((k) => (
        <div key={k.key} role="status" className="grid gap-1 border-b bg-warning-soft px-3 py-2 text-sm">
          <span>
            {tr("You have a message you did not send, from")} {isolate(relativeTime(k.savedAt))}: <strong className="font-medium">{k.written.subject || k.written.text.trim().slice(0, 40) || tr("(no subject)")}</strong>
          </span>
          <span className="flex gap-2">
            <Button
              size="xs"
              onClick={() =>
                p.onKept({ kind: "new", saved: { id: k.draftId, key: k.key, written: k.written, inReplyTo: k.inReplyTo, references: k.references } })
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
      {offline && rows.length > 0 && (
        <div role="status" className="border-b bg-warning-soft px-3 py-1.5 text-xs">
          {tr("You are offline. This is what was loaded; it updates when you are back.")}
        </div>
      )}
      {!!list.error && rows.length > 0 && (
        <div role="alert" className="flex items-center gap-2 border-b bg-warning-soft px-3 py-1.5 text-xs">
          <span className="flex-1">{tr("The list could not be refreshed. It shows what was loaded.")}</span>
          <Button size="xs" variant="outline" onClick={() => void list.refetch()}>
            {tr("Try again")}
          </Button>
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto" role="grid" aria-multiselectable="true" aria-label={p.mailbox ? folderName(p.mailbox) : tr("Messages")} aria-busy={list.isLoading}>
        {list.isLoading && (
          <li role="presentation">
            <ListSkeleton rows={8} />
          </li>
        )}
        {offline && !rows.length && (
          <li role="presentation">
            <StatePanel kind="offline" onRetry={() => void list.refetch()}>
              {tr("This folder will show when you are back online.")}
            </StatePanel>
          </li>
        )}
        {!!list.error && !rows.length && !list.isLoading && (
          <li role="presentation">
            <Failure error={list.error} onRetry={() => void list.refetch()} title={tr("This folder could not be listed")} />
          </li>
        )}
        {!list.isLoading && !list.error && !offline && !rows.length && (
          <li role="presentation">
            {search ? (
              <StatePanel kind="no-matches" onClear={() => setTyped("")}>
                {tr("Nothing in {value} matches “{search}”.", { value: p.mailbox ? folderName(p.mailbox) : tr("this folder"), search })}
              </StatePanel>
            ) : (
              <StatePanel kind="empty" title={emptyText(role)} />
            )}
          </li>
        )}
        {rows.map((m, i) => (
          <MailRow
            key={m.id}
            m={m}
            sender={senderLabel(m.from, m.to, p.me, outgoing)}
            selected={selected.has(m.id)}
            checks={chosen.length > 0}
            cursor={i === at}
            open={m.id === p.active}
            busy={p.opening === m.id}
            role={role}
            onToggle={(shift) => toggle(m.id, shift)}
            onOpen={() => {
              setCursorId(m.id);
              p.onOpen(m.id);
            }}
            onVerb={(v) => void apply(v, [m])}
            onForever={() => void forever([m])}
          />
        ))}
        {list.hasNextPage && (
          <li className="p-2 text-center" role="presentation">
            <Button variant="ghost" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? tr("Loading…") : tr("Older messages")}
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}

function MailRow(p: {
  m: Row;
  sender: string;
  selected: boolean;
  checks: boolean;
  cursor: boolean;
  open: boolean;
  busy: boolean;
  role: string | null | undefined;
  onToggle: (shift: boolean) => void;
  onOpen: () => void;
  onVerb: (v: Verb) => void;
  onForever: () => void;
}) {
  const { m } = p;
  const o = offered(p.role);
  const starred = !!m.keywords?.$flagged;
  return (
    <li
      role="row"
      aria-selected={p.selected}
      className={cn(
        // Open = tinted with an accent edge; selected = tinted; the keyboard's place and the pointer = grey; unread = dot and weight.
        "group/row relative border-b border-s-[3px] border-s-transparent hover:bg-accent",
        p.cursor && "bg-accent/50",
        p.selected && "bg-primary-soft hover:bg-primary-soft",
        p.open && "border-s-primary bg-primary-soft hover:bg-primary-soft",
      )}
    >
      <div role="gridcell" className="absolute start-1.5 top-2.5 z-[1] grid size-6 place-items-center">
        <Checkbox
          aria-label={tr("Select the conversation from {sender}: {subject}", { sender: p.sender, subject: m.subject || tr("(no subject)") })}
          checked={p.selected}
          onClick={(e) => p.onToggle(e.shiftKey)}
          className={cn("opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=checked]:opacity-100 pointer-coarse:opacity-100 max-[720px]:opacity-100", p.checks && "opacity-100")}
        />
      </div>
      <div role="gridcell">
        <button
          type="button"
          data-row={m.id}
          disabled={p.busy}
          onClick={p.onOpen}
          aria-current={p.open ? "true" : undefined}
          className="grid w-full grid-cols-[minmax(0,1fr)] gap-0.5 py-2 ps-9 pe-3 text-start text-sm focus-visible:-outline-offset-2"
        >
          <span className="flex items-center gap-2">
            {m.unread && <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={tr("Unread")} />}
            <span className={cn("min-w-0 flex-1 truncate", m.unread && "font-semibold")}>
              {isolate(p.sender)}
              {m.count > 1 && (
                <span className="ms-1 font-normal text-muted-foreground" title={messagesIn(m.count)}>
                  ({m.count})
                </span>
              )}
            </span>
            {starred && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label={tr("Starred")} />}
            {m.hasAttachment && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label={tr("Has attachments")} />}
            <time className={cn("shrink-0 text-xs", m.unread ? "font-medium text-foreground" : "text-muted-foreground")} dateTime={m.receivedAt} title={fullDate(m.receivedAt)}>
              {isolate(listDate(m.receivedAt))}
            </time>
          </span>
          <span className={cn("truncate", m.unread && "font-medium")}>{m.subject || tr("(no subject)")}</span>
          <span className="truncate text-xs text-muted-foreground">{isolate(m.preview)}</span>
        </button>
      </div>
      <div role="gridcell" className="absolute end-2 top-0.5 hidden items-center rounded-md border bg-card shadow-xs group-has-[:focus-visible]/row:flex group-hover/row:flex pointer-coarse:hidden">
        {o.archive && (
          <IconAction label={tr("Archive")} keys="e" onClick={() => p.onVerb("archive")}>
            <Archive />
          </IconAction>
        )}
        {o.trash && (
          <IconAction label={tr("Delete")} keys="#" onClick={() => p.onVerb("trash")}>
            <Trash2 />
          </IconAction>
        )}
        {o.notSpam && (
          <IconAction label={tr("Not spam: move to Inbox, and the filter learns")} keys="!" onClick={() => p.onVerb("notSpam")}>
            <ShieldCheck />
          </IconAction>
        )}
        {o.deleteForever && (
          <IconAction label={tr("Delete forever")} onClick={p.onForever} danger>
            <Trash2 className="text-destructive" />
          </IconAction>
        )}
        {o.spam && (
          <IconAction label={tr("Report spam")} keys="!" onClick={() => p.onVerb("spam")}>
            <ShieldAlert />
          </IconAction>
        )}
        <IconAction label={m.unread ? tr("Mark as read") : tr("Mark as unread")} keys={m.unread ? "Shift+I" : "Shift+U"} onClick={() => p.onVerb(m.unread ? "read" : "unread")}>
          {m.unread ? <MailOpen /> : <MailClosed />}
        </IconAction>
        <IconAction label={starred ? tr("Remove the star") : tr("Star")} keys="s" pressed={starred} onClick={() => p.onVerb(starred ? "unstar" : "star")}>
          <Star className={cn(starred && "fill-warning text-warning")} />
        </IconAction>
      </div>
    </li>
  );
}

