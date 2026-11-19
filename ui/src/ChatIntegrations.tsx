// A channel's incoming webhooks: secret addresses outside programs post messages to, under the webhook's name. Owners
// make them (the address is shown once), make a new address, switch them off and on, and delete them; members see the
// list. Every change is the webhook record's own operation through the platform.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button, Input, Label } from "@ferrum/kit/primitives";
import { confirmDialog, FormSkeleton, toast } from "@ferrum/kit";
import { api, docPath, errorMessage, isolate, newKey, relativeTime, t as tr } from "@ferrum/client";
import { Failure } from "./States";
import type { Channel } from "./lib/chat";

interface Webhook {
  id: string;
  webhook_name: string;
  enabled: boolean;
  last_used_at?: string | null;
}

interface Address {
  path: string;
  url?: string | null;
}

export function Integrations({ c }: { c: Channel }) {
  const qc = useQueryClient();
  const ids = useId();
  const owner = c.role === "Owner";
  const key = ["chat", "webhooks", c.id] as const;
  const hooks = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get<{ rows: Webhook[] }>(docPath("ChatWebhook"), { filters: JSON.stringify([["channel", "=", c.id]]), fields: "id,webhook_name,enabled,last_used_at", limit: 100 }, signal),
  });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Address | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const address = async (id: string) => {
    const a = await api.post<Address>(docPath("ChatWebhook", id, "actions", "rotate_token"), {}, { idempotencyKey: newKey() });
    setShown(a);
  };
  const add = () =>
    run(async () => {
      const made = await api.post<{ id: string }>(docPath("ChatWebhook"), { webhook_name: name.trim(), channel: c.id }, { idempotencyKey: newKey() });
      setName("");
      await address(made.id);
    });
  const rotate = async (h: Webhook) => {
    const ok = await confirmDialog({ title: tr("Make a new address?"), message: tr("A new secret address is made and the previous one stops working."), confirmLabel: tr("New address") });
    if (ok) await run(() => address(h.id));
  };
  const toggle = (h: Webhook) => run(async () => void (await api.patch(docPath("ChatWebhook", h.id), { enabled: !h.enabled })));
  const remove = async (h: Webhook) => {
    const ok = await confirmDialog({ title: tr("Delete {name}?", { name: h.webhook_name }), message: tr("Its address stops working. Messages it posted stay."), confirmLabel: tr("Delete"), danger: true });
    if (ok) await run(() => api.del(docPath("ChatWebhook", h.id)));
  };

  if (hooks.error) return <Failure error={hooks.error} onRetry={() => void hooks.refetch()} />;
  if (!hooks.data) return <FormSkeleton fields={3} />;
  const list = hooks.data.rows;
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted-foreground">{tr("Outside programs post messages here through a secret address, under the webhook's name.")}</p>
      {shown && (
        <div role="status" className="grid gap-1.5 rounded-md border border-primary bg-primary-soft p-2">
          <p className="font-medium">{tr("This address is shown only now")}</p>
          <code className="break-all text-xs">{isolate(shown.url || shown.path)}</code>
          <p className="text-xs text-muted-foreground">{tr("Post JSON with a text field to it, at most 4096 bytes.")}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(shown.url || shown.path).then(() => toast(tr("Copied")))}>
              {tr("Copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShown(null)}>
              {tr("Done")}
            </Button>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <p className="text-muted-foreground">{tr("No webhooks yet")}</p>
      ) : (
        <ul className="grid gap-2" aria-label={tr("Incoming webhooks")}>
          {list.map((h) => (
            <li key={h.id} className="grid gap-1 rounded-md border p-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{isolate(h.webhook_name)}</span>
                <span className="text-xs text-muted-foreground">{h.enabled ? tr("On") : tr("Off")}</span>
              </div>
              <p className="text-xs text-muted-foreground">{h.last_used_at ? tr("Last used {value}", { value: relativeTime(h.last_used_at) }) : tr("Not used yet")}</p>
              {owner && (
                <div className="flex flex-wrap gap-1">
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => void rotate(h)}>
                    {tr("New address")}
                  </Button>
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => void toggle(h)}>
                    {h.enabled ? tr("Switch off") : tr("Switch on")}
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove(h)}>
                    {tr("Delete")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {owner ? (
        <form
          className="grid gap-1.5 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void add();
          }}
        >
          <Label htmlFor={`${ids}-name`}>{tr("New webhook's name")}</Label>
          <div className="flex gap-2">
            <Input id={`${ids}-name`} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("Build server")} />
            <Button type="submit" disabled={busy || !name.trim()}>
              {tr("Add webhook")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">{tr("Only the channel's owners can change these.")}</p>
      )}
    </div>
  );
}
