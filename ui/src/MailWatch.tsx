// New mail while Mail is open: the mailbox's state is asked every 8 seconds in front (30 behind);
// when it moved, the lists and counts are asked again at once, and new Inbox mail is announced (an
// in-app notice with Open, a desktop notification when the person allowed them and the page is
// behind). Snoozed mail whose time came goes back to the Inbox, unread. Without the state (an old
// server) nothing here runs and the minute's refresh of the lists still holds.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { t as tr } from "@ferrum/client";
import { toast } from "@ferrum/kit";
import { SNOOZED_NAME } from "./lib/folders";
import { byRole, jmap, type Mailbox } from "./lib/mail";
import { WATCH_HIDDEN_MS, WATCH_VISIBLE_MS, notificationText, notifying, wakeKeys, wakeOf, type Arrived } from "./lib/watch";

export function useMailWatch(o: { account: string; boxes: Mailbox[] | undefined; own: string[]; notify: "all" | "people" | "none"; open: (folder: string, id?: string) => void; enabled: boolean }) {
  const qc = useQueryClient();
  const latest = useRef(o);
  latest.current = o;
  useEffect(() => {
    if (!o.enabled) return;
    let state: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const known = new Map<string, boolean>();
    const wroteTo = async (account: string, email: string, sent?: string) => {
      if (!sent || !email) return false;
      if (!known.has(email)) {
        const r = await jmap([["Email/query", { accountId: account, filter: { inMailbox: sent, to: email }, limit: 1 }, "0"]]).catch(() => null);
        known.set(email, !!(r?.["0"].ids as string[] | undefined)?.length);
      }
      return known.get(email)!;
    };
    const tick = async () => {
      const { account, boxes, own, notify } = latest.current;
      try {
        const r = await jmap([["Email/get", { accountId: account, ids: [], properties: ["id"] }, "0"]]);
        const now = String(r["0"].state ?? "");
        if (state && now && now !== state) {
          const c = await jmap([
            ["Email/changes", { accountId: account, sinceState: state, maxChanges: 200 }, "c"],
            ["Email/get", { accountId: account, "#ids": { resultOf: "c", name: "Email/changes", path: "/created" }, properties: ["threadId", "mailboxIds", "keywords", "from", "subject"] }, "g"],
          ]).catch(() => null);
          void qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => !["session", "data", "message", "extras"].includes(String(q.queryKey[1])) });
          const arrived = (c?.g.list as Arrived[] | undefined) ?? [];
          if (arrived.length && boxes) {
            const sent = byRole(boxes, "sent")?.id;
            const people = new Set<string>();
            if (notify === "people") for (const m of arrived) if (m.from?.[0]?.email && (await wroteTo(account, m.from[0].email.toLowerCase(), sent))) people.add(m.from[0].email.toLowerCase());
            const news = notifying(arrived, byRole(boxes, "inbox")?.id, own, notify, (e) => people.has(e));
            if (news.length) announce(news, byRole(boxes, "inbox")!.id);
          }
        }
        if (now) state = now;
      } catch {
        // Asked again next time; the lists keep their own refresh.
      }
      if (!stopped) timer = setTimeout(() => void tick(), document.hidden ? WATCH_HIDDEN_MS : WATCH_VISIBLE_MS);
    };
    const announce = (news: Arrived[], inbox: string) => {
      const { title, body } = notificationText(news);
      const open = () => latest.current.open(inbox, news.length === 1 ? news[0]!.id : undefined);
      toast(`${title}: ${body}`, "info", { action: { label: tr("Open"), onSelect: open }, duration: 8000 });
      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const n = new Notification(title, { body, tag: "ferrum-mail", lang: document.documentElement.lang || undefined });
        n.onclick = () => {
          window.focus();
          open();
          n.close();
        };
      }
    };
    // Back in front: look at once.
    const visible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", visible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [o.enabled, o.account, qc]);
}

/** Snoozed conversations whose time came go back to the Inbox, unread: looked at when Mail opens and every minute while it is open. */
export function useSnoozeWake(account: string, boxes: Mailbox[] | undefined, enabled: boolean) {
  const qc = useQueryClient();
  const snoozed = boxes?.find((b) => !b.role && !b.parentId && b.name === SNOOZED_NAME);
  const inbox = byRole(boxes, "inbox")?.id;
  useEffect(() => {
    if (!enabled || !snoozed || !inbox || !snoozed.totalEmails) return;
    const wake = async () => {
      const r = await jmap([
        ["Email/query", { accountId: account, filter: { inMailbox: snoozed.id }, limit: 500 }, "q"],
        ["Email/get", { accountId: account, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["keywords"] }, "g"],
      ]).catch(() => null);
      const due = ((r?.g.list as { id: string; keywords: Record<string, boolean> | null }[] | undefined) ?? []).filter((m) => (wakeOf(m.keywords)?.getTime() ?? 0) <= Date.now());
      if (!due.length) return;
      const update = Object.fromEntries(
        due.map((m) => [m.id, { [`mailboxIds/${snoozed.id}`]: null, [`mailboxIds/${inbox}`]: true, "keywords/$seen": null, ...Object.fromEntries(wakeKeys(m.keywords).map((k) => [`keywords/${k}`, null])) }]),
      );
      await jmap([["Email/set", { accountId: account, update }, "0"]]).catch(() => null);
      void qc.invalidateQueries({ queryKey: ["mail"], predicate: (q) => q.queryKey[1] !== "session" });
    };
    void wake();
    const t = setInterval(() => void wake(), 60_000);
    return () => clearInterval(t);
  }, [account, enabled, snoozed?.id, snoozed?.totalEmails, inbox, qc]);
}
