// Blocked senders: mail from those addresses goes to Spam, where the server's own filter also learns
// from it. They live in Mail's one Sieve script (lib/filters.ts, lib/mailData.ts) with the filters.

import type { Mailbox } from "./mail";
import { changeMailData, readMailData } from "./mailData";

export interface BlockState {
  blocked: string[];
  /** Whether Mail's script is the one the server runs. */
  active: boolean;
  /** The name of the person's own script that is the active one: then the list cannot work. */
  otherActive?: string;
}

export async function readBlocked(account: string): Promise<BlockState> {
  const s = await readMailData(account);
  return { blocked: s.data.blocked, active: s.active, otherActive: s.otherActive?.name };
}

/** Writes the list. Resolves to the state as it is now. */
export async function writeBlocked(account: string, addresses: string[], boxes: Mailbox[]): Promise<BlockState> {
  const s = await changeMailData(account, boxes, (d) => ({ ...d, blocked: [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))] }));
  return { blocked: s.data.blocked, active: s.active, otherActive: s.otherActive?.name };
}
