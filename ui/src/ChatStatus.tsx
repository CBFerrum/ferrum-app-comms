// A person's own status in Chat (an emoji, a short text, until when): a record of theirs, set, changed and cleared
// through the platform's record routes, the same operations an agent uses. Others see it beside their name.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from "@ferrum/kit/primitives";
import { cn, FormSkeleton, toast } from "@ferrum/kit";
import { api, docPath, errorMessage, isolate, newKey, t as tr } from "@ferrum/client";
import { Failure } from "./States";
import { CHAT, REACTIONS, UNTIL_CHOICES, untilFor, type MyStatus, type Status, type UntilChoice } from "./lib/chat";

const statusKey = ["chat", "status"] as const;

/** The emoji of someone's status, its text as the tooltip and accessible description; nothing when there is none. */
export function StatusMark({ status, className }: { status?: Status | null; className?: string }) {
  if (!status || (!status.emoji && !status.text)) return null;
  const said = status.text || status.emoji || "";
  return (
    <span className={cn("shrink-0", className)} title={said} role="img" aria-label={tr("Status: {value}", { value: said })}>
      {isolate(status.emoji || "💬")}
    </span>
  );
}

/** The caller's own status, as a button in the list's header that opens the dialog. */
export function MyStatusButton() {
  const [open, setOpen] = useState(false);
  const mine = useQuery({ queryKey: statusKey, queryFn: ({ signal }) => api.get<{ status: MyStatus | null }>(`${CHAT}/status`, undefined, signal) });
  const s = mine.data?.status;
  return (
    <>
      <Button variant="ghost" size="sm" className="max-w-40 justify-start truncate text-muted-foreground" onClick={() => setOpen(true)} aria-label={tr("Your status")}>
        {s && (s.emoji || s.text) ? (
          <>
            {s.emoji && <span aria-hidden="true">{isolate(s.emoji)}</span>}
            <span className="truncate">{isolate(s.text || "")}</span>
          </>
        ) : (
          tr("Set a status")
        )}
      </Button>
      {open && <StatusDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function StatusDialog({ onClose }: { onClose: () => void }) {
  const mine = useQuery({ queryKey: statusKey, queryFn: ({ signal }) => api.get<{ status: MyStatus | null }>(`${CHAT}/status`, undefined, signal) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("Your status")}</DialogTitle>
          <DialogDescription>{tr("Everyone who chats with you sees it beside your name.")}</DialogDescription>
        </DialogHeader>
        {mine.error ? (
          <Failure error={mine.error} onRetry={() => void mine.refetch()} />
        ) : !mine.data ? (
          <FormSkeleton fields={3} />
        ) : (
          <StatusForm status={mine.data.status} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusForm({ status, onClose }: { status: MyStatus | null; onClose: () => void }) {
  const qc = useQueryClient();
  const ids = useId();
  const [emoji, setEmoji] = useState(status?.emoji ?? "");
  const [text, setText] = useState(status?.text ?? "");
  const [clear, setClear] = useState<UntilChoice>("never");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const done = async (word: string) => {
    await qc.invalidateQueries({ queryKey: ["chat"] });
    toast(word);
    onClose();
  };
  const latest = async () => (await api.get<{ status: MyStatus | null }>(`${CHAT}/status`)).status;
  const save = async () => {
    const values = { emoji: emoji || null, text: text.trim() || null, until: untilFor(clear, new Date()) };
    setBusy(true);
    setProblem(null);
    try {
      let current = status;
      if (!current) {
        try {
          await api.post(docPath("ChatStatus"), values, { idempotencyKey: newKey() });
          return await done(tr("Status set"));
        } catch (e) {
          // Another tab made it a moment ago: change that one instead.
          if ((e as { status?: number }).status !== 409) throw e;
          current = await latest();
          if (!current) throw e;
        }
      }
      await api.patch(docPath("ChatStatus", current.id), values, { ifMatch: current.version });
      await done(tr("Status set"));
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        // Changed elsewhere: show the newer one.
        void qc.invalidateQueries({ queryKey: statusKey });
        setProblem(tr("Your status was changed elsewhere; this is the newer one."));
      } else setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!status) return onClose();
    setBusy(true);
    try {
      await api.del(docPath("ChatStatus", status.id));
      await done(tr("Status cleared"));
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3 text-sm">
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 font-medium">{tr("Emoji")}</legend>
        <div className="grid grid-cols-8 gap-1">
          {REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              aria-pressed={emoji === e}
              aria-label={e}
              className={cn("rounded-md border p-1 text-base hover:bg-muted pointer-coarse:min-h-11", emoji === e && "border-primary bg-primary-soft")}
              onClick={() => setEmoji(emoji === e ? "" : e)}
            >
              {e}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-text`}>{tr("What you are up to")}</Label>
        <Input id={`${ids}-text`} maxLength={100} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr("In a meeting")} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-clear`}>{tr("Clear after")}</Label>
        <select id={`${ids}-clear`} className="h-(--control-h) rounded-md border border-input bg-card px-2" value={clear} onChange={(e) => setClear(e.target.value as UntilChoice)}>
          {UNTIL_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {isolate(problem)}
        </p>
      )}
      <DialogFooter>
        {status && (
          <Button variant="outline" disabled={busy} onClick={() => void remove()}>
            {tr("Clear status")}
          </Button>
        )}
        <Button disabled={busy || (!emoji && !text.trim())} onClick={() => void save()}>
          {busy ? tr("Saving…") : tr("Save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
