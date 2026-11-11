// Filters (rules the mail server runs on arriving mail, in Mail's one Sieve script), forwarding as a
// filter's action, and the banner that says mail is being forwarded. A filter is made here, from a
// message ("Filter messages like this") or from a search; "also apply to matching mail now" files
// what is already there through the same Undo as every other action.

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Forward, Pencil, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Skeleton, Switch } from "@ferrum/kit/primitives";
import { isolate, t as tr } from "@ferrum/client";
import { confirmDialog } from "@ferrum/kit";
import { Failure } from "./States";
import { useMailActions } from "./MailActions";
import { useChangeMailData, useMailData } from "./MailData";
import { cleanRule, forwardsTo, ruleProblem, rulePatch, ruleQuery, type Rule, type Then, type When } from "./lib/filters";
import { folderName, moveTargets } from "./lib/folders";
import { byRole, sizeLabel, type Mailbox } from "./lib/mail";
import { foldersOf, scriptText } from "./lib/mailData";
import { bytes } from "./lib/search";

/** "a, b and c" in the page's language. */
const listOf = (parts: string[]) => {
  try {
    return new Intl.ListFormat(document.documentElement.lang || undefined, { type: "unit" }).format(parts);
  } catch {
    return parts.join(", ");
  }
};

const PROBLEMS: Record<string, () => string> = {
  condition: () => tr("Say which mail: fill in at least one of the first fields."),
  action: () => tr("Say what to do with it: tick at least one action."),
  address: () => tr("The forwarding address is not an email address."),
  loop: () => tr("Mail cannot be forwarded to this mailbox itself."),
  "one-forward": () => tr("Only one filter can forward: the mail server forwards a message to one address at most. Turn the other off first."),
};

/** "From bank, subject “x”" for the list. */
export function whenLine(w: When): string {
  const out: string[] = [];
  if (w.from) out.push(tr("from “{value}”", { value: w.from }));
  if (w.to) out.push(tr("to “{value}”", { value: w.to }));
  if (w.subject) out.push(tr("subject has “{value}”", { value: w.subject }));
  if (w.words) out.push(tr("has the words “{value}”", { value: w.words }));
  if (w.list) out.push(tr("list “{value}”", { value: w.list }));
  if (w.larger) out.push(tr("larger than {value}", { value: sizeLabel(w.larger) }));
  if (w.smaller) out.push(tr("smaller than {value}", { value: sizeLabel(w.smaller) }));
  return listOf(out);
}

export function thenLine(t: Then, boxes: Mailbox[]): string {
  const out: string[] = [];
  const folder = t.folder ? boxes.find((b) => b.id === t.folder) : undefined;
  if (t.trash) out.push(tr("delete it"));
  if (folder) out.push(t.skipInbox ? tr("move to {value}", { value: folderName(folder) }) : tr("also file under {value}", { value: folderName(folder) }));
  else if (t.skipInbox) out.push(tr("skip the inbox (archive it)"));
  if (t.star) out.push(tr("star it"));
  if (t.read) out.push(tr("mark it as read"));
  if (t.neverSpam) out.push(tr("never send it to Spam"));
  if (t.forward) out.push(tr("forward it to {value}", { value: t.forward }));
  if (t.folder && !folder) out.push(tr("(its folder is gone)"));
  return listOf(out);
}

/** The filter form: which mail, what to do, and whether to do it to the mail already here. */
export function FilterDialog({ account, boxes, own, rule, onClose }: { account: string; boxes: Mailbox[]; own: string[]; rule: Rule; onClose: () => void }) {
  const state = useMailData(account, boxes);
  const save = useChangeMailData(account, boxes);
  const actions = useMailActions(account, boxes);
  const [w, setW] = useState<Record<keyof When, string>>({
    from: rule.when.from ?? "",
    to: rule.when.to ?? "",
    subject: rule.when.subject ?? "",
    words: rule.when.words ?? "",
    list: rule.when.list ?? "",
    larger: rule.when.larger ? `${Math.round(rule.when.larger / 1024)}K` : "",
    smaller: rule.when.smaller ? `${Math.round(rule.when.smaller / 1024)}K` : "",
  });
  const [t, setT] = useState<Then>(rule.then);
  const [move, setMove] = useState(!!rule.then.folder || !!rule.then.skipInbox);
  const [forwarding, setForwarding] = useState(!!rule.then.forward);
  const [now, setNow] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const existing = state.data?.data.rules.some((r) => r.id === rule.id);
  const targets = moveTargets(boxes).filter((x) => !["drafts", "sent", "junk", "trash", "inbox"].includes(x.box.role ?? ""));

  const built = (): Rule | string => {
    for (const k of ["larger", "smaller"] as const) if (w[k].trim() && bytes(w[k]) === null) return tr("“{value}” is not a size. Write it as 500K or 10M.", { value: w[k] });
    return cleanRule({
      id: rule.id,
      on: rule.on,
      when: { from: w.from, to: w.to, subject: w.subject, words: w.words, list: w.list, larger: w.larger.trim() ? bytes(w.larger)! : undefined, smaller: w.smaller.trim() ? bytes(w.smaller)! : undefined },
      then: { ...t, folder: move ? t.folder : undefined, skipInbox: move ? t.skipInbox : false, forward: forwarding ? t.forward : undefined },
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = built();
    if (typeof r === "string") return setProblem(r);
    const bad = ruleProblem(r, own, state.data?.data.rules ?? []);
    if (bad) return setProblem(PROBLEMS[bad]!());
    // Forwarding sends the person's mail out of the workspace: they say it is meant.
    if (r.then.forward && r.then.forward !== rule.then.forward) {
      const ok = await confirmDialog({
        title: tr("Forward mail to {address}?", { address: r.then.forward }),
        message: tr("Copies of every message this filter matches will go to {address}, from now on, until you turn the filter off. Check that the address is yours or meant to have them.", { address: r.then.forward }),
        confirmLabel: tr("Yes, forward"),
      });
      if (!ok) return;
    }
    setBusy(true);
    const done = await save((d) => ({ ...d, rules: existing ? d.rules.map((x) => (x.id === r.id ? r : x)) : [...d.rules, r] }), { failed: tr("The filter was not saved.") });
    if (done && now) {
      // Mail already here: the folders and flags (never forwarding); Trash and Spam are left alone unless the filter says never spam.
      const f = foldersOf(boxes);
      const out = r.then.neverSpam ? [byRole(boxes, "trash")?.id] : ["trash", "junk"].map((x) => byRole(boxes, x)?.id);
      const ids = await actions.idsMatching({ operator: "AND", conditions: [ruleQuery(r.when), { inMailboxOtherThan: out.filter(Boolean) }] });
      await actions.patch(ids, (s) => rulePatch(r.then, f, s.mailboxIds ?? {}), tr("The filter was applied to {value}", { value: tr("{n} messages", { n: ids.length }) }));
    }
    setBusy(false);
    if (done) {
      if (!done.active && done.otherActive) setProblem(tr("Saved, but it cannot run: your mailbox runs your own filter script “{name}”. See Filters in Mail settings.", { name: done.otherActive.name }));
      else onClose();
    }
  };

  const field = (k: keyof When, label: string, hint?: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`rule-${k}`}>{label}</Label>
      <Input id={`rule-${k}`} value={w[k]} placeholder={hint} onChange={(e) => (setW({ ...w, [k]: e.target.value }), setProblem(null))} />
    </div>
  );
  const tick = (k: keyof Then, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={!!t[k]} onCheckedChange={(c) => (setT({ ...t, [k]: c === true }), setProblem(null))} /> {label}
    </label>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? tr("Change the filter") : tr("New filter")}</DialogTitle>
            <DialogDescription>{tr("The mail server applies it to mail as it arrives, even when Mail is closed. Spam is left to the spam filter unless you say never.")}</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-semibold">{tr("When a message")}</legend>
            {field("from", tr("From"), tr("name, address or domain"))}
            {field("to", tr("To"))}
            {field("subject", tr("Subject has"))}
            {field("words", tr("Has the words"))}
            {field("list", tr("Mailing list"), tr("e.g. news.example.com"))}
            <div className="grid grid-cols-2 gap-2">
              {field("larger", tr("Larger than"), "5M")}
              {field("smaller", tr("Smaller than"), "100K")}
            </div>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">{tr("Then")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={move} onCheckedChange={(c) => (setMove(c === true), setT({ ...t, skipInbox: c === true ? true : t.skipInbox }), setProblem(null))} /> {tr("Move it to")}
              <select
                aria-label={tr("Folder")}
                className="h-(--control-h-sm) min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-sm"
                value={t.folder ?? ""}
                onChange={(e) => (setT({ ...t, folder: e.target.value || undefined }), setMove(true))}
              >
                <option value="">{tr("Archive (skip the inbox)")}</option>
                {targets.map(({ box, depth }) => (
                  <option key={box.id} value={box.id}>
                    {" ".repeat(depth * 2)}
                    {folderName(box)}
                  </option>
                ))}
              </select>
            </label>
            {move && t.folder && (
              <label className="flex items-center gap-2 ps-6 text-sm">
                <Checkbox checked={!t.skipInbox} onCheckedChange={(c) => setT({ ...t, skipInbox: c !== true })} /> {tr("Keep it in the inbox too")}
              </label>
            )}
            {tick("star", tr("Star it"))}
            {tick("read", tr("Mark it as read"))}
            {tick("neverSpam", tr("Never send it to Spam"))}
            {tick("trash", tr("Delete it (to Trash)"))}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={forwarding} onCheckedChange={(c) => (setForwarding(c === true), setProblem(null))} /> {tr("Forward a copy to")}
              <Input type="email" aria-label={tr("Forwarding address")} className="h-(--control-h-sm) min-w-0 flex-1" value={t.forward ?? ""} disabled={!forwarding} onChange={(e) => (setT({ ...t, forward: e.target.value }), setProblem(null))} placeholder={tr("name@example.com")} />
            </label>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={now} onCheckedChange={(c) => setNow(c === true)} /> {tr("Also apply it to matching mail already here (forwarding is never done to old mail)")}
          </label>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !state.data}>
              {busy ? tr("Saving…") : existing ? tr("Save filter") : tr("Make filter")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mail settings' Filters: the person's filters in order, each on or off; and, when the person's own script is the one the server runs, that script read-only with a way to switch. */
export function FiltersSettings({ account, boxes, own }: { account: string; boxes: Mailbox[]; own: string[] }) {
  const state = useMailData(account, boxes);
  const save = useChangeMailData(account, boxes);
  const [editing, setEditing] = useState<Rule | null>(null);
  const other = state.data?.otherActive;
  const theirs = state.data?.others.find((s) => s.id === other?.id);
  const text = useQuery({ queryKey: ["mail", "script", account, theirs?.blobId], queryFn: () => scriptText(account, theirs!.blobId), enabled: !!theirs });
  if (state.error) return <Failure error={state.error} onRetry={() => void state.refetch()} title={tr("The filters could not be read")} />;
  if (!state.data) return <Skeleton className="mt-2 h-32" />;
  const rules = state.data.data.rules;
  const swap = (i: number, j: number) => void save((d) => {
    const r = [...d.rules];
    [r[i], r[j]] = [r[j]!, r[i]!];
    return { ...d, rules: r };
  });
  const remove = async (r: Rule) => {
    if (!(await confirmDialog({ title: tr("Delete this filter?"), message: whenLine(r.when), confirmLabel: tr("Delete"), danger: true }))) return;
    await save((d) => ({ ...d, rules: d.rules.filter((x) => x.id !== r.id) }));
  };
  return (
    <div className="grid gap-3 pt-2 text-sm">
      <p className="text-muted-foreground">{tr("Filters sort mail as it arrives, in this order, even when Mail is closed. Every filter that matches applies.")}</p>
      {other && (
        <div role="status" className="grid gap-2 rounded-md border bg-warning-soft px-3 py-2">
          <p>{tr("Your mailbox runs a filter script of your own, “{name}”, so these filters and your blocked senders cannot run: a mailbox runs one script at a time. It is shown below and was not changed.", { name: other.name })}</p>
          {text.data !== undefined && <pre className="max-h-48 overflow-auto rounded border bg-card p-2 font-mono text-xs whitespace-pre-wrap" aria-label={tr("Your script “{name}”", { name: other.name })}>{text.data}</pre>}
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={async () => {
              if (await confirmDialog({ title: tr("Use Mail's filters instead?"), message: tr("Your script “{name}” stops running but is kept; you can switch back from a mail program that edits filter scripts.", { name: other.name }), confirmLabel: tr("Use Mail's filters") }))
                await save((d) => d, { takeOver: true });
            }}
          >
            {tr("Use Mail's filters instead")}
          </Button>
        </div>
      )}
      <Button size="sm" className="justify-self-start" onClick={() => setEditing(cleanRule({ when: {}, then: {} }))}>
        {tr("New filter")}
      </Button>
      <ul className="grid gap-1" aria-label={tr("Filters")}>
        {rules.map((r, i) => (
          <li key={r.id} className="flex items-start gap-2 rounded-md border px-3 py-2">
            <Switch className="mt-0.5" checked={r.on} aria-label={tr("Filter on")} onCheckedChange={(on) => void save((d) => ({ ...d, rules: d.rules.map((x) => (x.id === r.id ? { ...x, on } : x)) }))} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="break-words">{isolate(whenLine(r.when))}</span>
              <span className="break-words text-muted-foreground">
                {r.then.forward && <Forward className="me-1 inline size-3.5" aria-hidden="true" />}
                {isolate(thenLine(r.then, boxes))}
              </span>
            </span>
            <Button variant="ghost" size="icon-sm" aria-label={tr("Move up")} disabled={i === 0} onClick={() => swap(i, i - 1)}>
              <ArrowUp />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={tr("Move down")} disabled={i === rules.length - 1} onClick={() => swap(i, i + 1)}>
              <ArrowDown />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={tr("Change")} onClick={() => setEditing(r)}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={tr("Delete")} onClick={() => void remove(r)}>
              <Trash2 />
            </Button>
          </li>
        ))}
        {!rules.length && <li className="text-muted-foreground">{tr("No filters yet. Make one here, from a message's menu, or from a search.")}</li>}
      </ul>
      {editing && <FilterDialog account={account} boxes={boxes} own={own} rule={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** While any filter forwards mail, Mail says so at the top (people forget they set it up). */
export function ForwardingBanner({ account, boxes, onManage }: { account: string; boxes: Mailbox[]; onManage: () => void }) {
  const d = useMailData(account, boxes).data;
  const to = d && d.active ? forwardsTo(d.data) : [];
  if (!to.length) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-primary-soft px-3 py-1.5 text-xs">
      <Forward className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{tr("Some of your mail is being forwarded to {address}.", { address: isolate(to.join(", ")) })}</span>
      <Button size="xs" variant="outline" onClick={onManage}>
        {tr("Manage filters")}
      </Button>
    </div>
  );
}

