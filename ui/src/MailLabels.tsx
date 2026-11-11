// Several folders on one conversation, the way Gmail's labels work: a message can be in more than one
// mailbox (JMAP mailboxIds), so "Also file under…" adds a folder without taking it out of the one it
// is in, the folders it is in show as small chips (on the row, and removable in the reader), and the
// person's own folders can take a colour from the kit's tones (kept with Mail's data on the server).

import { Tag, X } from "lucide-react";
import { Button, Command, CommandEmpty, CommandInput, CommandItem, CommandList, Popover, PopoverContent, PopoverTrigger } from "@ferrum/kit/primitives";
import { isolate, t as tr } from "@ferrum/client";
import { cn } from "@ferrum/kit";
import { FolderIcon } from "./MailFolders";
import { folderName, moveTargets } from "./lib/folders";
import type { Mailbox } from "./lib/mail";

/** A colour name's classes (tokens only). */
export const COLOR_CLASS: Record<string, string> = {
  primary: "bg-primary-soft text-primary border-primary/30",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-foreground border-warning/40",
  destructive: "bg-destructive-soft text-destructive border-destructive/30",
  purple: "bg-purple-soft text-purple border-purple/30",
  muted: "bg-muted text-muted-foreground border-border",
};
export const DOT_CLASS: Record<string, string> = { primary: "bg-primary", success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", purple: "bg-purple", muted: "bg-muted-foreground" };

/** The folders a conversation shows as chips: the person's own (and Inbox/Archive seen from elsewhere), not the one it is listed in. */
export function chipFolders(mailboxIds: Record<string, boolean> | null | undefined, boxes: Mailbox[], hide?: string): Mailbox[] {
  return boxes.filter((b) => mailboxIds?.[b.id] && b.id !== hide && (!b.role || b.role === "inbox"));
}

export function FolderChips({ mailboxIds, boxes, hide, colors, onRemove }: { mailboxIds: Record<string, boolean> | null | undefined; boxes: Mailbox[]; hide?: string; colors: Record<string, string>; onRemove?: (b: Mailbox) => void }) {
  const list = chipFolders(mailboxIds, boxes, hide);
  if (!list.length) return null;
  return (
    <>
      {list.map((b) => (
        <span key={b.id} className={cn("inline-flex h-5 max-w-32 shrink-0 items-center gap-0.5 rounded border px-1.5 text-xs leading-none", COLOR_CLASS[colors[b.id] ?? "muted"])}>
          <span className="truncate">{isolate(folderName(b))}</span>
          {onRemove && (
            <button type="button" className="-me-1 grid size-4 place-items-center rounded-sm hover:bg-accent" aria-label={tr("Take it out of {folder}", { folder: folderName(b) })} onClick={() => onRemove(b)}>
              <X className="size-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
    </>
  );
}

/** "Also file under…": a folder picker that adds, never moves (key `l`, as Gmail's label). */
export function AlsoFileMenu({ boxes, inIds, onPick, open, onOpenChange }: { boxes: Mailbox[]; inIds: Record<string, boolean>; onPick: (b: Mailbox) => void; open: boolean; onOpenChange: (o: boolean) => void }) {
  const targets = moveTargets(boxes).filter((t) => !inIds[t.box.id] && !["junk", "trash", "drafts", "sent"].includes(t.box.role ?? ""));
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={tr("Also file under")} title={tr("Also file under… (l)")}>
          <Tag />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={tr("Also file under…")} aria-label={tr("Filter the folders")} />
          <CommandList>
            <CommandEmpty>{tr("No folder has that name.")}</CommandEmpty>
            {targets.map(({ box, depth }) => (
              <CommandItem key={box.id} value={`${folderName(box)} ${box.id}`} onSelect={() => (onOpenChange(false), onPick(box))} style={{ paddingInlineStart: `${0.5 + depth * 0.875}rem` }}>
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
