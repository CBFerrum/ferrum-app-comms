// Mail settings: the vacation reply, and the app passwords mail programs (Outlook, Apple Mail,
// Thunderbird, phones) sign in with. For managers there is a way on to the domain's health.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button } from "@ferrum/kit/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ferrum/kit/primitives";
import { Input } from "@ferrum/kit/primitives";
import { Label } from "@ferrum/kit/primitives";
import { Skeleton } from "@ferrum/kit/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ferrum/kit/primitives";
import { Textarea } from "@ferrum/kit/primitives";
import { errorMessage, formatDateTime, t, isolate } from "@ferrum/client";
import { can, useMetaIndex } from "@ferrum/records";
import { confirmDialog, FormSkeleton, toast, placed } from "@ferrum/kit";
import { Failure } from "./States";
import { jmap } from "./lib/mail";

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

export function MailSettings({ account, me, servers, onClose }: { account: string; me: string; servers?: { imap: string; smtp: string }; onClose: () => void }) {
  // Whoever manages Communication Settings can check the domain's records.
  const settings = useMetaIndex().data?.entities.find((e) => e.name === "CommsSettings");
  const manages = !!settings && can(settings.permissions, "write");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Mail settings")}</DialogTitle>
          <DialogDescription>{isolate(me)}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="vacation">
          <TabsList>
            <TabsTrigger value="vacation">{t("Vacation reply")}</TabsTrigger>
            <TabsTrigger value="apps">{t("Mail programs")}</TabsTrigger>
            {manages && <TabsTrigger value="domain">{t("Domain")}</TabsTrigger>}
          </TabsList>
          <TabsContent value="vacation">
            <VacationForm account={account} />
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
              </div>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function VacationForm({ account }: { account: string }) {
  const q = useQuery({
    queryKey: ["mail", "vacation", account],
    queryFn: async () => ((await jmap([["VacationResponse/get", { accountId: account, ids: ["singleton"] }, "0"]]))["0"].list as Vacation[])[0],
  });
  const [form, setForm] = useState<Vacation | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  if (q.error) return <Failure error={q.error} onRetry={() => void q.refetch()} />;
  if (!form) return <FormSkeleton fields={4} />;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const patch = {
        isEnabled: form.isEnabled,
        fromDate: form.fromDate ? `${day(form.fromDate)}T00:00:00Z` : null,
        toDate: form.toDate ? `${day(form.toDate)}T23:59:59Z` : null,
        subject: form.subject || null,
        textBody: form.textBody || null,
      };
      const r = await jmap([["VacationResponse/set", { accountId: account, update: { singleton: patch } }, "0"]]);
      const failed = (r["0"].notUpdated as Record<string, { description?: string }> | undefined)?.singleton;
      if (failed) throw new Error(failed.description ?? t("The mail server refused the change."));
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

