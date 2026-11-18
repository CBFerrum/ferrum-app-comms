// How long a conversation's messages are kept, for administrators: the platform's retention rules on
// chat messages (one for this channel, one for every channel), run daily by the platform, which
// respects legal holds. Nothing here deletes a message itself.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button, Input, Label } from "@ferrum/kit/primitives";
import { confirmDialog, FormSkeleton, toast } from "@ferrum/kit";
import { ApiError, api, errorMessage, isolate, t as tr } from "@ferrum/client";
import { Failure } from "./States";
import { RETENTION, keptDays, ruleFor, type RetentionRule } from "./lib/chat";

export const retentionKey = ["chat", "retention"] as const;

export function ChatRetention({ channel }: { channel: string }) {
  const rules = useQuery({ queryKey: retentionKey, queryFn: ({ signal }) => api.get<{ rules: RetentionRule[] }>(RETENTION, undefined, signal) });
  const ids = useId();
  const mine = rules.data ? ruleFor(rules.data.rules, channel) : null;
  return (
    <section aria-labelledby={`${ids}-h`} className="mt-4 grid gap-3 border-t pt-3 text-sm">
      <h4 id={`${ids}-h`} className="font-medium">
        {tr("How long messages are kept")}
      </h4>
      {rules.error ? (
        <Failure error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !mine ? (
        <FormSkeleton fields={2} />
      ) : (
        <>
          <p className="text-muted-foreground">
            {mine.channel && mine.workspace
              ? tr("Both are set: the shorter time applies to this channel.")
              : !mine.channel && !mine.workspace
                ? tr("Messages are kept until someone deletes them")
                : tr("Older messages are removed by a daily run. Legal holds are respected; attached files are not removed yet.")}
          </p>
          <RuleForm title={tr("This channel")} rule={mine.channel} condition={[["channel", "=", channel]]} />
          <RuleForm title={tr("Every channel")} rule={mine.workspace} />
        </>
      )}
    </section>
  );
}

function RuleForm({ title, rule, condition }: { title: string; rule?: RetentionRule; condition?: unknown }) {
  const qc = useQueryClient();
  const ids = useId();
  const [days, setDays] = useState(rule ? String(rule.after_days) : "");
  const [reason, setReason] = useState(rule?.reason ?? "");
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reach, setReach] = useState<string | null>(null);

  const fail = (e: unknown) => {
    const f = e instanceof ApiError ? e.fields.find((x) => x.field === "after_days" || x.field === "reason") : undefined;
    setProblem(f ? { field: f.field, message: f.message } : { field: "", message: errorMessage(e) });
  };
  const save = async () => {
    const n = keptDays(days);
    if (n === null) return setProblem({ field: "after_days", message: tr("A whole number of days from 1 to 36500") });
    if (!reason.trim()) return setProblem({ field: "reason", message: tr("Say why messages are kept this long") });
    setBusy(true);
    setProblem(null);
    setReach(null);
    try {
      const body = { entity: "ChatMessage", after_days: n, date_field: "posted_at", action: "delete", condition, reason: reason.trim() };
      const id = rule ? (await api.put(`${RETENTION}/${rule.id}`, body), rule.id) : (await api.post<{ id: string }>(RETENTION, body)).id;
      await qc.invalidateQueries({ queryKey: retentionKey });
      const p = await api.post<{ reaches: number; more: boolean }>(`${RETENTION}/${id}/preview`, {});
      setReach(p.more ? tr("More than {n} messages would be removed at the next daily run", { n: p.reaches }) : tr("{n} messages would be removed at the next daily run", { n: p.reaches }));
      toast(tr("Saved"));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!rule) return;
    const ok = await confirmDialog({ title: tr("Remove this rule?"), message: tr("Messages are no longer removed by it."), confirmLabel: tr("Remove"), danger: true });
    if (!ok) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.del(`${RETENTION}/${rule.id}`);
      setDays("");
      setReason("");
      setReach(null);
      await qc.invalidateQueries({ queryKey: retentionKey });
      toast(tr("Removed"));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const problemFor = (field: string) =>
    problem?.field === field ? (
      <p role="alert" className="text-xs text-destructive">
        {isolate(problem.message)}
      </p>
    ) : null;

  return (
    <fieldset className="grid gap-2 rounded-md border p-2" disabled={busy}>
      <legend className="px-1 font-medium">{title}</legend>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-days`}>{tr("Days messages are kept")}</Label>
        <Input id={`${ids}-days`} inputMode="numeric" value={days} aria-invalid={problem?.field === "after_days" || undefined} onChange={(e) => setDays(e.target.value)} />
        {problemFor("after_days")}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-reason`}>{tr("Why")}</Label>
        <Input id={`${ids}-reason`} maxLength={500} value={reason} aria-invalid={problem?.field === "reason" || undefined} onChange={(e) => setReason(e.target.value)} />
        {problemFor("reason")}
      </div>
      {problemFor("")}
      {reach && <p role="status" className="text-xs text-muted-foreground">{isolate(reach)}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()}>
          {busy ? tr("Saving…") : tr("Save")}
        </Button>
        {rule && (
          <Button size="sm" variant="outline" onClick={() => void remove()}>
            {tr("Remove")}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
