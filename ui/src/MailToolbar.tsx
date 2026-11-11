// The buttons that act on mail: one bar used by the selection toolbar over the list and by the open
// conversation, the same bar smaller on a row, and the "Move to" menu (a folder filter in a popover).

import { Archive, Download, FolderInput, Inbox, MailOpen, Mail as MailClosed, MoreVertical, ShieldAlert, ShieldCheck, Star, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Command, CommandEmpty, CommandInput, CommandItem, CommandList, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { isolate, t as tr } from "@ferrum/client";
import { cn } from "@ferrum/kit";
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
  /** A phone's width: Archive and Delete as buttons, the rest in a menu, so nothing is pushed off the screen. */
  compact?: boolean;
  /** Compact only: "Select all" in the menu. */
  onSelectAll?: () => void;
  /** "Also file under…" (adds a folder); with its popover's state. */
  onLabel?: (to: Mailbox) => void;
  labelOpen?: boolean;
  onLabelOpen?: (o: boolean) => void;
  /** Save what is selected as an .mbox file. */
  onExport?: () => void;
}

/** Archive, Delete, Spam or Not spam, Mark read or unread, Star, Move to; in Trash and Spam also Move to Inbox and Delete forever. */
export function ActionBar(p: BarProps) {
  const o = offered(p.role);
  const inbox = p.boxes.find((b) => b.role === "inbox");
  if (p.compact) {
    const more: { label: string; run: () => void }[] = [
      ...(p.role === "trash" && inbox ? [{ label: tr("Move to Inbox"), run: () => p.onMove(inbox) }] : []),
      ...(o.notSpam ? [{ label: tr("Not spam"), run: () => p.onVerb("notSpam") }] : []),
      ...(o.spam ? [{ label: tr("Report spam"), run: () => p.onVerb("spam") }] : []),
      ...(o.deleteForever ? [{ label: tr("Delete forever"), run: p.onForever }] : []),
      { label: p.anyUnread ? tr("Mark as read") : tr("Mark as unread"), run: () => p.onVerb(p.anyUnread ? "read" : "unread") },
      { label: p.allStarred ? tr("Remove the star") : tr("Star"), run: () => p.onVerb(p.allStarred ? "unstar" : "star") },
      ...(o.move ? [{ label: tr("Move to…"), run: () => setTimeout(() => p.onMoveOpen(true)) }] : []),
      ...(p.onLabel && p.onLabelOpen ? [{ label: tr("Also file under…"), run: () => setTimeout(() => p.onLabelOpen!(true)) }] : []),
      ...(p.onExport ? [{ label: tr("Export as .mbox"), run: p.onExport }] : []),
      ...(p.onSelectAll ? [{ label: tr("Select all"), run: p.onSelectAll }] : []),
    ];
    return (
      <>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={tr("More actions")} title={tr("More actions")}>
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {more.map((m) => (
              <DropdownMenuItem key={m.label} onSelect={m.run}>
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {o.move && <MoveMenu quiet boxes={p.boxes} current={p.folderId} onPick={p.onMove} open={p.moveOpen} onOpenChange={p.onMoveOpen} />}
        {p.onLabel && p.onLabelOpen && (
          <span className="pointer-events-none w-0 overflow-hidden opacity-0" aria-hidden="true">
            <AlsoFileMenu boxes={p.boxes} inIds={{}} onPick={p.onLabel} open={!!p.labelOpen} onOpenChange={p.onLabelOpen} />
          </span>
        )}
        {p.children}
      </>
    );
  }
  return (
    <>
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
      {p.role === "trash" && inbox && (
        <IconAction label={tr("Move to Inbox")} onClick={() => p.onMove(inbox)}>
          <Inbox />
        </IconAction>
      )}
      {o.notSpam && (
        <IconAction label={tr("Not spam: move to Inbox, and the filter learns")} keys="!" onClick={() => p.onVerb("notSpam")}>
          <ShieldCheck />
        </IconAction>
      )}
      {o.spam && (
        <IconAction label={tr("Report spam")} keys="!" onClick={() => p.onVerb("spam")}>
          <ShieldAlert />
        </IconAction>
      )}
      {o.deleteForever && (
        <IconAction label={tr("Delete forever")} onClick={p.onForever} danger>
          <Trash2 className="text-destructive" />
        </IconAction>
      )}
      <IconAction label={p.anyUnread ? tr("Mark as read") : tr("Mark as unread")} keys={p.anyUnread ? "Shift+I" : "Shift+U"} onClick={() => p.onVerb(p.anyUnread ? "read" : "unread")}>
        {p.anyUnread ? <MailOpen /> : <MailClosed />}
      </IconAction>
      <IconAction label={p.allStarred ? tr("Remove the star") : tr("Star")} keys="s" pressed={p.allStarred} onClick={() => p.onVerb(p.allStarred ? "unstar" : "star")}>
        <Star className={cn(p.allStarred && "fill-warning text-warning")} />
      </IconAction>
      {o.move && <MoveMenu boxes={p.boxes} current={p.folderId} onPick={p.onMove} open={p.moveOpen} onOpenChange={p.onMoveOpen} />}
      {p.onLabel && p.onLabelOpen && <AlsoFileMenu boxes={p.boxes} inIds={{}} onPick={p.onLabel} open={!!p.labelOpen} onOpenChange={p.onLabelOpen} />}
      {p.onExport && (
        <IconAction label={tr("Export as .mbox")} onClick={p.onExport}>
          <Download />
        </IconAction>
      )}
      {p.children}
    </>
  );
}
