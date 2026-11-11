// The one way mail is changed: a key, a row's button, the selection toolbar and the open conversation
// all call `run`. It reads what the messages were, sends the patch, and offers Undo (a toast for 8
// seconds, `z` too) that puts exactly those folders and keywords back. Nothing is shown as done before
// the mail server has taken it.

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@ferrum/kit/primitives";
import { errorMessage, t as tr } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { doneLine, patchFor, restoreUpdates, updatesFor, type Snapshot, type Verb } from "./lib/actions";
import { folderName } from "./lib/folders";
import { byRole, jmap, refusal, type Mailbox } from "./lib/mail";

interface Item {
  id: number;
  label: string;
  undo: () => Promise<void>;
}

interface Undoer {
  push: (label: string, undo: () => Promise<void>) => void;
  undo: () => void;
  /** Whether there is something to undo (for the help and the toolbar). */
  pending: boolean;
}

const UndoContext = createContext<Undoer | null>(null);

/** Keeps the last action's undo and shows it; Mail sits inside it. */
export function UndoProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<Item | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const qc = useQueryClient();
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setItem(null);
  }, []);
  const push = useCallback((label: string, undo: () => Promise<void>) => {
    clearTimeout(timer.current);
    const id = ++seq.current;
    setItem({ id, label, undo });
    timer.current = setTimeout(() => setItem((cur) => (cur?.id === id ? null : cur)), 8000);
  }, []);
  const current = useRef<Item | null>(null);
  current.current = item;
  const undo = useCallback(() => {
    const it = current.current;
    if (!it) return;
    clear();
    it.undo().then(
      () => toast(tr("Undone")),
      (e: unknown) => toast(tr("Could not undo: {e}", { e: errorMessage(e) }), "error"),
    ).finally(() => void qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" }));
  }, [clear, qc]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => ({ push, undo, pending: !!item }), [push, undo, item]);
  return (
    <UndoContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center max-[720px]:bottom-24" role="status" aria-live="polite">
        {item && (
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border bg-popover py-1.5 ps-3 pe-1.5 text-sm text-popover-foreground shadow-(--shadow)">
            <span className="min-w-0 truncate">{item.label}</span>
            <Button size="sm" variant="ghost" className="font-semibold text-primary" onClick={undo} title={tr("Undo (z)")}>
              {tr("Undo")}
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={tr("Dismiss notification")} onClick={clear}>
              <X />
            </Button>
          </div>
        )}
      </div>
    </UndoContext.Provider>
  );
}

export function useUndo(): Undoer {
  const u = useContext(UndoContext);
  if (!u) throw new Error("UndoProvider is missing");
  return u;
}

type Update = Record<string, unknown>;

/** Email/set updates, failing with the server's own reason when any message is refused. */
async function setEmails(account: string, update: Record<string, Update>): Promise<void> {
  const ids = Object.keys(update);
  for (let i = 0; i < ids.length; i += 200) {
    const r = await jmap([["Email/set", { accountId: account, update: Object.fromEntries(ids.slice(i, i + 200).map((k) => [k, update[k]])) }, "0"]]);
    const failed = Object.values((r["0"].notUpdated as Record<string, { type?: string; description?: string }> | undefined) ?? {})[0];
    if (failed) throw new Error(refusal(failed, tr("The mail server refused the change.")));
  }
}

/** The folders and keywords of messages as they are now. */
async function snapshot(account: string, ids: string[]): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await jmap([["Email/get", { accountId: account, ids: ids.slice(i, i + 200), properties: ["mailboxIds", "keywords"] }, "0"]]);
    out.push(...(r["0"].list as Snapshot[]));
  }
  return out;
}

const guarded = new Set<string>();

/**
 * An Archive folder for the account when it has none (a fresh mailbox from the mail server has Inbox,
 * Drafts, Sent, Spam and Trash): created on the first look, so Archive is there for everyone. Resolves
 * to the new folder, or null when it could not be made (a shared mailbox the person may not add to).
 */
export async function ensureArchive(account: string): Promise<Mailbox | null> {
  try {
    const r = await jmap([["Mailbox/set", { accountId: account, create: { a: { name: "Archive", role: "archive" } } }, "0"]]);
    const made = (r["0"].created as Record<string, { id: string }> | undefined)?.a;
    return made ? { id: made.id, name: "Archive", role: "archive", sortOrder: 0, totalEmails: 0, unreadEmails: 0 } : null;
  } catch {
    return null;
  }
}

/** Looks once per account and session: creates Archive when the account has no folder with that role. */
export function useEnsureArchive(account: string, boxes: Mailbox[] | undefined, mayCreate: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!boxes || !mayCreate || byRole(boxes, "archive") || guarded.has(account)) return;
    guarded.add(account);
    void ensureArchive(account).then((b) => b && qc.invalidateQueries({ queryKey: ["mail", "mailboxes", account] }));
  }, [account, boxes, mayCreate, qc]);
}

export interface Run {
  verb: Verb;
  /** Every message the action reaches. */
  ids: string[];
  /** How many conversations that is (what the sentence says). */
  count: number;
  /** The folder a move goes to. */
  to?: Mailbox;
  /** The role of the folder it is done from. */
  from?: string | null;
}

export function useMailActions(account: string, boxes: Mailbox[]) {
  const qc = useQueryClient();
  const undo = useUndo();
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" }), [qc]);

  /** Does the action; true when the mail server took it. */
  const run = useCallback(
    async (r: Run): Promise<boolean> => {
      if (!r.ids.length) return false;
      try {
        let known = boxes;
        if (r.verb === "archive" && !byRole(boxes, "archive")) {
          const made = await ensureArchive(account);
          if (!made) throw new Error(tr("This mailbox has no Archive folder and one could not be made."));
          known = [...boxes, made];
        }
        const patch = patchFor(r.verb, known, r.to, r.from);
        if (!patch) throw new Error(tr("This mailbox has no such folder."));
        const before = await snapshot(account, r.ids);
        await setEmails(account, updatesFor(r.ids, patch));
        undo.push(doneLine(r.verb, r.count, r.to ? folderName(r.to) : ""), () => setEmails(account, restoreUpdates(before)));
        void refresh();
        return true;
      } catch (e) {
        toast(errorMessage(e), "error");
        void refresh();
        return false;
      }
    },
    [account, boxes, undo, refresh],
  );

  /** Removes messages for good (the caller has asked the person, naming what and how many). */
  const destroy = useCallback(
    async (ids: string[]): Promise<boolean> => {
      try {
        for (let i = 0; i < ids.length; i += 200) await jmap([["Email/set", { accountId: account, destroy: ids.slice(i, i + 200) }, "0"]]);
        toast(ids.length === 1 ? tr("1 message deleted for good") : tr("{n} messages deleted for good", { n: ids.length }));
        return true;
      } catch (e) {
        toast(errorMessage(e), "error");
        return false;
      } finally {
        void refresh();
      }
    },
    [account, refresh],
  );

  /** Every message of a folder, for "Empty Trash" and "Empty Spam". */
  const idsIn = useCallback(async (mailbox: string): Promise<string[]> => {
    const out: string[] = [];
    for (;;) {
      const r = await jmap([["Email/query", { accountId: account, filter: { inMailbox: mailbox }, limit: 500, position: out.length }, "0"]]);
      const ids = r["0"].ids as string[];
      out.push(...ids);
      if (ids.length < 500) return out;
    }
  }, [account]);

  return { run, destroy, idsIn, refresh, undo };
}
