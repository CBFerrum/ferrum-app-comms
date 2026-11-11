// Mail's data on the server (lib/mailData.ts): read once per mailbox and kept fresh, changed through
// one call that says what failed. The person's settings come from here; what wave 2 kept in the
// browser moves here the first time it is read.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { errorMessage, t as tr } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { dropLegacyWritePrefs, legacyWritePrefs, setServerWritePrefs } from "./lib/compose";
import { setShortcutsOn, type Mailbox } from "./lib/mail";
import { changeMailData, readMailData, type MailState } from "./lib/mailData";
import type { MailData, Prefs } from "./lib/filters";

export const mailDataKey = (account: string) => ["mail", "data", account];

/** The person's choices with the defaults filled in. */
export const DEFAULT_PREFS: Required<Prefs> = { undoSeconds: 10, signatureInReplies: true, replyDefault: "reply", conversations: true, density: "comfortable", pane: "right", shortcuts: true, sendArchive: false, notify: "all" };
export const prefsOf = (d: MailData | undefined): Required<Prefs> => ({ ...DEFAULT_PREFS, ...(d?.prefs ?? {}) });

export function useMailData(account: string, boxes?: Mailbox[]) {
  const q = useQuery({ queryKey: mailDataKey(account), queryFn: () => readMailData(account), retry: false, staleTime: 5 * 60_000 });
  const qc = useQueryClient();
  const data = q.data?.data;
  // Settings that act outside React: writing (the composer reads them when it opens) and the keys.
  useEffect(() => {
    if (!data) return;
    setServerWritePrefs(account, data.prefs);
    setShortcutsOn(data.prefs.shortcuts !== false);
  }, [account, data]);
  // Wave 2 kept undo-send and the signature choice in this browser: they move to the server once.
  useEffect(() => {
    if (!data || !boxes?.length) return;
    const old = legacyWritePrefs(account);
    if (!old) return;
    const move: Prefs = {};
    if (data.prefs.undoSeconds === undefined && typeof old.undoSeconds === "number") move.undoSeconds = old.undoSeconds;
    if (data.prefs.signatureInReplies === undefined && typeof old.signatureInReplies === "boolean") move.signatureInReplies = old.signatureInReplies;
    if (!Object.keys(move).length) return dropLegacyWritePrefs(account);
    void changeMailData(account, boxes, (d) => ({ ...d, prefs: { ...move, ...d.prefs } })).then(
      (s) => {
        dropLegacyWritePrefs(account);
        qc.setQueryData(mailDataKey(account), (old: MailState | undefined) => (old ? { ...old, ...s } : s));
      },
      () => undefined,
    );
  }, [account, boxes, data, qc]);
  return q;
}

/** Changes Mail's data; resolves to whether the server took it (a toast says what failed otherwise). */
export function useChangeMailData(account: string, boxes: Mailbox[]) {
  const qc = useQueryClient();
  return useCallback(
    async (change: (d: MailData) => MailData, opts: { takeOver?: boolean; failed?: string } = {}): Promise<MailState | null> => {
      try {
        const s = await changeMailData(account, boxes, change, opts);
        await qc.invalidateQueries({ queryKey: mailDataKey(account) });
        return s;
      } catch (e) {
        toast(opts.failed ? tr("{what} {e}", { what: opts.failed, e: errorMessage(e) }) : tr("Not saved: {e}", { e: errorMessage(e) }), "error");
        return null;
      }
    },
    [account, boxes, qc],
  );
}
