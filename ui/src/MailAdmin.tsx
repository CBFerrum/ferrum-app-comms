// What a workspace's mail manager sees beside the domain's DNS (Mail settings → Administration):
// * every mailbox with what it holds, and its storage limit, set here (`/domain/mailboxes`);
// * shared mailboxes (sales@, support@): who is in each; members read, file, answer and send as it;
// * a spam summary: how often people marked mail as spam or not spam in the last 30 days;
// * senders the whole workspace allows or blocks (applied by Mail's server as mail arrives);
// * how long Trash and Spam are kept (one setting of the whole mail server: shown, not changed).
// A server from before an endpoint answers 404: that part says it needs a newer version instead of failing.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Progress,
  Skeleton,
  Textarea,
} from "@ferrum/kit/primitives";
import { confirmDialog, toast } from "@ferrum/kit";
import { api, docPath, errorMessage, formatDateTime, isolate, t as tr } from "@ferrum/client";
import { Failure } from "./States";
import { sizeLabel, useMailSession } from "./lib/mail";

const DOMAIN = "/api/app/comms/domain";
const GB = 1024 * 1024 * 1024;
/** The limits offered, in bytes (null: none). */
const LIMITS = [null, 1 * GB, 5 * GB, 10 * GB, 25 * GB, 50 * GB];

interface Row {
  /** The mail server's id for it (servers from before this version send none: no limit is set from here). */
  account?: string | null;
  email: string;
  name: string;
  used: number;
  quota: number | null;
  shared: boolean;
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;

/** A part whose endpoint an older server does not have says so; anything else is a failure with Retry. */
function Trouble({ error, onRetry, title }: { error: unknown; onRetry: () => void; title: string }) {
  if (statusOf(error) === 404) return <p className="text-muted-foreground">{tr("This needs the newer version of the Mail app on this server.")}</p>;
  return <Failure error={error} onRetry={onRetry} title={title} />;
}

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="font-semibold text-foreground">
      {children}
    </h3>
  );
}

export function MailAdmin() {
  return (
    <div className="grid gap-5">
      <Mailboxes />
      <SharedMailboxes />
      <SpamSummary />
      <Senders />
      <Retention />
    </div>
  );
}

function Mailboxes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mail", "admin", "mailboxes"], queryFn: () => api.get<{ mailboxes: Row[] }>(`${DOMAIN}/mailboxes`), retry: false });
  const setLimit = async (m: Row, bytes: number | null) => {
    try {
      await api.put(`${DOMAIN}/mailboxes/${encodeURIComponent(m.account!)}/quota`, { bytes });
      toast(bytes ? tr("{address} may now hold {size}.", { address: m.email, size: sizeLabel(bytes) }) : tr("{address} has no storage limit now.", { address: m.email }));
      void qc.invalidateQueries({ queryKey: ["mail", "admin", "mailboxes"] });
    } catch (e) {
      toast(tr("The limit was not changed: {e}", { e: errorMessage(e) }), "error");
    }
  };
  return (
    <section className="grid gap-2" aria-labelledby="admin-mb">
      <Heading id="admin-mb">{tr("Mailboxes")}</Heading>
      {q.isLoading && <Skeleton className="h-24" />}
      {q.error && <Trouble error={q.error} onRetry={() => void q.refetch()} title={tr("The mailboxes could not be listed")} />}
      {q.data && (
        <ul className="grid gap-1" aria-labelledby="admin-mb">
          {q.data.mailboxes.map((m) => (
            <li key={m.email} className="grid gap-1 rounded-md border px-3 py-2">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 truncate font-medium text-foreground">{isolate(m.email)}</span>
                {m.name && <span className="text-xs">{isolate(m.name)}</span>}
                {m.shared && <Badge variant="secondary">{tr("shared")}</Badge>}
                <span className="ms-auto text-xs tabular-nums">{m.quota ? tr("{used} of {quota}", { used: sizeLabel(m.used), quota: sizeLabel(m.quota) }) : tr("{used}, no limit", { used: sizeLabel(m.used) })}</span>
                {m.account && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="xs" aria-label={tr("Storage limit of {address}", { address: m.email })}>
                        {tr("Limit")}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {LIMITS.map((b) => (
                        <DropdownMenuItem key={String(b)} disabled={b === m.quota || (b !== null && b < m.used)} onSelect={() => void setLimit(m, b)}>
                          {b === null ? tr("No limit") : sizeLabel(b)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
              {m.quota && <Progress value={Math.min(100, (m.used / m.quota) * 100)} aria-label={tr("Storage of {address}", { address: m.email })} />}
            </li>
          ))}
        </ul>
      )}
      {q.data?.mailboxes.some((m) => m.account) && (
        <p className="text-xs text-muted-foreground">{tr("At its limit a mailbox takes no new mail: senders' servers keep trying for a few days, then tell the sender it could not be delivered. Its person can still read and delete mail to make room.")}</p>
      )}
    </section>
  );
}

interface Shared {
  id: string;
  address: string;
  display_name?: string | null;
  members?: { email: string }[];
}

/** Brings the mail server in step at once (Communication Settings' Sync Mailboxes), so access changes now, not at the next round. */
async function syncNow() {
  const s = await api.get<{ rows: { id: string }[] }>(docPath("CommsSettings"));
  const id = s.rows[0]?.id;
  if (id) await api.post(docPath("CommsSettings", id, "actions", "sync_mail"), {});
}

/** The workspace's mail domain, as the signed-in person's own address has it. */
const useDomain = () => useMailSession().data?.username.split("@")[1] ?? "";

function SharedMailboxes() {
  const qc = useQueryClient();
  const domain = useDomain();
  const full = (s: Shared) => (domain ? `${s.address}@${domain}` : s.address);
  const q = useQuery({ queryKey: ["mail", "admin", "shared"], queryFn: () => api.get<{ rows: Shared[] }>(docPath("SharedMailbox")), retry: false });
  const [editing, setEditing] = useState<Shared | "new" | null>(null);
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ["mail", "admin"] });
    void qc.invalidateQueries({ queryKey: ["mail", "session"] });
  };
  const remove = async (s: Shared) => {
    if (!(await confirmDialog({ title: tr("Delete {address}?", { address: full(s) }), message: tr("Its members lose access at once. Its mail stays on the mail server."), confirmLabel: tr("Delete"), danger: true }))) return;
    try {
      await api.del(docPath("SharedMailbox", s.id));
      await syncNow();
      toast(tr("{address} was deleted.", { address: full(s) }));
      changed();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <section className="grid gap-2" aria-labelledby="admin-shared">
      <span className="flex items-center gap-2">
        <Heading id="admin-shared">{tr("Shared mailboxes")}</Heading>
        <Button size="xs" variant="outline" className="ms-auto" onClick={() => setEditing("new")}>
          {tr("New shared mailbox")}
        </Button>
      </span>
      <p className="text-xs text-muted-foreground">{tr("An address several people read and answer, such as sales@. Its members see it in Mail under its own name; they read, file, answer and send as it, and what they send is kept in its Sent.")}</p>
      {q.isLoading && <Skeleton className="h-12" />}
      {q.error && <Trouble error={q.error} onRetry={() => void q.refetch()} title={tr("The shared mailboxes could not be listed")} />}
      {q.data && !q.data.rows.length && <p className="text-muted-foreground">{tr("None yet.")}</p>}
      {q.data && q.data.rows.length > 0 && (
        <ul className="grid gap-1">
          {q.data.rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
              <span className="min-w-0 truncate font-medium text-foreground">{isolate(full(s))}</span>
              {s.display_name && <span className="text-xs">{isolate(s.display_name)}</span>}
              <Button size="xs" variant="outline" className="ms-auto" onClick={() => setEditing(s)}>
                {tr("Members")}
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label={tr("Delete {address}", { address: full(s) })} onClick={() => void remove(s)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <SharedDialog shared={editing === "new" ? null : editing} domain={domain} onClose={() => setEditing(null)} onSaved={changed} />}
    </section>
  );
}

function SharedDialog({ shared, domain, onClose, onSaved }: { shared: Shared | null; domain: string; onClose: () => void; onSaved: () => void }) {
  const full = useQuery({ queryKey: ["mail", "admin", "shared", shared?.id], enabled: !!shared, queryFn: () => api.get<Shared & { version?: number }>(docPath("SharedMailbox", shared!.id)) });
  const [address, setAddress] = useState(shared?.address ?? "");
  const [name, setName] = useState(shared?.display_name ?? "");
  const [members, setMembers] = useState<string | null>(shared ? null : "");
  const [busy, setBusy] = useState(false);
  const shownMembers = members ?? (full.data?.members ?? []).map((m) => m.email).join("\n");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const list = [...new Set(shownMembers.split(/[\s,;]+/).map((m) => m.trim().toLowerCase()).filter(Boolean))].map((email) => ({ email }));
    try {
      if (shared) await api.patch(docPath("SharedMailbox", shared.id), { display_name: name || null, members: list }, full.data?.version !== undefined ? { ifMatch: full.data.version } : undefined);
      else await api.post(docPath("SharedMailbox"), { address, display_name: name || null, members: list });
      await syncNow();
      toast(shared ? tr("Saved. Who has access changed now.") : tr("Made. Its members see it in Mail now."));
      onSaved();
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shared ? tr("Members of {address}", { address: domain ? `${shared.address}@${domain}` : shared.address }) : tr("New shared mailbox")}</DialogTitle>
          <DialogDescription>{tr("Members read, file, answer and send as it. Removing someone takes their access away at once.")}</DialogDescription>
        </DialogHeader>
        <form id="shared-form" className="grid gap-3" onSubmit={(e) => void save(e)}>
          {!shared && (
            <div className="grid gap-1">
              <Label htmlFor="shared-address">{tr("Address (the part before @)")}</Label>
              <Input id="shared-address" value={address} onChange={(e) => setAddress(e.target.value)} required autoComplete="off" dir="ltr" />
            </div>
          )}
          <div className="grid gap-1">
            <Label htmlFor="shared-name">{tr("Name people see")}</Label>
            <Input id="shared-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="shared-members">{tr("Members (their addresses, one per line)")}</Label>
            {shared && full.isLoading ? <Skeleton className="h-20" /> : <Textarea id="shared-members" value={shownMembers} onChange={(e) => setMembers(e.target.value)} rows={4} dir="ltr" />}
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button type="submit" form="shared-form" disabled={busy || (shared !== null && full.isLoading)}>
            {busy ? tr("Saving…") : tr("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpamSummary() {
  const q = useQuery({ queryKey: ["mail", "admin", "spam"], queryFn: () => api.get<{ days: number; spam: number; not_spam: number; mailboxes: { email: string; spam: number; not_spam: number }[] }>(`${DOMAIN}/spam`), retry: false });
  return (
    <section className="grid gap-2" aria-labelledby="admin-spam">
      <Heading id="admin-spam">{tr("Spam in the last 30 days")}</Heading>
      {q.isLoading && <Skeleton className="h-12" />}
      {q.error && <Trouble error={q.error} onRetry={() => void q.refetch()} title={tr("The spam summary could not be read")} />}
      {q.data && (
        <>
          <p>{tr("People marked {spam} messages as spam and {ham} as not spam. The mail server learns from both.", { spam: q.data.spam, ham: q.data.not_spam })}</p>
          {q.data.mailboxes.length > 0 && (
            <ul className="grid gap-0.5 text-xs">
              {q.data.mailboxes.map((m) => (
                <li key={m.email} className="flex gap-2">
                  <span className="min-w-0 truncate">{isolate(m.email)}</span>
                  <span className="ms-auto tabular-nums">{tr("{spam} spam, {ham} not spam", { spam: m.spam, ham: m.not_spam })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{tr("Spam the mail server filed by itself is not counted here; its rules and the lists it checks are managed on the mail server.")}</p>
        </>
      )}
    </section>
  );
}

interface Sender {
  sender: string;
  kind: "allow" | "block";
  added_by: string | null;
  added_at: string;
}

function Senders() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mail", "admin", "senders"], queryFn: () => api.get<{ senders: Sender[] }>(`${DOMAIN}/senders`), retry: false });
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (kind: "allow" | "block") => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ sender: string }>(`${DOMAIN}/senders`, { sender: value, kind });
      toast(kind === "block" ? tr("Mail from {sender} goes to Spam for everyone from now on.", { sender: r.sender }) : tr("Mail from {sender} stays out of Spam for everyone from now on.", { sender: r.sender }));
      setValue("");
      void qc.invalidateQueries({ queryKey: ["mail", "admin", "senders"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s: Sender) => {
    try {
      await api.del(`${DOMAIN}/senders/${encodeURIComponent(s.sender)}`);
      void qc.invalidateQueries({ queryKey: ["mail", "admin", "senders"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const list = (kind: "allow" | "block", label: string) => {
    const rows = (q.data?.senders ?? []).filter((s) => s.kind === kind);
    return (
      <div className="grid gap-1">
        <span className="text-xs font-semibold">{label}</span>
        {rows.length ? (
          <ul className="grid gap-1">
            {rows.map((s) => (
              <li key={s.sender} className="flex flex-wrap items-center gap-x-2 rounded-md border px-3 py-1.5">
                <span className="min-w-0 truncate font-medium text-foreground">{isolate(s.sender)}</span>
                <span className="text-xs text-muted-foreground">{s.added_by ? tr("added by {who}, {when}", { who: s.added_by, when: formatDateTime(s.added_at) }) : formatDateTime(s.added_at)}</span>
                <Button size="icon-xs" variant="ghost" className="ms-auto" aria-label={tr("Remove {sender}", { sender: s.sender })} onClick={() => void remove(s)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{tr("None.")}</p>
        )}
      </div>
    );
  };
  return (
    <section className="grid gap-2" aria-labelledby="admin-senders">
      <Heading id="admin-senders">{tr("Allowed and blocked senders")}</Heading>
      <p className="text-xs text-muted-foreground">{tr("For everyone in the workspace: mail from a blocked sender goes to Spam, mail from an allowed one is taken out of it. An address, or a domain with all its subdomains. Applied as mail arrives, within about a minute.")}</p>
      {q.isLoading && <Skeleton className="h-12" />}
      {q.error && <Trouble error={q.error} onRetry={() => void q.refetch()} title={tr("The lists could not be read")} />}
      {q.data && (
        <>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add("block");
            }}
          >
            <Label htmlFor="admin-sender" className="sr-only">
              {tr("Address or domain")}
            </Label>
            <Input id="admin-sender" className="min-w-0 flex-1 basis-48" placeholder={tr("name@example.com or example.com")} value={value} onChange={(e) => setValue(e.target.value)} dir="ltr" autoComplete="off" />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !value.trim()}>
              {tr("Block")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || !value.trim()} onClick={() => void add("allow")}>
              {tr("Allow")}
            </Button>
          </form>
          {list("block", tr("Blocked"))}
          {list("allow", tr("Allowed"))}
        </>
      )}
    </section>
  );
}

function Retention() {
  const q = useQuery({ queryKey: ["mail", "admin", "retention"], queryFn: () => api.get<{ trash_and_spam_days: number | null; sent_status_days: number | null }>(`${DOMAIN}/retention`), retry: false });
  return (
    <section className="grid gap-1" aria-labelledby="admin-retention">
      <Heading id="admin-retention">{tr("How long mail is kept")}</Heading>
      {q.isLoading && <Skeleton className="h-8" />}
      {q.data ? (
        <p>
          {q.data.trash_and_spam_days
            ? tr("Trash and Spam are emptied after {n} days.", { n: q.data.trash_and_spam_days })
            : tr("Trash and Spam are kept until someone empties them.")}{" "}
          {q.data.sent_status_days ? tr("Whether sent mail was delivered is known for {n} days after sending.", { n: q.data.sent_status_days }) : null}
        </p>
      ) : (
        !q.isLoading && <p>{tr("Trash and Spam are emptied by the mail server after 30 days (its default; this workspace has not changed it).")}</p>
      )}
      <p className="text-xs text-muted-foreground">{tr("This is one setting for the whole mail server, which other workspaces may share: it is changed there by its operator (Data retention in the mail server's administration), not here.")}</p>
    </section>
  );
}
