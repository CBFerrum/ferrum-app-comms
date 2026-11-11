// Blocked senders, kept as one Sieve script that Mail owns on the person's mailbox (JMAP SieveScript,
// RFC 9661): mail from those addresses goes to Spam, where the server's own filter also learns from
// it. Other scripts of the person are never touched: ours is read, rewritten and activated only when
// no other script is the active one (a mailbox has one active script).

import { fetchBlob, queryString, request } from "@ferrum/client";
import { MAIL, inTurn, jmap } from "./mail";

export const SCRIPT_NAME = "ferrum-blocked-senders";
const MARK = "# blocked: ";

const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** The script for a list of addresses: each one noted in a comment (what Mail reads back) and one rule for all. */
export function blockScript(addresses: string[], junkFolder: string): string {
  const list = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const head = ["# Ferrum Mail: blocked senders. Mail from them goes to Spam. Change the list in Mail settings; edits here are overwritten.", 'require ["fileinto"];', ...list.map((a) => MARK + a)];
  return [...head, ...(list.length ? [`if address :is "from" [${list.map(quoted).join(", ")}] { fileinto ${quoted(junkFolder)}; stop; }`] : []), ""].join("\n");
}

/** The addresses a script of ours lists. */
export const parseBlocked = (script: string): string[] =>
  script
    .split(/\r?\n/)
    .filter((l) => l.startsWith(MARK))
    .map((l) => l.slice(MARK.length).trim())
    .filter(Boolean);

export interface BlockState {
  blocked: string[];
  /** Our script, once it exists. */
  scriptId?: string;
  /** Whether it is the one the server runs. */
  active: boolean;
  /** The name of another script that is the active one: then ours cannot run. */
  otherActive?: string;
}

interface Script {
  id: string;
  name: string;
  blobId: string;
  isActive: boolean;
}

export async function readBlocked(account: string): Promise<BlockState> {
  const r = await jmap([["SieveScript/get", { accountId: account }, "s"]]);
  const scripts = (r.s.list as Script[]) ?? [];
  const ours = scripts.find((s) => s.name === SCRIPT_NAME);
  const other = scripts.find((s) => s.isActive && s.name !== SCRIPT_NAME);
  let blocked: string[] = [];
  if (ours) blocked = parseBlocked(await inTurn(async () => (await fetchBlob(`${MAIL}/blob/${account}/${ours.blobId}${queryString({ name: "blocked.sieve", type: "application/sievescript" })}`)).text()));
  return { blocked, scriptId: ours?.id, active: !!ours?.isActive, otherActive: other?.name };
}

/** Writes the list (an empty one removes our script). The scripts are read again just before, so a script the person made meanwhile is not displaced. Resolves to the state as it is now. */
export async function writeBlocked(account: string, addresses: string[], junkFolder: string): Promise<BlockState> {
  const list = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const found = (((await jmap([["SieveScript/get", { accountId: account }, "s"]])).s.list as Script[]) ?? []);
  const ours = found.find((s) => s.name === SCRIPT_NAME);
  const otherActive = found.find((s) => s.isActive && s.name !== SCRIPT_NAME)?.name;
  if (!list.length) {
    if (ours) await jmap([["SieveScript/set", { accountId: account, update: { [ours.id]: { isActive: false } } }, "a"], ["SieveScript/set", { accountId: account, destroy: [ours.id] }, "b"]]);
    return { blocked: [], active: false, otherActive };
  }
  const up = await inTurn(() => request<{ blobId: string }>(`${MAIL}/upload/${account}`, { method: "POST", body: new Blob([blockScript(list, junkFolder)], { type: "application/sievescript" }) }));
  const activate = !otherActive;
  const r = ours
    ? await jmap([["SieveScript/set", { accountId: account, update: { [ours.id]: { blobId: up.blobId, ...(activate ? { isActive: true } : {}) } } }, "s"]])
    : await jmap([["SieveScript/set", { accountId: account, create: { s: { name: SCRIPT_NAME, blobId: up.blobId } }, ...(activate ? { onSuccessActivateScript: "#s" } : {}) }, "s"]]);
  const failed = Object.values((r.s.notCreated ?? r.s.notUpdated ?? {}) as Record<string, { description?: string; type?: string }>)[0];
  if (failed) throw new Error(failed.description ?? failed.type ?? "The mail server refused the rule.");
  return { blocked: list, scriptId: ours?.id ?? (r.s.created as Record<string, { id: string }>).s!.id, active: activate || !!ours?.isActive, otherActive };
}
