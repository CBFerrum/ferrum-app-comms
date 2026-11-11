// Reading and writing Mail's own Sieve script (lib/filters.ts says what is in it). One script per
// mailbox runs at a time on the mail server, so: ours is made the active one only when it has
// something to run and no script the person wrote is the active one (theirs is never displaced
// without them asking); the vacation reply, which Stalwart keeps as a script of its own and runs by
// making it the active one, is run from ours (`include`) while ours has filters. Writes are
// conditional on the scripts' state (ifInState), so two tabs never lose each other's change.

import { fetchBlob, queryString, request } from "@ferrum/client";
import { MAIL, byRole, inTurn, jmap, type Mailbox } from "./mail";
import { EMPTY_DATA, OLD_SCRIPT_NAME, SCRIPT_NAME, VACATION_SCRIPT, buildScript, parseData, runs, type Folders, type MailData } from "./filters";
import { folderName } from "./folders";

interface Script {
  id: string;
  name: string;
  blobId: string;
  isActive: boolean;
}

export interface MailState {
  data: MailData;
  /** Our script, once it exists. */
  scriptId?: string;
  /** Whether ours is the one the server runs. */
  active: boolean;
  /** A script the person wrote (not ours, not the vacation reply's) that is the active one: ours cannot run. */
  otherActive?: { id: string; name: string };
  /** The vacation reply's own script is the active one. */
  vacationActive: boolean;
  /** The scripts' state, for a conditional write. */
  state: string;
}

const blobText = (account: string, blobId: string, name: string) =>
  inTurn(async () => (await fetchBlob(`${MAIL}/blob/${account}/${blobId}${queryString({ name, type: "application/sievescript" })}`)).text());

/** A script's text (for showing the person's own one, read-only). */
export const scriptText = (account: string, blobId: string) => blobText(account, blobId, "script.sieve");

async function scripts(account: string): Promise<{ list: Script[]; state: string }> {
  const r = await jmap([["SieveScript/get", { accountId: account }, "s"]]);
  return { list: (r.s.list as Script[]) ?? [], state: String(r.s.state ?? "") };
}

export async function readMailData(account: string): Promise<MailState & { blobId?: string; others: Script[] }> {
  const { list, state } = await scripts(account);
  const ours = list.find((s) => s.name === SCRIPT_NAME) ?? list.find((s) => s.name === OLD_SCRIPT_NAME);
  const other = list.find((s) => s.isActive && s !== ours && s.name !== VACATION_SCRIPT);
  const data = ours ? parseData(await blobText(account, ours.blobId, "mail.sieve")) : { ...EMPTY_DATA };
  return {
    data,
    scriptId: ours?.id,
    blobId: ours?.blobId,
    active: !!ours?.isActive,
    otherActive: other ? { id: other.id, name: other.name } : undefined,
    vacationActive: list.some((s) => s.isActive && s.name === VACATION_SCRIPT),
    state,
    others: list.filter((s) => s !== ours),
  };
}

/** Where rules file mail, from the folder list. */
export function foldersOf(boxes: Mailbox[]): Folders {
  const t = (b: Mailbox | undefined) => (b ? { id: b.id, name: b.name } : undefined);
  return { inbox: t(byRole(boxes, "inbox")), junk: t(byRole(boxes, "junk")), trash: t(byRole(boxes, "trash")), archive: t(byRole(boxes, "archive")), byId: Object.fromEntries(boxes.map((b) => [b.id, { id: b.id, name: b.name }])) };
}

export class Conflict extends Error {}

/**
 * Changes Mail's data and writes the script again: read, change, write if nothing changed meanwhile
 * (tried again a few times when another tab wrote first). `opts.takeOver` makes ours the active one
 * even when the person's own script is (only when they asked). Resolves to the state as it is now.
 */
export async function changeMailData(account: string, boxes: Mailbox[], change: (d: MailData, s: MailState) => MailData, opts: { takeOver?: boolean } = {}): Promise<MailState> {
  for (let attempt = 0; ; attempt++) {
    const now = await readMailData(account);
    let data = change(structuredClone(now.data), now);
    const mayRun = runs(data) && (!now.otherActive || !!opts.takeOver);
    // The vacation reply runs from ours while ours runs, else from its own script.
    if (!mayRun && data.vacation) data = { ...data, vacation: false };
    if (mayRun && now.vacationActive) data = { ...data, vacation: true };
    const text = buildScript(data, foldersOf(boxes));
    const up = await inTurn(() => request<{ blobId: string }>(`${MAIL}/upload/${account}`, { method: "POST", body: new Blob([text], { type: "application/sievescript" }) }));
    const calls: [string, Record<string, unknown>, string][] = [];
    const activate = mayRun ? { onSuccessActivateScript: now.scriptId ?? "#s" } : {};
    if (now.scriptId) calls.push(["SieveScript/set", { accountId: account, ifInState: now.state, update: { [now.scriptId]: { name: SCRIPT_NAME, blobId: up.blobId } }, ...activate }, "s"]);
    else calls.push(["SieveScript/set", { accountId: account, ifInState: now.state, create: { s: { name: SCRIPT_NAME, blobId: up.blobId } }, ...activate }, "s"]);
    // Ours stops being the active one when it has nothing to run: the vacation reply's own script runs again if it is on.
    let r: Record<string, Record<string, unknown>>;
    try {
      r = await jmap(calls);
    } catch (e) {
      if (/stateMismatch/i.test(String((e as Error).message)) && attempt < 3) continue;
      throw e;
    }
    const failed = Object.values((r.s.notCreated ?? r.s.notUpdated ?? {}) as Record<string, { description?: string; type?: string }>)[0];
    if (failed) throw new Error(failed.description ?? failed.type ?? "The mail server refused the script.");
    const scriptId = now.scriptId ?? (r.s.created as Record<string, { id: string }>).s!.id;
    if (!mayRun && now.active) await jmap([["SieveScript/set", { accountId: account, onSuccessDeactivateScript: true }, "d"]]);
    if (!mayRun && now.active && data.vacation === false && now.data.vacation) await restoreVacation(account);
    return { data, scriptId, active: mayRun, otherActive: mayRun ? undefined : now.otherActive, vacationActive: false, state: "" };
  }
}

/** The vacation reply ran from ours; ours stopped: its own script runs again. */
async function restoreVacation(account: string) {
  const { list } = await scripts(account);
  const v = list.find((s) => s.name === VACATION_SCRIPT);
  if (v) await jmap([["SieveScript/set", { accountId: account, onSuccessActivateScript: v.id }, "v"]]);
}

/** Whether the vacation reply is on, wherever it runs from. */
export const vacationOn = (s: MailState, jmapEnabled: boolean) => jmapEnabled || s.vacationActive || (s.active && s.data.vacation);

/**
 * After the vacation reply was saved through JMAP (which makes its own script the active one when on):
 * when ours has filters, ours runs again and runs the reply too; when the reply was turned off, ours
 * stops running it.
 */
export async function afterVacation(account: string, boxes: Mailbox[], on: boolean): Promise<MailState | null> {
  const now = await readMailData(account);
  // No filters: the reply's own script does it alone, nothing of ours to change.
  if (!runs(now.data) && !now.data.vacation) return null;
  return changeMailData(account, boxes, (d) => ({ ...d, vacation: on }));
}

export const junkName = (boxes: Mailbox[]) => folderName(byRole(boxes, "junk") ?? { name: "Junk Mail", role: null });
