// Scheduled: the messages the mail server holds until their time (Schedule send). They are pending
// submissions, not a folder: listed from EmailSubmission/query, each with its time on the person's
// clock. Editing one calls it back to Drafts and opens it; cancelling calls it back to Drafts.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Menu, Pencil, X } from "lucide-react";
import { Button } from "@ferrum/kit/primitives";
import { cn, ListSkeleton, StatePanel, toast } from "@ferrum/kit";
import { errorMessage, formatMoment, isolate, t } from "@ferrum/client";
import { Failure } from "./States";
import { callBack, loadDraft } from "./MailCompose";
import { addressList, byRole, jmap, type Address, type Draft, type Mailbox } from "./lib/mail";

export interface Held {
  submission: string;
  emailId: string;
  sendAt: string;
  subject: string | null;
  to: Address[] | null;
  preview: string;
}

/** Messages waiting to be sent, soonest first (a minute's polling keeps the folder's count true). */
export function useScheduled(account: string) {
  return useQuery({
    queryKey: ["mail", "scheduled", account],
    refetchInterval: 60_000,
    retry: false,
    queryFn: async (): Promise<Held[]> => {
      const r = await jmap([
        ["EmailSubmission/query", { accountId: account, filter: { undoStatus: "pending" }, limit: 200 }, "q"],
        ["EmailSubmission/get", { accountId: account, "#ids": { resultOf: "q", name: "EmailSubmission/query", path: "/ids" }, properties: ["emailId", "sendAt", "undoStatus"] }, "s"],
        ["Email/get", { accountId: account, "#ids": { resultOf: "s", name: "EmailSubmission/get", path: "/list/*/emailId" }, properties: ["subject", "to", "preview"] }, "e"],
      ]);
      const mails = new Map((r.e.list as { id: string; subject: string | null; to: Address[] | null; preview: string }[]).map((m) => [m.id, m]));
      // A hold of a few seconds is Undo send, not a schedule: left out.
      const soon = Date.now() + 40_000;
      return (r.s.list as { id: string; emailId: string; sendAt: string; undoStatus: string }[])
        .filter((s) => s.undoStatus === "pending" && Date.parse(s.sendAt) > soon && mails.has(s.emailId))
        .map((s) => ({ submission: s.id, emailId: s.emailId, sendAt: s.sendAt, subject: mails.get(s.emailId)!.subject, to: mails.get(s.emailId)!.to, preview: mails.get(s.emailId)!.preview }))
        .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
    },
  });
}

export function ScheduledList({ account, boxes, onFolders, open }: { account: string; boxes: Mailbox[]; onFolders: () => void; open: (d: Draft) => void }) {
  const qc = useQueryClient();
  const list = useScheduled(account);
  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
  const act = async (h: Held, edit: boolean) => {
    try {
      const drafts = byRole(boxes, "drafts");
      if (!drafts) throw new Error(t("The mailbox has no Drafts folder."));
      await callBack(account, drafts.id, h.submission, h.emailId);
      if (edit) open(await loadDraft(account, h.emailId));
      else toast(t("Not sent: the message is back in Drafts."));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      void refresh();
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t("Folders")} onClick={onFolders}>
          <Menu />
        </Button>
        <h2 className="text-sm font-semibold">{t("Scheduled")}</h2>
        <span className="text-xs text-muted-foreground">{t("Held by the mail server until their time, whether or not this page is open.")}</span>
      </div>
      {list.error ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <ListSkeleton rows={4} />
      ) : !list.data.length ? (
        <StatePanel kind="empty" className="h-full" title={t("Nothing scheduled")}>
          {t("Use the arrow beside Send to send a message later.")}
        </StatePanel>
      ) : (
        <ul className="min-h-0 overflow-y-auto" aria-label={t("Scheduled messages")}>
          {list.data.map((h) => (
            <li key={h.submission} className={cn("grid gap-1 border-b px-3 py-2")}>
              <div className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{isolate(addressList(h.to) || t("(no recipients)"))}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
                  <CalendarClock className="size-3.5" aria-hidden="true" />
                  {isolate(formatMoment(h.sendAt, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}
                </span>
              </div>
              <div className="truncate text-sm">{isolate(h.subject || t("(no subject)"))}</div>
              <div className="truncate text-xs text-muted-foreground">{isolate(h.preview)}</div>
              <div className="flex gap-1">
                <Button size="xs" variant="outline" onClick={() => void act(h, true)}>
                  <Pencil aria-hidden="true" /> {t("Edit")}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => void act(h, false)}>
                  <X aria-hidden="true" /> {t("Cancel send")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
