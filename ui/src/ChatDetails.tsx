// A channel's details, beside the conversation: General (its name, topic, who finds it and who
// posts; for owners), Personal (how loud it is for you; leaving) and Members (who is in, and for
// owners adding, removing and making owners). Changes show at once and go back, with the
// server's reason, if refused.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MoreHorizontal, Plus, X } from "lucide-react";
import { useContext, useId, useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Input, Label, Textarea } from "@ferrum/kit/primitives";
import { cn, confirmDialog, FormSkeleton, TabPanel, Tabs, toast } from "@ferrum/kit";
import { Failure } from "./States";
import { api, errorMessage, t as tr, isolate } from "@ferrum/client";
import { useMe, usePeople } from "@ferrum/records";
import { CHAT, LOUDNESS, SIDE_PANEL, accessText, addable, initials, keys, loudness, memberRows, type Channel, type Loud, type Member } from "./lib/chat";
import { Base } from "./chatBase";

export type DetailsTab = "general" | "personal" | "members";

const TABS: { id: DetailsTab; label: string }[] = [
  { id: "general", get label() { return tr("General"); } },
  { id: "personal", get label() { return tr("Notifications"); } },
  { id: "members", get label() { return tr("Members"); } },
];

export function ChannelDetails({ id, tab, onTab, onClose }: { id: string; tab: DetailsTab; onTab: (t: DetailsTab) => void; onClose: () => void }) {
  const channel = useQuery({ queryKey: keys.channel(id), queryFn: ({ signal }) => api.get<Channel>(`${CHAT}/channels/${id}`, undefined, signal) });
  const c = channel.data;
  const direct = c?.type === "Direct";
  // A direct message has its two people and one setting.
  const tabs = direct ? TABS.filter((t) => t.id === "personal") : TABS;
  const shown = direct ? "personal" : tab;
  return (
    <aside className={SIDE_PANEL} aria-label={tr("Channel details")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{(direct ? tr("Conversation details") : tr("Channel details"))}</h3>
          {c && <p className="truncate text-xs text-muted-foreground">{c.title || c.name}</p>}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={tr("Close details")} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 overflow-y-auto">
        {channel.error ? (
          <Failure error={channel.error} onRetry={() => void channel.refetch()} />
        ) : !c ? (
          <FormSkeleton fields={4} className="p-3" />
        ) : (
          <>
            {tabs.length > 1 && <Tabs id="chat-details" tabs={tabs} value={shown} onChange={(t) => onTab(t as DetailsTab)} />}
            <TabPanel id="chat-details" tab={shown}>
              <div className="p-3">
                {shown === "general" && <General c={c} />}
                {shown === "personal" && <Personal c={c} />}
                {shown === "members" && <Members c={c} />}
              </div>
            </TabPanel>
          </>
        )}
      </div>
    </aside>
  );
}

/** Replaces what the screens know of the channel with what the server answered. */
function useRemember(id: string) {
  const qc = useQueryClient();
  return (c: Channel) => {
    qc.setQueryData(keys.channel(id), c);
    void qc.invalidateQueries({ queryKey: keys.channels });
  };
}

function General({ c }: { c: Channel }) {
  const owner = c.role === "Owner";
  const remember = useRemember(c.id);
  const ids = useId();
  const [name, setName] = useState(c.name);
  const [topic, setTopic] = useState(c.topic ?? "");
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // One change at a time; a refusal is told next to the field it came from.
  const save = async (field: string, body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      remember(await api.patch<Channel>(`${CHAT}/channels/${c.id}`, body));
      if (done) toast(done);
    } catch (e) {
      setProblem({ field, message: errorMessage(e) });
      if (field === "name") setName(c.name);
      if (field === "topic") setTopic(c.topic ?? "");
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    const on = !c.archived;
    const ok = await confirmDialog({
      title: on ? tr("Archive #{name}?", { name: c.name }) : tr("Bring back #{name}?", { name: c.name }),
      message: on ? tr("Nobody can post in an archived channel. Its messages stay readable and it can be brought back.") : tr("Members can post again."),
      confirmLabel: on ? tr("Archive") : tr("Bring back"),
      danger: on,
    });
    if (ok) await save("archived", { archived: on }, on ? "Archived" : tr("Brought back"));
  };
  const type = async (to: "Public" | "Private") => {
    if (to === c.type) return;
    const ok = await confirmDialog({
      title: to === "Private" ? tr("Make it private?") : tr("Make it public?"),
      message: to === "Private" ? tr("Only its members will be able to find and read it.") : tr("Anyone in the workspace will be able to find, read and join it."),
      confirmLabel: to === "Private" ? tr("Make private") : tr("Make public"),
    });
    if (ok) await save("type", { type: to }, tr("Updated"));
  };
  const problemFor = (field: string) =>
    problem?.field === field ? (
      <p role="alert" className="text-xs text-destructive">
        {isolate(problem.message)}
      </p>
    ) : null;

  return (
    <div className="grid gap-4 text-sm">
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-name`}>{tr("Name")}</Label>
        {owner ? (
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={80}
            disabled={busy}
            aria-invalid={problem?.field === "name" || undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== c.name && void save("name", { name: name.trim() }, tr("Renamed"))}
          />
        ) : (
          <p>#{isolate(c.name)}</p>
        )}
        {problemFor("name")}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-topic`}>{tr("Topic")}</Label>
        {owner ? (
          <Textarea
            id={`${ids}-topic`}
            rows={2}
            maxLength={500}
            value={topic}
            disabled={busy}
            placeholder={tr("What is this channel for?")}
            onChange={(e) => setTopic(e.target.value)}
            onBlur={() => topic.trim() !== (c.topic ?? "") && void save("topic", { topic: topic.trim() || null })}
          />
        ) : (
          <p className={c.topic ? undefined : "text-muted-foreground"}>{c.topic || tr("No topic yet.")}</p>
        )}
        {problemFor("topic")}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-type`}>{tr("Who can find it")}</Label>
        {owner ? (
          <select id={`${ids}-type`} className="h-(--control-h) rounded-md border border-input bg-card px-2 text-sm" value={c.type} disabled={busy} onChange={(e) => void type(e.target.value as "Public" | "Private")}>
            <option value="Public">{tr("Anyone in the workspace")}</option>
            <option value="Private">{tr("Only its members")}</option>
          </select>
        ) : (
          <p>{c.type === "Private" ? tr("Only its members") : tr("Anyone in the workspace")}</p>
        )}
        {problemFor("type")}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-post`}>{tr("Who can post")}</Label>
        {owner ? (
          <select
            id={`${ids}-post`}
            className="h-(--control-h) rounded-md border border-input bg-card px-2 text-sm"
            value={c.post_policy === "Owners" ? "Owners" : "Members"}
            disabled={busy}
            onChange={(e) => void save("post_policy", { post_policy: e.target.value }, tr("Updated"))}
          >
            <option value="Members">{tr("Every member")}</option>
            <option value="Owners">{tr("Only owners start posts (members reply in threads)")}</option>
          </select>
        ) : (
          <p>{c.post_policy === "Owners" ? tr("Only owners start posts; members reply in threads") : tr("Every member")}</p>
        )}
        {problemFor("post_policy")}
      </div>
      <p className="rounded-md bg-muted px-3 py-2 text-muted-foreground">{isolate(accessText(c))}</p>
      {owner && (
        <div className="grid gap-1.5 border-t pt-3">
          <Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => void archive()}>
            {c.archived ? tr("Bring this channel back") : tr("Archive this channel")}
          </Button>
          {problemFor("archived")}
        </div>
      )}
      {!owner && c.role && <p className="text-xs text-muted-foreground">{tr("Only the channel's owners can change these.")}</p>}
    </div>
  );
}

function Personal({ c }: { c: Channel }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const base = useContext(Base);
  const ids = useId();
  const direct = c.type === "Direct";
  const level = loudness(c);
  const member = !!c.role;
  const usual: Loud = direct ? "All" : "Mentions";

  const set = async (to: Loud | null) => {
    const before = qc.getQueryData<Channel>(keys.channel(c.id));
    qc.setQueryData<Channel>(keys.channel(c.id), { ...c, notify_level: to });
    try {
      await api.put(`${CHAT}/channels/${c.id}/notify`, { level: to });
      void qc.invalidateQueries({ queryKey: keys.channels });
      if (to === "Nothing") toast(tr("Muted: no notifications from this conversation"));
    } catch (e) {
      if (before) qc.setQueryData(keys.channel(c.id), before);
      toast(errorMessage(e), "error");
    }
  };
  const leave = async () => {
    const ok = await confirmDialog({
      title: tr("Leave #{name}?", { name: c.name }),
      message: c.type === "Private" ? tr("You will not be able to read it again unless someone adds you.") : tr("You can join it again whenever you like."),
      confirmLabel: tr("Leave"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`${CHAT}/channels/${c.id}/leave`, {});
      void qc.invalidateQueries({ queryKey: ["chat"] });
      navigate(base);
      toast(tr("You left #{name}", { name: c.name }));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (!member) return <p className="text-sm text-muted-foreground">{tr("Join the channel to choose how it tells you of new messages.")}</p>;
  return (
    <div className="grid gap-4 text-sm">
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-medium">{tr("Tell me about")}</legend>
        {LOUDNESS.map((o) => (
          <label key={o.value} htmlFor={`${ids}-${o.value}`} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 pointer-coarse:min-h-11", level === o.value && "border-primary bg-primary-soft")}>
            <input id={`${ids}-${o.value}`} className="mt-0.5" type="radio" name={`${ids}-loud`} checked={level === o.value} onChange={() => void set(o.value)} />
            <span>
              <span className="block font-medium">{isolate(o.label)}</span>
              <span className="block text-xs text-muted-foreground">{isolate(o.hint)}</span>
            </span>
          </label>
        ))}
        {c.notify_level && c.notify_level !== usual && (
          <Button variant="link" size="xs" className="justify-self-start p-0" onClick={() => void set(null)}>
            {(direct ? tr("Back to the usual for a direct message") : tr("Back to the usual for a channel"))}
          </Button>
        )}
      </fieldset>
      {!direct && (
        <div className="border-t pt-3">
          <Button variant="outline" onClick={() => void leave()}>
            {tr("Leave this channel")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Members({ c }: { c: Channel }) {
  const qc = useQueryClient();
  const me = useMe().data?.user.email.toLowerCase() ?? "";
  const people = usePeople().data?.users ?? [];
  const owner = c.role === "Owner";
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState("");
  const ids = useId();
  const rows = memberRows(c.members, filter);
  const offered = adding.trim() ? addable(people, c.members, adding) : [];
  const owners = c.members.filter((m) => m.role === "Owner").length;

  // The list changes at once; if the server refuses, it goes back with the server's reason.
  const change = async (body: { add?: string[]; remove?: string[]; promote?: string[]; demote?: string[] }, apply: (members: Member[]) => Member[]) => {
    const before = qc.getQueryData<Channel>(keys.channel(c.id));
    qc.setQueryData<Channel>(keys.channel(c.id), { ...c, members: apply(c.members) });
    try {
      const out = await api.post<Channel>(`${CHAT}/channels/${c.id}/members`, body);
      qc.setQueryData(keys.channel(c.id), out);
      void qc.invalidateQueries({ queryKey: keys.channels });
    } catch (e) {
      if (before) qc.setQueryData(keys.channel(c.id), before);
      toast(errorMessage(e), "error");
    }
  };
  const add = (email: string) => {
    const p = people.find((x) => x.email.toLowerCase() === email.toLowerCase());
    setAdding("");
    void change({ add: [email] }, (ms) => [...ms, { email, full_name: p?.full_name ?? null, role: "Member" }]);
  };
  const remove = async (m: Member) => {
    const ok = await confirmDialog({ title: tr("Remove {value}?", { value: m.full_name || m.email }), message: tr("They will no longer be in #{name}{value}.", { name: c.name, value: c.type === "Private" ? tr(" or able to read it") : "" }), confirmLabel: tr("Remove"), danger: true });
    if (ok) void change({ remove: [m.email] }, (ms) => ms.filter((x) => x.email !== m.email));
  };
  const role = (m: Member, to: "Owner" | "Member") =>
    void change(to === "Owner" ? { promote: [m.email] } : { demote: [m.email] }, (ms) => ms.map((x) => (x.email === m.email ? { ...x, role: to } : x)));

  return (
    <div className="grid gap-3 text-sm">
      {!c.role && <p className="rounded-md bg-muted px-3 py-2 text-muted-foreground">{tr("You are reading a public channel. Join it to post.")}</p>}
      {c.type === "Private" && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5" aria-hidden="true" /> {tr("Private: only these people can read it.")}
        </p>
      )}
      {owner && (
        <div className="relative grid gap-1.5">
          <Label htmlFor={`${ids}-add`}>{tr("Add people")}</Label>
          <Input id={`${ids}-add`} value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={tr("Name or email")} autoComplete="off" />
          {adding.trim() && (
            <ul className="rounded-md border bg-popover p-1" aria-label={tr("People to add")}>
              {offered.map((p) => (
                <li key={p.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-accent pointer-coarse:min-h-11" onClick={() => add(p.email)}>
                    <Plus className="size-4 shrink-0" aria-hidden="true" />
                    <span className="font-medium">{p.full_name || p.email}</span>
                    <span className="truncate text-xs text-muted-foreground">{isolate(p.email)}</span>
                  </button>
                </li>
              ))}
              {!offered.length && <li className="px-2 py-1.5 text-muted-foreground">{tr("Nobody to add matches “")}{isolate(adding.trim())}”.</li>}
            </ul>
          )}
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-find`}>
          {c.members.length} {c.members.length === 1 ? tr("member") : tr("members")}
        </Label>
        <Input id={`${ids}-find`} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr("Find a member")} />
      </div>
      <ul className="grid gap-1" aria-label={tr("Members")}>
        {rows.map((m) => {
          const you = m.email.toLowerCase() === me;
          return (
            <li key={m.email} className="flex items-center gap-2 rounded-md px-1 py-1 pointer-coarse:min-h-11">
              <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary" aria-hidden="true">
                {isolate(initials(m.full_name || m.email))}
                {m.active && <span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-success" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {m.full_name || m.email}
                  {you && <span className="font-normal text-muted-foreground"> {tr("(you)")}</span>}
                </span>
                {(m.full_name || m.active) && (
                  <span className="block truncate text-xs text-muted-foreground">{isolate([m.active && tr("Active now"), m.full_name && m.email].filter(Boolean).join(" · "))}</span>
                )}
              </span>
              {m.role === "Owner" && <Badge variant="secondary">{tr("Owner")}</Badge>}
              {owner && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={tr("Actions for {value}", { value: m.full_name || m.email })}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {m.role === "Owner" ? (
                      <DropdownMenuItem disabled={owners < 2} onSelect={() => role(m, "Member")}>
                        {owners < 2 ? tr("The only owner") : tr("Remove as owner")}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => role(m, "Owner")}>{tr("Make an owner")}</DropdownMenuItem>
                    )}
                    {!you && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => void remove(m)}>{tr("Remove from channel")}</DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="py-2 text-muted-foreground">{tr("Nobody here matches “")}{isolate(filter.trim())}”.</li>}
      </ul>
    </div>
  );
}
