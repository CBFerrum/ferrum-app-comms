// The buttons that act on mail: one bar used by the selection toolbar over the list and by the open
// conversation, the same bar smaller on a row, and the "Move to" menu (a folder filter in a popover).

import { Archive, FolderInput, Inbox, MailOpen, Mail as MailClosed, ShieldAlert, ShieldCheck, Star, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Command, CommandEmpty, CommandInput, CommandItem, CommandList, Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { isolate, t as tr } from "@ferrum/client";
import { cn } from "@ferrum/kit";
import { FolderIcon } from "./MailFolders";
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
export function MoveMenu({ boxes, current, onPick, open, onOpenChange, small = true }: { boxes: Mailbox[]; current?: string; onPick: (to: Mailbox) => void; open: boolean; onOpenChange: (o: boolean) => void; small?: boolean }) {
  const targets = moveTargets(boxes).filter((t) => t.box.id !== current);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size={small ? "icon-sm" : "sm"} aria-label={tr("Move to")} title={tr("Move to (v)")}>
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
}

/** Archive, Delete, Spam or Not spam, Mark read or unread, Star, Move to; in Trash and Spam also Move to Inbox and Delete forever. */
export function ActionBar(p: BarProps) {
  const o = offered(p.role);
  const inbox = p.boxes.find((b) => b.role === "inbox");
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
      {p.children}
    </>
  );
}
