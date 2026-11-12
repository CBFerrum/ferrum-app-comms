// Webmail on the Mail app's mail API: the person's hosted mailbox over JMAP, and the shared
// mailboxes they are a member of (sales@: one more account in their session). Folders, the
// messages of a folder as conversations (searched, read in a sandboxed frame with remote images on
// request), writing with attachments, drafts that are kept, replies and forwards, spam training
// ("Spam" / "Not spam" teach the server's filter), filing a mail onto a record, and settings: the
// vacation reply and app passwords for mail programs. The keyboard drives all of it (? lists the keys).

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@ferrum/kit/primitives";
import { api, errorMessage, newKey, shell, t as tr, isolate } from "@ferrum/client";
import { cn, ListSkeleton, ReaderSkeleton, StatePanel, toast } from "@ferrum/kit";
import { Failure } from "./States";
import { Composer, ComposeStack, loadDraft, openBefore, useIdentities, type Win } from "./MailCompose";
import { prefsOf, useMailData } from "./MailData";
import { ForwardingBanner } from "./MailFilters";
import { useMailWatch, useSnoozeWake } from "./MailWatch";
import { ScheduledList } from "./MailScheduled";
import { UndoProvider, useEnsureArchive, useUndo } from "./MailActions";
import { FolderNav } from "./MailFolders";
import { MessageList } from "./MailList";
import { Conversation } from "./MailReader";
import { MailSettings } from "./MailSettings";
import { SCHEDULED, virtualFolder } from "./lib/folders";
import { workspaceDomains } from "./lib/safety";
import {
  SHORTCUTS,
  WRITING_SHORTCUTS,
  busyWith,
  byRole,
  jmap,
  MAIL,
  keyAction,
  keptDrafts,
  mailAccount,
  serverDoes,
  sortMailboxes,
  useMailSession,
  type Draft,
  type Mailbox,
  type Session,
} from "./lib/mail";

export { Composer };

/** `/mail/:mailbox?/:email?` */
/** Why someone has no mail here: no mailbox, a locked one, or the mail server is unavailable. */
export function MailUnavailable({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const status = (error as { status?: number }).status;
  // A locked mailbox is a refusal; no mailbox at all is a first-use empty page; neither is a breakage.
  if (status === 403)
    return (
      <StatePanel kind="denied" className="h-[60vh]" title={tr("Your mailbox is locked")}>
        {tr("An administrator deactivated it or your address left the workspace's mail domain. Your mail is kept.")}
      </StatePanel>
    );
  if (status === 404)
    return (
      <StatePanel kind="empty" className="h-[60vh]" title={tr("You have no mailbox here")}>
        {tr("Mailboxes come with hosted mail: an administrator sets the workspace's mail domain, and everyone whose address is in it gets one.")}
      </StatePanel>
    );
  return <Failure error={error} onRetry={onRetry} />;
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
    // Counts stay true without a reload: every minute, and when the window is back in front.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

/** `/mail/…`; `/mail/compose` (the bar's Create menu) opens with a new message. */
export function MailPage({ compose = false }: { compose?: boolean }) {
  const session = useMailSession();
  if (session.isLoading)
    return (
      <div data-fullbleed className="grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0 md:grid-cols-[200px_380px_minmax(0,1fr)]">
        <div className="hidden border-e md:block" />
        <ListSkeleton className="min-h-0 overflow-hidden border-e" rows={8} />
        <ReaderSkeleton className="hidden md:block" />
      </div>
    );
  if (session.fetchStatus === "paused" && !session.data) return <StatePanel kind="offline" className="h-[60vh]" onRetry={() => void session.refetch()}>{tr("Mail opens when you are back online.")}</StatePanel>;
  if (session.error) return <MailUnavailable error={session.error} onRetry={() => void session.refetch()} />;
  const primary = mailAccount(session.data);
  if (!session.data || !primary) return <Failure error={new Error(tr("The mail server offers no mail account."))} />;
  return (
    <UndoProvider>
      <Mailroom session={session.data} primary={primary} compose={compose} />
    </UndoProvider>
  );
}

/** Where a new-mail notification goes (`/mail/n/{id}`, from the server's `comms.newmail`): the message it was about, or the Inbox for several. */
export function MailNoticePage() {
  const { notice } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["mail", "notice", notice], queryFn: () => api.get<{ account: string; email: string | null; folder: string | null }>(`${MAIL}/notice/${encodeURIComponent(notice ?? "")}`), retry: false });
  useEffect(() => {
    if (q.data) navigate(q.data.folder ? `/mail/${q.data.folder}${q.data.email ? `/${q.data.email}` : ""}` : "/mail", { replace: true });
    else if (q.error) navigate("/mail", { replace: true });
  }, [q.data, q.error, navigate]);
  return <StatePanel kind="loading" className="h-[60vh]" />;
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
  const [wins, setWins] = useState<Win[]>(() => (compose ? [{ id: newKey(), draft: { kind: "new" }, state: "open" }] : []));
  /** Opens a message to write in a window of its own; the older windows fold to bars when there are many. */
  const write = (d: Draft) =>
    setWins((all) => {
      if (d.saved?.id && all.some((w) => w.draft.saved?.id === d.saved?.id)) return all;
      const next = [...all, { id: newKey(), draft: d, state: "open" as const }];
      return next.map((w, i) => (i < next.length - 2 && w.state === "open" ? { ...w, state: "min" as const } : w));
    });
  const [settings, setSettings] = useState<string | false>(false);
  const [keys, setKeys] = useState(false);
  const [sheet, setSheet] = useState(false);
  const undo = useUndo();
  const boxes = useMailboxes(account);
  const canEdit = !session.accounts[account]?.isReadOnly;
  useEnsureArchive(account, boxes.data, canEdit);
  const inbox = byRole(boxes.data, "inbox")?.id;
  const current = mailbox ?? inbox;
  const open = (box: string, id?: string) => navigate((id ? `/mail/${box}/${id}` : `/mail/${box}`) + suffix);
  const folder = boxes.data?.find((b) => b.id === current) ?? virtualFolder(current ?? "");
  const domains = workspaceDomains(session.username, accounts.map(([, a]) => a.name));
  const identities = useIdentities(account).data;
  const own = [me, ...(identities ?? []).map((i) => i.email)];
  const data = useMailData(account, boxes.data);
  const prefs = prefsOf(data.data?.data);
  // The server notifies about the person's own mailbox; a shared one is announced here, while open.
  useMailWatch({ account, boxes: boxes.data, own, notify: prefs.notify, open, enabled: !!boxes.data, serverNotifies: serverDoes(session, "arrivals") && account === primary });
  useSnoozeWake(account, boxes.data, canEdit);
  // Compact or comfortable, through the kit's density tokens, for this page.
  useEffect(() => {
    document.documentElement.dataset.density = prefs.density;
    return () => void delete document.documentElement.dataset.density;
  }, [prefs.density]);

  // The Mail tile in the bar shows what waits in the inbox, as Chat's shows its unread.
  const waiting = byRole(boxes.data, "inbox")?.unreadEmails ?? 0;
  // The bar draws no count on an app's tile (its badge() only badges an installed app's icon), so the tab's title carries it too, as Gmail's does.
  useEffect(() => {
    shell().badge(account === primary ? waiting : 0);
    if (boxes.data) shell().title(account === primary && waiting ? `Mail (${waiting > 999 ? "999+" : waiting})` : "Mail");
  }, [waiting, account, primary, boxes.data]);
  useEffect(
    () => () => {
      shell().badge(0);
      shell().title("Mail");
    },
    [],
  );

  // Writing, help and undo from the keyboard anywhere in Mail.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyAction(e);
      if ((k !== "compose" && k !== "help" && k !== "undo") || busyWith(e.target as HTMLElement | null, e.key)) return;
      e.preventDefault();
      if (k === "compose") write({ kind: "new" });
      else if (k === "undo") undo.undo();
      else setKeys(true);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [undo]);

  // A message in Drafts opens to be written on, not to be read.
  const [opening, setOpening] = useState<string | null>(null);
  const openDraft = async (id: string) => {
    setOpening(id);
    try {
      write(await loadDraft(account, id));
    } catch (e) {
      toast(tr("The draft could not be opened: {e}", { e: errorMessage(e) }), "error");
    } finally {
      setOpening(null);
    }
  };
  const onOpen = (id: string) => (folder?.role === "drafts" ? void openDraft(id) : open(current!, id));

  // The windows open before a reload come back: from this browser's copy when it has newer words, else from Drafts.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !boxes.data) return;
    restored.current = true;
    const kept = keptDrafts(account);
    for (const o of openBefore(account)) {
      const k = kept.find((x) => x.key === o.key);
      if (k) write({ kind: "new", saved: { id: k.draftId ?? o.id ?? undefined, key: k.key, written: k.written, inReplyTo: k.inReplyTo, references: k.references } });
      else if (o.id) void loadDraft(account, o.id).then((d) => write({ ...d, saved: { ...d.saved, key: o.key } }), () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the folders are known
  }, [boxes.data, account]);

  if (boxes.error) return <Failure error={boxes.error} onRetry={() => void boxes.refetch()} />;
  const nav = (inSheet: boolean) => (
    <FolderNav
      account={account}
      accounts={accounts}
      onAccount={(id) => (setSheet(false), switchTo(id))}
      boxes={boxes.data}
      loading={boxes.isLoading}
      current={current}
      suffix={suffix}
      canEdit={canEdit}
      onWrite={() => (setSheet(false), write({ kind: "new" }))}
      onKeys={() => (setSheet(false), setKeys(true))}
      onSettings={() => (setSheet(false), setSettings("general"))}
      onNavigate={inSheet ? () => setSheet(false) : undefined}
      onGone={(id) => id === current && inbox && open(inbox)}
      refetch={() => void boxes.refetch()}
      data={data.data?.data}
    />
  );
  const pane = prefs.pane;
  return (
    <div
      data-fullbleed
      className={cn(
        "grid h-[calc(100dvh-var(--ferrum-bar-height,48px))] min-h-0",
        pane === "right" ? "md:grid-cols-[200px_380px_minmax(0,1fr)]" : "md:grid-cols-[200px_minmax(0,1fr)]",
        pane === "below" && "md:grid-rows-[minmax(0,2fr)_minmax(0,3fr)]",
      )}
    >
      <aside className={cn("hidden min-h-0 flex-col gap-2 border-e p-2 md:flex", pane === "below" && "md:row-span-2")} aria-label={tr("Folders")}>
        {nav(false)}
      </aside>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="left" className="top-(--ferrum-bar-height,48px) h-auto w-4/5 gap-2 p-2 md:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>{tr("Folders")}</SheetTitle>
            <SheetDescription>{tr("The folders of the mailbox, and your own folders.")}</SheetDescription>
          </SheetHeader>
          {nav(true)}
        </SheetContent>
      </Sheet>
      <section className={cn("flex min-h-0 flex-col border-e", email && "hidden md:flex", email && pane === "off" && "md:hidden", pane === "below" && "md:border-e-0 md:border-b")} aria-label={tr("Messages")}>
        {canEdit && <ForwardingBanner account={account} boxes={boxes.data ?? []} onManage={() => setSettings("filters")} />}
        <div className="min-h-0 flex-1">
        {current === SCHEDULED ? (
          <ScheduledList account={account} boxes={boxes.data ?? []} onFolders={() => setSheet(true)} open={write} />
        ) : current && (
          <MessageList
            key={account + current}
            account={account}
            me={me}
            mailbox={folder}
            mailboxId={current}
            boxes={boxes.data ?? []}
            active={email}
            opening={opening}
            onOpen={onOpen}
            onWrite={() => write({ kind: "new" })}
            onSettings={() => setSettings("general")}
            onFolders={() => setSheet(true)}
            onKept={write}
            writing={wins.length > 0}
            own={own}
          />
        )}
        </div>
      </section>
      <section className={cn("min-h-0", !email && "hidden md:grid md:place-items-center", !email && pane === "off" && "md:hidden")}>
        {email && current ? (
          <Conversation key={account + email} account={account} id={email} me={me} own={own} boxes={boxes.data ?? []} folder={current} domains={domains} onBack={() => open(current)} onDraft={write} />
        ) : (
          <p className="text-sm text-muted-foreground">{tr("Pick a message to read it.")}</p>
        )}
      </section>
      <ComposeStack
        wins={wins}
        setWins={(f) => {
          setWins(f);
          if (compose) navigate("/mail", { replace: true });
        }}
        account={account}
        me={me}
        boxes={boxes.data ?? []}
        open={write}
      />
      {settings && <MailSettings account={primary} me={session.username} servers={session.servers} boxes={account === primary ? (boxes.data ?? []) : []} own={own} tab={settings} folder={folder} onClose={() => setSettings(false)} />}
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
              <dt>{isolate(s.label)}</dt>
              <dd className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {isolate(k)}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <h3 className="pt-2 text-sm font-semibold">{tr("While writing")}</h3>
        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
          {WRITING_SHORTCUTS.map((s) => (
            <div key={s.label} className="contents">
              <dt>{isolate(s.label)}</dt>
              <dd className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {isolate(k)}
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
