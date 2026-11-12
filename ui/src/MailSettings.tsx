// Mail settings: writing (Undo send, signatures per address, templates), the vacation reply, and the app passwords mail programs (Outlook, Apple Mail,
// Thunderbird, phones) sign in with. For managers there is a way on to the domain's health.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { Input } from "@ferrum/kit/primitives";
import { Label } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ferrum/kit/primitives";
import { Textarea } from "@ferrum/kit/primitives";
import { errorMessage, formatDateTime, fromZonedInput, t, isolate, toZonedInput } from "@ferrum/client";
import { can, useMetaIndex } from "@ferrum/records";
import { confirmDialog, FormSkeleton, toast, placed } from "@ferrum/kit";
import { Failure } from "./States";
import { readBlocked, writeBlocked } from "./lib/blocklist";
import { jmap, refusal, useServerDoes, type Mailbox } from "./lib/mail";
import { fromEditor, htmlToText, UNDO_CHOICES } from "./lib/compose";
import { afterVacation, vacationOn } from "./lib/mailData";
import type { Prefs } from "./lib/filters";
import { prefsOf, useChangeMailData, useMailData } from "./MailData";
import { FiltersSettings } from "./MailFilters";
import { MailTransfer } from "./MailTransfer";
import { MailAdmin } from "./MailAdmin";
import { signatureOf, useIdentities, useTemplates } from "./MailCompose";
import type { EditorHandle } from "./MailEditor";

const MailEditor = lazy(() => import("./MailEditor"));

interface Vacation {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string | null;
  textBody: string | null;
}

interface AppPassword {
  id: string;
  description: string;
  createdAt?: string;
}

export function MailSettings({ account, me, servers, boxes, own, tab, folder, onClose }: { account: string; me: string; servers?: { imap: string; smtp: string }; boxes: Mailbox[]; own: string[]; tab?: string; folder?: Mailbox; onClose: () => void }) {
  // Whoever manages Communication Settings can check the domain's records.
  const settings = useMetaIndex().data?.entities.find((e) => e.name === "CommsSettings");
  const manages = !!settings && can(settings.permissions, "write");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{t("Mail settings")}</DialogTitle>
          <DialogDescription>{isolate(me)}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={tab ?? "general"} className="min-w-0">
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="general">{t("General")}</TabsTrigger>
            <TabsTrigger value="writing">{t("Writing")}</TabsTrigger>
            <TabsTrigger value="filters">{t("Filters")}</TabsTrigger>
            <TabsTrigger value="vacation">{t("Vacation reply")}</TabsTrigger>
            <TabsTrigger value="blocked">{t("Blocked senders")}</TabsTrigger>
            <TabsTrigger value="transfer">{t("Import and export")}</TabsTrigger>
            <TabsTrigger value="apps">{t("Mail programs")}</TabsTrigger>
            {manages && <TabsTrigger value="domain">{t("Administration")}</TabsTrigger>}
          </TabsList>
          <TabsContent value="general">
            <GeneralSettings account={account} boxes={boxes} />
          </TabsContent>
          <TabsContent value="filters">
            <FiltersSettings account={account} boxes={boxes} own={own} />
          </TabsContent>
          <TabsContent value="transfer">
            <MailTransfer account={account} boxes={boxes} folder={folder} />
          </TabsContent>
          <TabsContent value="writing">
            <WritingSettings account={account} boxes={boxes} />
          </TabsContent>
          <TabsContent value="vacation">
            <VacationForm account={account} boxes={boxes} />
          </TabsContent>
          <TabsContent value="blocked">
            <BlockedSenders account={account} boxes={boxes} />
          </TabsContent>
          <TabsContent value="apps">
            <AppPasswords account={account} me={me} servers={servers} />
          </TabsContent>
          {manages && (
            <TabsContent value="domain">
              <div className="grid gap-3 pt-2 text-sm">
                <p className="text-muted-foreground">
                  {t("Mail from your domain lands in spam unless its DNS records are published. See which are set up, which are missing, and exactly what to add.")}
                </p>
                <Button asChild className="justify-self-start" onClick={onClose}>
                  <Link to="/mail/domain">{t("Check the mail domain")}</Link>
                </Button>
                <MailAdmin />
              </div>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** How Mail looks and behaves for the person: kept on the mail server with the rest of Mail's data. */
function GeneralSettings({ account, boxes }: { account: string; boxes: Mailbox[] }) {
  const data = useMailData(account, boxes).data?.data;
  const prefs = prefsOf(data);
  const change = useChangeMailData(account, boxes);
  const set = (p: Prefs) => void change((d) => ({ ...d, prefs: { ...d.prefs, ...p } }));
  const [permission, setPermission] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  const serverNotifies = useServerDoes("arrivals");
  const choice = <K extends keyof Prefs>(k: K, label: string, options: [NonNullable<Prefs[K]>, string][]) => (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-semibold">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map(([v, l]) => (
          <label key={String(v)} className="flex items-center gap-1.5 text-sm">
            <input type="radio" name={`pref-${k}`} checked={prefs[k] === v} disabled={!data} onChange={() => set({ [k]: v } as Prefs)} /> {l}
          </label>
        ))}
      </div>
    </fieldset>
  );
  const toggle = (k: "conversations" | "shortcuts" | "sendArchive", label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={!!prefs[k]} disabled={!data} onChange={(e) => set({ [k]: e.target.checked })} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="grid gap-4 pt-2">
      {choice("replyDefault", t("Default reply"), [["reply", t("Reply")], ["replyAll", t("Reply all")]])}
      {toggle("conversations", t("Conversation view"), t("Messages of one conversation are one line in the list."))}
      {choice("density", t("Density"), [["comfortable", t("Comfortable")], ["compact", t("Compact")]])}
      {choice("pane", t("Reading pane"), [["right", t("Beside the list")], ["below", t("Below the list")], ["off", t("Off: a conversation opens over the list")]])}
      {toggle("shortcuts", t("Keyboard shortcuts"), t("Single keys such as e to archive and # to delete. Turn them off if you type into the page by accident."))}
      {toggle("sendArchive", t("Send and archive"), t("Sending a reply also archives the conversation."))}
      {choice("notify", t("Notify me about new mail"), [["all", t("All new mail in the inbox")], ["people", t("Only from people I have written to")], ["none", t("Nothing")]])}
      <div className="grid gap-1 text-sm">
        <span className="font-semibold">{t("Desktop notifications")}</span>
        {permission === "granted" ? (
          <p className="text-muted-foreground">
            {serverNotifies ? t("On in this browser, for shared mailboxes while Mail is open. Your own mail notifies through your notification settings.") : t("On in this browser. New mail shows a notification while Mail is open in a tab, even in the background.")}
          </p>
        ) : permission === "denied" ? (
          <p className="text-muted-foreground">{t("This browser blocks them for this site. Allow them in the browser's site settings to get them.")}</p>
        ) : permission === "unsupported" ? (
          <p className="text-muted-foreground">{t("This browser cannot show them.")}</p>
        ) : (
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => void Notification.requestPermission().then(setPermission)}>
            {t("Turn on desktop notifications")}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {serverNotifies
            ? t("New mail notifies you within about a minute, whether Mail is open or not: in the bar, and by email, in a daily digest or on your phone if you chose that for “New mail in your inbox” in your notification settings.")
            : t("Mail notices new mail while it is open in a tab. When no tab is open, nothing notifies you yet.")}
        </p>
      </div>
    </div>
  );
}

/** The day a moment falls on, on the person's clock (the form edits days; the server keeps moments). */
const day = (v: string | null) => (!v ? "" : /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : toZonedInput(v).slice(0, 10));

function VacationForm({ account, boxes }: { account: string; boxes: Mailbox[] }) {
  const q = useQuery({
    queryKey: ["mail", "vacation", account],
    queryFn: async () => ((await jmap([["VacationResponse/get", { accountId: account, ids: ["singleton"] }, "0"]]))["0"].list as Vacation[])[0],
  });
  // While filters run, the reply runs from Mail's script and the server's own flag reads off: on is on either way.
  const ours = useMailData(account, boxes);
  const qc = useQueryClient();
  const [form, setForm] = useState<Vacation | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && ours.data && !form) setForm({ ...q.data, isEnabled: vacationOn(ours.data, q.data.isEnabled) });
  }, [q.data, ours.data, form]);
  if (q.error) return <Failure error={q.error} onRetry={() => void q.refetch()} />;
  if (!form) return <FormSkeleton fields={4} />;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const patch = {
        isEnabled: form.isEnabled,
        // The start and end of those days on the person's clock, not UTC midnights.
        fromDate: form.fromDate ? fromZonedInput(`${day(form.fromDate)}T00:00`) : null,
        toDate: form.toDate ? fromZonedInput(`${day(form.toDate)}T23:59:59`) : null,
        subject: form.subject || null,
        textBody: form.textBody || null,
      };
      const r = await jmap([["VacationResponse/set", { accountId: account, update: { singleton: patch } }, "0"]]);
      const failed = (r["0"].notUpdated as Record<string, { description?: string }> | undefined)?.singleton;
      if (failed) throw new Error(failed.description ?? t("The mail server refused the change."));
      // The server runs one script at a time: with filters, the reply runs from Mail's script.
      await afterVacation(account, boxes, form.isEnabled);
      void qc.invalidateQueries({ queryKey: ["mail", "data", account] });
      toast(form.isEnabled ? t("Your vacation reply is on.") : t("Your vacation reply is off."));
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="grid gap-3 pt-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /> {t("Answer incoming mail automatically")}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="vac-from">{t("From (optional)")}</Label>
          <Input id="vac-from" type="date" value={day(form.fromDate)} onChange={(e) => setForm({ ...form, fromDate: e.target.value || null })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="vac-to">{t("Until (optional)")}</Label>
          <Input id="vac-to" type="date" value={day(form.toDate)} onChange={(e) => setForm({ ...form, toDate: e.target.value || null })} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="vac-subject">{t("Subject")}</Label>
        <Input id="vac-subject" value={form.subject ?? ""} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder={t("Out of office")} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="vac-body">{t("Message")}</Label>
        <Textarea id="vac-body" rows={5} value={form.textBody ?? ""} onChange={(e) => setForm({ ...form, textBody: e.target.value })} />
      </div>
      <Button type="submit" className="justify-self-end" disabled={busy}>
        {t("Save")}
      </Button>
    </form>
  );
}

function AppPasswords({ account, me, servers }: { account: string; me: string; servers?: { imap: string; smtp: string } }) {
  const qc = useQueryClient();
  const key = ["mail", "app-passwords", account];
  const list = useQuery({
    queryKey: key,
    queryFn: async () => (await jmap([["x:AppPassword/get", { accountId: account, ids: null, properties: ["description", "createdAt"] }, "0"]]))["0"].list as AppPassword[],
  });
  const [description, setDescription] = useState("");
  const [made, setMade] = useState<{ description: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await jmap([["x:AppPassword/set", { accountId: account, create: { p: { description: description.trim() } } }, "0"]]);
      const created = (r["0"].created as Record<string, { secret?: string }> | undefined)?.p;
      if (!created?.secret) throw new Error(String((r["0"].notCreated as Record<string, { description?: string }> | undefined)?.p?.description ?? t("The mail server refused it.")));
      setMade({ description: description.trim(), secret: created.secret });
      setDescription("");
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (a: AppPassword) => {
    if (!(await confirmDialog({ title: t("Remove \"{description}\"?", { description: a.description }), message: t("Mail programs using it stop getting mail."), confirmLabel: t("Remove"), danger: true }))) return;
    try {
      await jmap([["x:AppPassword/set", { accountId: account, destroy: [a.id] }, "0"]]);
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <div className="grid gap-3 pt-2 text-sm">
      <p className="text-muted-foreground">
        {placed(t("Mail programs (Outlook, Apple Mail, Thunderbird, phones) sign in with your address {p1} and an app password made here, one per program."), { p1: <strong className="text-foreground">{isolate(me)}</strong> })}
      </p>
      {servers && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border p-3">
          <dt className="text-muted-foreground">{t("Incoming (IMAP, SSL)")}</dt>
          <dd className="font-mono">{isolate(servers.imap)}</dd>
          <dt className="text-muted-foreground">{t("Outgoing (SMTP, SSL)")}</dt>
          <dd className="font-mono">{isolate(servers.smtp)}</dd>
        </dl>
      )}
      {made && (
        <div className="grid gap-1 rounded-md border border-primary bg-primary-soft p-3" role="status">
          <span>
            {t("App password for")} <strong>{isolate(made.description)}</strong>{t(". Copy it now: it is not shown again.")}
          </span>
          <code className="rounded bg-background px-2 py-1 font-mono text-base select-all">{isolate(made.secret)}</code>
          <Button variant="outline" size="xs" className="justify-self-start" onClick={() => void navigator.clipboard?.writeText(made.secret).then(() => toast(t("Copied")))}>
            {t("Copy")}
          </Button>
        </div>
      )}
      <form onSubmit={create} className="flex gap-2">
        <Input aria-label={t("What the app password is for")} placeholder={t("e.g. Phone")} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={100} />
        <Button type="submit" disabled={!description.trim() || busy}>
          {t("Make one")}
        </Button>
      </form>
      {list.isLoading && <Skeleton className="h-(--control-h)" />}
      {!!list.error && <p className="text-destructive">{isolate(errorMessage(list.error))}</p>}
      <ul className="grid gap-1" aria-label={t("App passwords")}>
        {list.data?.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
            <Inbox className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">{a.description || t("(no description)")}</span>
            {a.createdAt && <span className="text-xs text-muted-foreground">{isolate(formatDateTime(a.createdAt))}</span>}
            <Button variant="ghost" size="xs" onClick={() => void revoke(a)}>
              {t("Remove")}
            </Button>
          </li>
        ))}
        {list.data && !list.data.length && <li className="text-muted-foreground">{t("No app passwords yet.")}</li>}
      </ul>
    </div>
  );
}


/** The addresses whose mail goes straight to Spam (one Sieve script that Mail owns), each removable. */
function BlockedSenders({ account, boxes }: { account: string; boxes: Mailbox[] }) {
  const qc = useQueryClient();
  const key = ["mail", "blocked", account];
  const state = useQuery({ queryKey: key, queryFn: () => readBlocked(account), retry: false });
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (next: string[]) => {
    if (!state.data) return;
    setBusy(true);
    try {
      qc.setQueryData(key, await writeBlocked(account, next, boxes));
    } catch (err) {
      toast(t("The blocked list was not saved: {e}", { e: errorMessage(err) }), "error");
    } finally {
      setBusy(false);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const a = address.trim().toLowerCase();
    if (!/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(a)) return toast(t("That is not an email address."), "error");
    setAddress("");
    void save([...(state.data?.blocked ?? []), a]);
  };
  const s = state.data;
  return (
    <div className="grid gap-3 pt-2 text-sm">
      <p className="text-muted-foreground">{t("Mail from these addresses goes to Spam instead of the inbox. Block someone from a message's menu, or add an address here.")}</p>
      {s?.otherActive && (
        <p role="status" className="rounded-md border bg-warning-soft px-3 py-2">
          {t("The list is kept, but it cannot work: your mailbox runs another filter script (“{name}”), and only one can be active.", { name: s.otherActive })}
        </p>
      )}
      <form onSubmit={add} className="flex gap-2">
        <Input type="email" aria-label={t("Address to block")} placeholder={t("name@example.com")} value={address} onChange={(e) => setAddress(e.target.value)} />
        <Button type="submit" disabled={!address.trim() || busy || !s}>
          {t("Block")}
        </Button>
      </form>
      {state.isLoading && <Skeleton className="h-(--control-h)" />}
      {!!state.error && <Failure error={state.error} onRetry={() => void state.refetch()} title={t("The blocked list could not be read")} />}
      <ul className="grid gap-1" aria-label={t("Blocked senders")}>
        {s?.blocked.map((a) => (
          <li key={a} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{isolate(a)}</span>
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void save(s.blocked.filter((x) => x !== a))}>
              {t("Unblock")}
            </Button>
          </li>
        ))}
        {s && !s.blocked.length && <li className="text-muted-foreground">{t("Nobody is blocked.")}</li>}
      </ul>
    </div>
  );
}

/** How sending behaves, the signature of each address the person writes as, and their templates. */
function WritingSettings({ account, boxes }: { account: string; boxes: Mailbox[] }) {
  const qc = useQueryClient();
  const data = useMailData(account, boxes).data?.data;
  const prefs = prefsOf(data);
  const change = useChangeMailData(account, boxes);
  const set = (p: Prefs) => void change((d) => ({ ...d, prefs: { ...d.prefs, ...p } }));
  const identities = useIdentities(account);
  const templates = useTemplates(account, boxes);
  const remove = async (id: string, subject: string) => {
    if (!(await confirmDialog({ title: t("Delete the template “{name}”?", { name: subject }), message: t("It is removed from your Templates folder for good."), confirmLabel: t("Delete"), danger: true }))) return;
    try {
      await jmap([["Email/set", { accountId: account, destroy: [id] }, "0"]]);
      void qc.invalidateQueries({ queryKey: ["mail", "templates", account] });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <div className="grid gap-5 pt-2">
      <section className="grid gap-1.5" aria-labelledby="set-undo">
        <h3 id="set-undo" className="text-sm font-semibold">{t("Undo send")}</h3>
        <p className="text-sm text-muted-foreground">{t("The mail server holds a sent message this long, so Undo can call it back, even if you close the page.")}</p>
        <select aria-labelledby="set-undo" className="h-(--control-h) w-48 rounded-md border border-input bg-card px-2 text-sm" value={prefs.undoSeconds} disabled={!data} onChange={(e) => set({ undoSeconds: Number(e.target.value) })}>
          {UNDO_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n ? t("{n} seconds", { n }) : t("Off")}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("Kept on the mail server with your Mail settings, so it follows you to any browser.")}</p>
      </section>
      <section className="grid gap-2" aria-labelledby="set-sig">
        <h3 id="set-sig" className="text-sm font-semibold">{t("Signature")}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={prefs.signatureInReplies} disabled={!data} onChange={(e) => set({ signatureInReplies: e.target.checked })} />
          {t("Add it to replies and forwards too, above the quoted message")}
        </label>
        {identities.error ? <Failure error={identities.error} onRetry={() => void identities.refetch()} /> : !identities.data ? <Skeleton className="h-24" /> : identities.data.map((i) => <SignatureEditor key={i.id} account={account} identity={i} />)}
      </section>
      <section className="grid gap-1.5" aria-labelledby="set-tpl">
        <h3 id="set-tpl" className="text-sm font-semibold">{t("Templates")}</h3>
        <p className="text-sm text-muted-foreground">{t("Save a message as a template from its ⋮ menu while you write; insert one from the same menu. They are kept in your Templates folder, where other mail programs see them too.")}</p>
        {templates.data?.length ? (
          <ul className="grid gap-1">
            {templates.data.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate">{isolate(m.subject || t("(no subject)"))}</span>
                <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">{isolate(m.preview)}</span>
                <Button variant="ghost" size="xs" onClick={() => void remove(m.id, m.subject ?? "")}>
                  {t("Delete")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{templates.isLoading ? t("Loading…") : t("No templates yet.")}</p>
        )}
      </section>
    </div>
  );
}

/** One address's signature, written as rich text and kept on the mail server's identity, so other mail programs that read it share it. */
function SignatureEditor({ account, identity }: { account: string; identity: { id: string; name: string; email: string; htmlSignature?: string | null; textSignature?: string | null } }) {
  const qc = useQueryClient();
  const editor = useRef<EditorHandle>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // Pictures go in the signature itself (it is kept on the identity), small ones only; they become parts of each message sent.
  const addPictures = async (files: File[]) => {
    for (const f of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) toast(t("Only PNG, JPEG, GIF and WebP pictures can go into a signature."), "error");
      else if (f.size > 200 * 1024) toast(t("“{name}” is too large for a signature: at most 200 KB.", { name: f.name }), "error");
      else {
        const src = await new Promise<string>((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result));
          r.onerror = () => no(r.error);
          r.readAsDataURL(f);
        });
        editor.current?.insertImage({ src, name: f.name, upload: "" });
        setDirty(true);
      }
    }
  };
  const save = async () => {
    const raw = editor.current?.html() ?? "";
    const empty = !htmlToText(raw).trim();
    const html = empty ? "" : fromEditor(raw);
    setBusy(true);
    try {
      const r = await jmap([["Identity/set", { accountId: account, update: { [identity.id]: { htmlSignature: html, textSignature: empty ? "" : htmlToText(html) } } }, "0"]]);
      const failed = (r["0"].notUpdated as Record<string, { type?: string; description?: string }> | undefined)?.[identity.id];
      if (failed) throw new Error(refusal(failed, t("The mail server refused the change.")));
      setDirty(false);
      toast(empty ? t("Signature removed") : t("Signature saved"));
      void qc.invalidateQueries({ queryKey: ["mail", "identities", account] });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-1.5">
      <span className="text-sm">{isolate(identity.name ? `${identity.name} <${identity.email}>` : identity.email)}</span>
      <div className="h-40 overflow-hidden rounded-md border">
        <Suspense fallback={<Skeleton className="h-full" />}>
          <MailEditor ref={editor} initial={signatureOf(identity as never)} label={t("Signature for {address}", { address: identity.email })} placeholder={t("Your name, role, phone")} onChange={() => setDirty(true)} onFiles={(files) => void addPictures(files)} onSend={() => void save()} />
        </Suspense>
      </div>
      <Button size="sm" className="justify-self-end" disabled={!dirty || busy} onClick={() => void save()}>
        {t("Save signature")}
      </Button>
    </div>
  );
}
