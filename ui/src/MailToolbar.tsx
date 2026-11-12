// The buttons that act on mail: one bar used by the selection toolbar over the list and by the open
// conversation, the same bar smaller on a row, and the "Move to" menu (a folder filter in a popover).

import { Archive, CheckSquare, Download, FolderInput, Inbox, MailOpen, Mail as MailClosed, ShieldAlert, ShieldCheck, Star, Tag, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Command, CommandEmpty, CommandInput, CommandItem, CommandList, Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { isolate, t as tr } from "@ferrum/client";
import { cn, type SelectionAction } from "@ferrum/kit";
import { FolderIcon } from "./MailFolders";
import { AlsoFileMenu } from "./MailLabels";
import { offered, type Verb } from "./lib/actions";
import { folderName, moveTargets } from "./lib/folders";
import type { Mailbox } from "./lib/mail";

/** A button that is only an icon: named for readers, with its key in the tooltip. */
export function IconAction({ label, keys, onClick, children, className, danger, pressed }: { label: string; keys?: string; onClick: () => void; children: ReactNode; className?: string; danger?: boolean; pressed?: boolean }) {
  return (
    <Button variant="ghost" size="icon-sm" className={cn(danger && "hover:text-destructive", className)} aria-label={label} aria-pressed={pressed} title={keys ? `${label} (${keys})` : label} onClick={onClick}>
      {children}
    </Button>
  );
}

/** "Move to": the folders with a filter; picking one moves what is selected or open. */
export function MoveMenu({ boxes, current, onPick, open, onOpenChange, small = true, quiet = false }: { boxes: Mailbox[]; current?: string; onPick: (to: Mailbox) => void; open: boolean; onOpenChange: (o: boolean) => void; small?: boolean; quiet?: boolean }) {
  const targets = moveTargets(boxes).filter((t) => t.box.id !== current);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size={small ? "icon-sm" : "sm"} aria-label={tr("Move to")} title={tr("Move to (v)")} className={cn(quiet && "pointer-events-none w-0 overflow-hidden p-0 opacity-0")} tabIndex={quiet ? -1 : undefined} aria-hidden={quiet || undefined}>
          <FolderInput /> {!small && tr("Move to")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={tr("Move to a folder…")} aria-label={tr("Filter the folders")} />
          <CommandList>
            <CommandEmpty>{tr("No folder has that name.")}</CommandEmpty>
            {targets.map(({ box, depth }) => (
              <CommandItem
                key={box.id}
                value={`${folderName(box)} ${box.id}`}
                onSelect={() => {
                  onOpenChange(false);
                  onPick(box);
                }}
                style={{ paddingInlineStart: `${0.5 + depth * 0.875}rem` }}
              >
                <FolderIcon role={box.role} />
                <span className="min-w-0 flex-1 truncate">{isolate(folderName(box))}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface BarProps {
  role: string | null | undefined;
  boxes: Mailbox[];
  /** Any conversation in view is unread (then the button marks read, else unread). */
  anyUnread: boolean;
  allStarred: boolean;
  onVerb: (v: Verb) => void;
  onMove: (to: Mailbox) => void;
  onForever: () => void;
  moveOpen: boolean;
  onMoveOpen: (o: boolean) => void;
  /** Where the folder the mail is in is, so Move to leaves it out. */
  folderId?: string;
  /** More buttons at the end (the open conversation's). */
  children?: ReactNode;
  /** "Select all" (the selection's own list). */
  onSelectAll?: () => void;
  /** "Also file under…" (adds a folder); with its popover's state. */
  onLabel?: (to: Mailbox) => void;
  labelOpen?: boolean;
  onLabelOpen?: (o: boolean) => void;
  /** Save what is selected as an .mbox file. */
  onExport?: () => void;
}

/** One action on mail, as the open conversation's icon bar and the selection's bar (the kit's `SelectionToolbar`) both draw it. */
export interface MailAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** The kit's icon name for the selection's bar, where it has one. */
  kitIcon?: string;
  keys?: string;
  run: () => void;
  danger?: boolean;
  pressed?: boolean;
  /** Kept on the selection's bar when it folds (Archive, Delete). */
  priority?: boolean;
  /** Opens one of the folder popovers (Move to, Also file under): the icon bar draws the popover's own trigger. */
  popover?: "move" | "label";
}

/** Archive, Delete, Spam or Not spam, Mark read or unread, Star, Move to, Also file under, Export; in Trash and Spam also Move to Inbox and Delete forever. */
export function mailActions(p: BarProps): MailAction[] {
  const o = offered(p.role);
  const inbox = p.boxes.find((b) => b.role === "inbox");
  // A popover opens after the menu that asked for it has closed.
  const later = (f: () => void) => () => setTimeout(f);
  const list: (MailAction | false | undefined)[] = [
    o.archive && { id: "archive", label: tr("Archive"), icon: <Archive />, keys: "e", run: () => p.onVerb("archive"), priority: true },
    o.trash && { id: "trash", label: tr("Delete"), icon: <Trash2 />, kitIcon: "trash", keys: "#", run: () => p.onVerb("trash"), priority: true },
    p.role === "trash" && inbox && { id: "inbox", label: tr("Move to Inbox"), icon: <Inbox />, run: () => p.onMove(inbox) },
    o.notSpam && { id: "notSpam", label: tr("Not spam: move to Inbox, and the filter learns"), icon: <ShieldCheck />, keys: "!", run: () => p.onVerb("notSpam") },
    o.spam && { id: "spam", label: tr("Report spam"), icon: <ShieldAlert />, keys: "!", run: () => p.onVerb("spam") },
    o.deleteForever && { id: "forever", label: tr("Delete forever"), icon: <Trash2 className="text-destructive" />, kitIcon: "trash", run: p.onForever, danger: true },
    { id: "read", label: p.anyUnread ? tr("Mark as read") : tr("Mark as unread"), icon: p.anyUnread ? <MailOpen /> : <MailClosed />, kitIcon: "mail", keys: p.anyUnread ? "Shift+I" : "Shift+U", run: () => p.onVerb(p.anyUnread ? "read" : "unread") },
    { id: "star", label: p.allStarred ? tr("Remove the star") : tr("Star"), icon: <Star className={cn(p.allStarred && "fill-warning text-warning")} />, keys: "s", pressed: p.allStarred, run: () => p.onVerb(p.allStarred ? "unstar" : "star") },
    o.move && { id: "move", label: tr("Move to"), icon: <FolderInput />, keys: "v", run: later(() => p.onMoveOpen(true)), popover: "move" },
    p.onLabel && p.onLabelOpen && { id: "label", label: tr("Also file under"), icon: <Tag />, keys: "l", run: later(() => p.onLabelOpen!(true)), popover: "label" },
    p.onExport && { id: "export", label: tr("Export as .mbox"), icon: <Download />, kitIcon: "download", run: p.onExport },
    p.onSelectAll && { id: "all", label: tr("Select all"), icon: <CheckSquare />, kitIcon: "check", run: p.onSelectAll },
  ];
  return list.filter((a): a is MailAction => !!a);
}

/** The selection's actions for the kit's `SelectionToolbar` (`actions`): it keeps what fits and folds the rest into More. */
export const selectionActions = (p: BarProps): SelectionAction[] => mailActions(p).map((a) => ({ id: a.id, label: a.label, icon: a.kitIcon, onSelect: a.run, danger: a.danger, priority: a.priority, title: a.keys ? `${a.label} (${a.keys})` : a.label }));

/** The anchors the folder popovers open from when a bar draws its actions as words (the selection's bar): out of sight and out of the tab order. */
export function FolderPopovers(p: BarProps) {
  const o = offered(p.role);
  return (
    <>
      {o.move && <MoveMenu quiet boxes={p.boxes} current={p.folderId} onPick={p.onMove} open={p.moveOpen} onOpenChange={p.onMoveOpen} />}
      {p.onLabel && p.onLabelOpen && (
        <span className="pointer-events-none w-0 overflow-hidden opacity-0" aria-hidden="true">
          <AlsoFileMenu boxes={p.boxes} inIds={{}} onPick={p.onLabel} open={!!p.labelOpen} onOpenChange={p.onLabelOpen} />
        </span>
      )}
    </>
  );
}

/** The open conversation's actions as icons, each named with its key. */
export function ActionBar(p: BarProps) {
  return (
    <>
      {mailActions(p).map((a) =>
        a.popover === "move" ? (
          <MoveMenu key={a.id} boxes={p.boxes} current={p.folderId} onPick={p.onMove} open={p.moveOpen} onOpenChange={p.onMoveOpen} />
        ) : a.popover === "label" ? (
          <AlsoFileMenu key={a.id} boxes={p.boxes} inIds={{}} onPick={p.onLabel!} open={!!p.labelOpen} onOpenChange={p.onLabelOpen!} />
        ) : (
          <IconAction key={a.id} label={a.label} keys={a.keys} onClick={a.run} danger={a.danger} pressed={a.pressed}>
            {a.icon}
          </IconAction>
        ),
      )}
      {p.children}
    </>
  );
}
