import { t } from "@ferrum/client";
// The health of the workspace's mail domain (Comms' `/api/app/comms/domain`, for managers): which
// DNS records mail needs, which are published, and what to do about the rest.

export const DOMAIN = "/api/app/comms/domain";

export type Status = "ok" | "missing" | "differs" | "unknown";

export interface Check {
  id: string;
  title: string;
  importance: "required" | "recommended" | "optional";
  why: string;
  kind: string;
  name: string;
  /** What to publish. */
  expected: string;
  /** What is published now. */
  found: string[];
  status: Status;
  note: string | null;
  fix: string | null;
}

export interface Health {
  /** None while the workspace has no mail domain. */
  domain: string | null;
  hosted: boolean;
  mailboxes?: number;
  shared?: number;
  synced_at?: string | null;
  /** Where the records to publish came from: the mail server's own list, else what any domain needs. */
  source?: "mail server" | "defaults";
  note?: string | null;
  checked_at?: string;
  checks?: Check[];
  summary?: { ok: number; total: number; required_wrong: number };
  zone?: string;
  manual?: { id: string; title: string; how: string }[];
}

/** What a status says, in a word or two. */
export const STATUS: Record<Status, string> = { get ok() { return t("OK"); }, get missing() { return t("Missing"); }, get differs() { return t("Differs"); }, get unknown() { return t("Could not check"); } };

/** The one sentence at the top: how many checks pass, and whether what mail needs is wrong. */
export function headline(h: Pick<Health, "summary">): string {
  const s = h.summary;
  if (!s || !s.total) return t("There is nothing to check yet.");
  const passing = s.ok === s.total ? t("All {total} checks pass.", { total: s.total }) : t("{ok} of {total} checks pass.", { ok: s.ok, total: s.total });
  if (s.required_wrong === 0) return passing;
  return (s.required_wrong === 1 ? t("{passing} One record that mail needs is missing or wrong, so mail from this domain is likely to land in spam.", { passing }) : t("{passing} {count} records that mail needs are missing or wrong, so mail from this domain is likely to land in spam.", { passing, count: s.required_wrong }));
}

/** The checks to list: all, or those that are not right (what could not be checked included). */
export const shown = (checks: Check[], onlyProblems: boolean) => (onlyProblems ? checks.filter((c) => c.status !== "ok") : checks);

/** The name of the zone file to download. */
export const zoneName = (domain: string) => `${domain.replace(/[^a-z0-9.-]/gi, "_")}.zone`;
