// The folder list: an icon by role, the system folders in the person's words, Starred and All mail as
// searches, the person's own folders nested and managed here (new, rename, delete), counts that are
// quiet where they should be. Used beside the list and, on a phone, in a sheet.

import { AlarmClock, Archive, ArrowDownWideNarrow, CalendarClock, FileText, Folder, FolderPlus, Inbox, Keyboard, Layers, Mail, MoreHorizontal, Pencil, Search, Send, Settings, ShieldAlert, Star, Trash2, Users, type LucideIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Badge, Button, Progress, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Input, Label, Skeleton } from "@ferrum/kit/primitives";
import { errorMessage, isolate, t as tr } from "@ferrum/client";
import { cn, confirmDialog, toast } from "@ferrum/kit";
import { ensureArchive } from "./MailActions";
import { useScheduled } from "./MailScheduled";
import { useQuery } from "@tanstack/react-query";
import { useChangeMailData } from "./MailData";
import { DOT_CLASS } from "./MailLabels";
import { FOLDER_COLORS, type MailData } from "./lib/filters";
import { ALL_MAIL, LARGEST, SAVED, SCHEDULED, STARRED, customTree, folderCount, folderName, folderNameProblem, isSnoozed, systemFolders, withDescendants } from "./lib/folders";
import { byRole, jmap, refusal, sizeLabel, type Mailbox, type Session } from "./lib/mail";

const ICONS: Record<string, LucideIcon> = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, junk: ShieldAlert, trash: Trash2, starred: Star, all: Layers, scheduled: CalendarClock, snoozed: AlarmClock, saved: Search, largest: ArrowDownWideNarrow };

/** The mark of a folder: by its role, a plain folder for the person's own. */
export const FolderIcon = ({ role, className }: { role: string | null | undefined; className?: string }) => {
  const Icon = (role && ICONS[role]) || Folder;
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
};

interface Props {
  account: string;
  accounts: [string, Session["accounts"][string]][];
  onAccount: (id: string) => void;
  boxes: Mailbox[] | undefined;
  loading: boolean;
  current: string | undefined;
  suffix: string;
  /** The person may add and change folders here (not a read-only shared mailbox). */
  canEdit: boolean;
  onWrite: () => void;
  onKeys: () => void;
  onSettings: () => void;
  /** After a link is followed (closes the sheet on a phone). */
  onNavigate?: () => void;
  /** The folder that was open is gone: go to the inbox. */
  onGone: (id: string) => void;
  refetch: () => void;
  /** Mail's data on the server: saved searches and folder colours. */
  data?: MailData;
}

const COLOR_NAMES: Record<string, () => string> = { primary: () => tr("Blue"), success: () => tr("Green"), warning: () => tr("Yellow"), destructive: () => tr("Red"), purple: () => tr("Purple"), muted: () => tr("Grey") };

export function FolderNav(p: Props) {
  const changeData = useChangeMailData(p.account, p.boxes ?? []);
  const [naming, setNaming] = useState<{ mode: "new"; parent: Mailbox | null } | { mode: "rename"; box: Mailbox } | null>(null);
  const boxes = p.boxes ?? [];
  const link = (id: string, role: string | null, name: string, box?: Mailbox, depth = 0) => {
    const count = box ? folderCount(box) : null;
    const mine = !!box && !box.role;
    return (
      <li key={id} className="group/folder relative">
        <Link
          to={`/mail/${id}${p.suffix}`}
          onClick={p.onNavigate}
          aria-current={id === p.current ? "page" : undefined}
          style={{ paddingInlineStart: `${0.5 + depth * 0.875}rem` }}
          className={cn("flex items-center gap-2 rounded-md py-1.5 pe-2 text-sm text-foreground hover:bg-accent pointer-coarse:min-h-11", id === p.current && "bg-accent font-medium")}
        >
          {mine && p.data?.colors[id] ? (
            <span className={cn("ms-1 me-1 size-2.5 shrink-0 rounded-full", DOT_CLASS[p.data.colors[id]!])} aria-hidden="true" />
          ) : (
            <FolderIcon role={role} className={id === p.current ? "text-primary" : "text-muted-foreground"} />
          )}
          <span className="min-w-0 flex-1 truncate">{isolate(name)}</span>
          {count &&
            (count.quiet ? (
              <span className={cn("text-xs text-muted-foreground tabular-nums", mine && "group-hover/folder:hidden")} aria-label={role === "drafts" ? tr("{n} drafts", { n: count.n }) : tr("{n} unread", { n: count.n })}>
                {count.n}
              </span>
            ) : (
              <Badge className={cn("h-5 min-w-5 justify-center px-1.5", mine && "group-hover/folder:hidden")} aria-label={tr("{n} unread", { n: count.n })}>
                {count.n > 999 ? "999+" : count.n}
              </Badge>
            ))}
        </Link>
        {mine && p.canEdit && box && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="absolute end-0.5 top-1/2 size-7 -translate-y-1/2 opacity-0 group-focus-within/folder:opacity-100 group-hover/folder:opacity-100 pointer-coarse:opacity-100" aria-label={tr("Actions for the folder {name}", { name })}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setNaming({ mode: "rename", box })}>
                <Pencil /> {tr("Rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setNaming({ mode: "new", parent: box })}>
                <FolderPlus /> {tr("New subfolder")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="flex gap-1 px-2 py-1.5" role="group" aria-label={tr("Colour")}>
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={tr("Colour: {value}", { value: COLOR_NAMES[c]!() })}
                    aria-pressed={p.data?.colors[box.id] === c}
                    className={cn("size-5 rounded-full ring-offset-1 ring-offset-popover hover:ring-2 hover:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground", DOT_CLASS[c])}
                    onClick={() => void changeData((d) => ({ ...d, colors: d.colors[box.id] === c ? Object.fromEntries(Object.entries(d.colors).filter(([k]) => k !== box.id)) : { ...d.colors, [box.id]: c } }))}
                  />
                ))}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(box)}>
                <Trash2 /> {tr("Delete folder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  };

  /** Deleting a folder: its mail goes to Archive (it is never deleted with it), and the folder goes. */
  const remove = async (b: Mailbox) => {
    // On a phone the folders are in a sheet: it closes first, the question is asked over the list.
    p.onNavigate?.();
    if (withDescendants(boxes, b.id).length > 1) return toast(tr("“{name}” has subfolders. Delete or move them first.", { name: b.name }), "error");
    const ok = await confirmDialog({
      title: tr("Delete the folder “{name}”?", { name: b.name }),
      message: b.totalEmails ? tr("Its {n} messages are not deleted: they move to Archive.", { n: b.totalEmails }) : tr("The folder is empty."),
      confirmLabel: tr("Delete folder"),
      danger: true,
    });
    if (!ok) return;
    try {
      if (b.totalEmails) {
        const archive = byRole(boxes, "archive") ?? (await ensureArchive(p.account));
        if (!archive) throw new Error(tr("There is no Archive folder to move its messages to."));
        for (;;) {
          const q = await jmap([["Email/query", { accountId: p.account, filter: { inMailbox: b.id }, limit: 200 }, "0"]]);
          const ids = q["0"].ids as string[];
          if (!ids.length) break;
          await jmap([["Email/set", { accountId: p.account, update: Object.fromEntries(ids.map((i) => [i, { [`mailboxIds/${archive.id}`]: true, [`mailboxIds/${b.id}`]: null }])) }, "0"]]);
        }
      }
      const r = await jmap([["Mailbox/set", { accountId: p.account, destroy: [b.id] }, "0"]]);
      const failed = (r["0"].notDestroyed as Record<string, { type?: string; description?: string }> | undefined)?.[b.id];
      if (failed) throw new Error(refusal(failed, tr("The mail server would not delete the folder.")));
      toast(tr("The folder “{name}” was deleted", { name: b.name }));
      p.onGone(b.id);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    p.refetch();
  };

  const held = useScheduled(p.account).data?.length ?? 0;
  const system = systemFolders(boxes);
  const inbox = system.filter((b) => b.role === "inbox");
  const rest = system.filter((b) => b.role !== "inbox");
  const mine = customTree(boxes);
  const snoozed = boxes.find(isSnoozed);
  const saved = p.data?.saved ?? [];
  const removeSaved = (id: string) => void changeData((d) => ({ ...d, saved: d.saved.filter((x) => x.id !== id) }));
  const archiveAt = rest.findIndex((b) => b.role === "archive");
  return (
    <>
      <Button onClick={p.onWrite} title={tr("Write a message (c)")}>
        <Pencil aria-hidden="true" /> {tr("Write")}
      </Button>
      {p.accounts.length > 1 && (
        <ul className="grid gap-0.5 border-b pb-2" aria-label={tr("Mailboxes")}>
          {p.accounts.map(([id, a]) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => p.onAccount(id)}
                aria-current={id === p.account ? "true" : undefined}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent pointer-coarse:min-h-11", id === p.account && "bg-accent font-medium")}
              >
                {a.isPersonal ? <Mail className="size-4 shrink-0" aria-hidden="true" /> : <Users className="size-4 shrink-0" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{isolate(a.name)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <nav className="min-h-0 flex-1 overflow-y-auto" aria-label={tr("Folders of the mailbox")}>
        {p.loading && (
          <div className="grid gap-1" role="status" aria-label={tr("Loading…")}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        )}
        <ul className="grid gap-0.5">
          {inbox.map((b) => link(b.id, b.role, folderName(b), b))}
          {!!boxes.length && link(STARRED, "starred", tr("Starred"))}
          {rest.slice(0, archiveAt < 0 ? rest.length : archiveAt + 1).map((b) => [link(b.id, b.role, folderName(b), b), b.role === "sent" && (held > 0 || p.current === SCHEDULED) && link(SCHEDULED, "scheduled", tr("Scheduled"))])}
          {snoozed && link(snoozed.id, "snoozed", tr("Snoozed"), snoozed)}
          {!!boxes.length && link(ALL_MAIL, "all", tr("All mail"))}
          {archiveAt >= 0 && rest.slice(archiveAt + 1).map((b) => link(b.id, b.role, folderName(b), b))}
        </ul>
        {!!boxes.length && (
          <>
            <div className="mt-3 flex items-center justify-between ps-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{tr("Folders")}</h2>
              {p.canEdit && (
                <Button variant="ghost" size="icon-sm" aria-label={tr("New folder")} title={tr("New folder")} onClick={() => setNaming({ mode: "new", parent: null })}>
                  <FolderPlus />
                </Button>
              )}
            </div>
            <ul className="grid gap-0.5">{mine.map(({ box, depth }) => link(box.id, null, box.name, box, depth))}</ul>
            {!mine.length && <p className="px-2 py-1 text-xs text-muted-foreground">{tr("Your own folders appear here.")}</p>}
            {saved.length > 0 && (
              <>
                <h2 className="mt-3 ps-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{tr("Searches")}</h2>
                <ul className="grid gap-0.5">
                  {saved.map((x) => (
                    <li key={x.id} className="group/folder relative">
                      <Link
                        to={`/mail/${SAVED}${x.id}${p.suffix}`}
                        onClick={p.onNavigate}
                        aria-current={SAVED + x.id === p.current ? "page" : undefined}
                        title={x.query}
                        className={cn("flex items-center gap-2 rounded-md py-1.5 ps-2 pe-8 text-sm hover:bg-accent pointer-coarse:min-h-11", SAVED + x.id === p.current && "bg-accent font-medium")}
                      >
                        <FolderIcon role="saved" className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{isolate(x.name)}</span>
                      </Link>
                      <Button variant="ghost" size="icon-sm" className="absolute end-0.5 top-1/2 size-7 -translate-y-1/2 opacity-0 group-focus-within/folder:opacity-100 group-hover/folder:opacity-100 pointer-coarse:opacity-100" aria-label={tr("Remove the search {name}", { name: x.name })} onClick={() => removeSaved(x.id)}>
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </nav>
      <Storage account={p.account} suffix={p.suffix} onNavigate={p.onNavigate} />
      <Button variant="ghost" size="sm" className="justify-start" onClick={p.onKeys}>
        <Keyboard aria-hidden="true" /> {tr("Keyboard shortcuts")}
      </Button>
      <Button variant="ghost" size="sm" className="justify-start" onClick={p.onSettings}>
        <Settings aria-hidden="true" /> {tr("Mail settings")}
      </Button>
      {naming && <NameDialog account={p.account} boxes={boxes} target={naming} onClose={() => setNaming(null)} done={p.refetch} />}
    </>
  );
}

function NameDialog({ account, boxes, target, onClose, done }: { account: string; boxes: Mailbox[]; target: { mode: "new"; parent: Mailbox | null } | { mode: "rename"; box: Mailbox }; onClose: () => void; done: () => void }) {
  const [name, setName] = useState(target.mode === "rename" ? target.box.name : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const parent = target.mode === "new" ? (target.parent?.id ?? null) : (target.box.parentId ?? null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = folderNameProblem(name, boxes, parent, target.mode === "rename" ? target.box.id : undefined);
    if (bad) return setProblem(bad);
    setBusy(true);
    try {
      const body = target.mode === "new" ? { create: { n: { name: name.trim(), parentId: parent } } } : { update: { [target.box.id]: { name: name.trim() } } };
      const r = await jmap([["Mailbox/set", { accountId: account, ...body }, "0"]]);
      const failed = Object.values(((r["0"].notCreated ?? r["0"].notUpdated) as Record<string, { type?: string; description?: string }> | undefined) ?? {})[0];
      if (failed) throw new Error(refusal(failed, tr("The mail server did not accept that name.")));
      toast(target.mode === "new" ? tr("The folder “{name}” was made", { name: name.trim() }) : tr("Renamed to “{name}”", { name: name.trim() }));
      done();
      onClose();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const title = target.mode === "rename" ? tr("Rename the folder") : target.parent ? tr("New folder in “{name}”", { name: target.parent.name }) : tr("New folder");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{tr("Folders keep mail you want to find again. A conversation lives in one folder.")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="folder-name">{tr("Name")}</Label>
            <Input id="folder-name" autoFocus value={name} onChange={(e) => (setName(e.target.value), setProblem(null))} aria-invalid={!!problem} aria-describedby={problem ? "folder-problem" : undefined} />
            {problem && (
              <p id="folder-problem" role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {target.mode === "rename" ? tr("Rename") : tr("Make folder")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** How full the mailbox is (the mail server's quota), quiet until it nears the limit; and the way to the largest conversations. */
function Storage({ account, suffix, onNavigate }: { account: string; suffix: string; onNavigate?: () => void }) {
  const q = useQuery({
    queryKey: ["mail", "quota", account],
    queryFn: async () => ((await jmap([["Quota/get", { accountId: account, ids: null }, "0"]]))["0"].list as { resourceType: string; used: number; hardLimit: number; scope: string }[]) ?? [],
    staleTime: 10 * 60_000,
    retry: false,
  });
  const octets = q.data?.find((x) => x.resourceType === "octets");
  const share = octets?.hardLimit ? octets.used / octets.hardLimit : 0;
  return (
    <div className="grid gap-1 border-t px-2 pt-2 text-xs text-muted-foreground">
      {octets?.hardLimit ? (
        <>
          <span className={cn(share >= 0.9 && "font-medium text-destructive")}>{tr("{used} of {total} used", { used: sizeLabel(octets.used), total: sizeLabel(octets.hardLimit) })}</span>
          <Progress value={Math.min(100, share * 100)} aria-label={tr("Mailbox storage")} className={cn("h-1.5", share >= 0.9 && "[&>*]:bg-destructive")} />
          {share >= 0.9 && <span>{tr("Almost full: new mail will be refused. Empty Trash and Spam, or delete large conversations.")}</span>}
        </>
      ) : null}
      <Link to={`/mail/${LARGEST}${suffix}`} onClick={onNavigate} className="w-fit rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        {tr("Largest conversations")}
      </Link>
    </div>
  );
}
