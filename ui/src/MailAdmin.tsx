// What a workspace's mail manager sees beside the domain's DNS: every mailbox with what it holds and
// its quota, largest first (`GET /domain/mailboxes`, from the mail server's administration API).
// A server from before this endpoint answers 404: the panel says so instead of failing.

import { useQuery } from "@tanstack/react-query";
import { Progress, Skeleton } from "@ferrum/kit/primitives";
import { api, isolate, t as tr } from "@ferrum/client";
import { Failure } from "./States";
import { sizeLabel } from "./lib/mail";

interface Row {
  email: string;
  name: string;
  used: number;
  quota: number | null;
  shared: boolean;
}

export function MailAdmin() {
  const q = useQuery({ queryKey: ["mail", "admin", "mailboxes"], queryFn: () => api.get<{ mailboxes: Row[] }>("/api/app/comms/domain/mailboxes"), retry: false });
  const status = (q.error as { status?: number } | null)?.status;
  return (
    <section className="grid gap-2 pt-3" aria-labelledby="admin-mb">
      <h3 id="admin-mb" className="font-semibold text-foreground">
        {tr("Mailboxes")}
      </h3>
      {q.isLoading && <Skeleton className="h-24" />}
      {status === 404 ? (
        <p className="text-muted-foreground">{tr("This server's Mail cannot list mailboxes yet: it needs the newer version of the Mail app.")}</p>
      ) : q.error ? (
        <Failure error={q.error} onRetry={() => void q.refetch()} title={tr("The mailboxes could not be listed")} />
      ) : null}
      {q.data && (
        <ul className="grid gap-1" aria-labelledby="admin-mb">
          {q.data.mailboxes.map((m) => (
            <li key={m.email} className="grid gap-1 rounded-md border px-3 py-2">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 truncate font-medium text-foreground">{isolate(m.email)}</span>
                {m.name && <span className="text-xs">{isolate(m.name)}</span>}
                {m.shared && <span className="text-xs">{tr("shared")}</span>}
                <span className="ms-auto text-xs tabular-nums">{m.quota ? tr("{used} of {quota}", { used: sizeLabel(m.used), quota: sizeLabel(m.quota) }) : tr("{used}, no limit", { used: sizeLabel(m.used) })}</span>
              </span>
              {m.quota && <Progress value={Math.min(100, (m.used / m.quota) * 100)} aria-label={tr("Storage of {address}", { address: m.email })} />}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs">{tr("Trash and Spam are emptied by the mail server after 30 days (its default; this workspace has not changed it).")}</p>
    </section>
  );
}
