// The one Sieve script Mail owns on the person's mailbox (JMAP SieveScript, RFC 9661), and what it
// carries: blocked senders, the person's filters (rules), whether the vacation reply runs through it,
// and the person's Mail settings (kept on the server, so they follow the person). Everything Mail
// needs back is one JSON line in a comment at the top (`# ferrum: {...}`), the rules below it are
// generated from that line, so a regenerated script never loses a rule. Pure: no requests here
// (lib/mailData.ts reads and writes it).

/** The script's name on the server; wave 1 named it after blocked senders only. */
export const SCRIPT_NAME = "ferrum-mail";
export const OLD_SCRIPT_NAME = "ferrum-blocked-senders";
/** The script Stalwart writes for the JMAP vacation reply: not the person's own hand-written one. */
export const VACATION_SCRIPT = "vacation";

const DATA = "# ferrum: ";
const BLOCKED = "# blocked: ";

/** What a filter looks at; every condition given must hold. */
export interface When {
  from?: string;
  to?: string;
  subject?: string;
  /** Has the words: in the subject or the body. */
  words?: string;
  /** The mailing list's id (List-Id), or part of it. */
  list?: string;
  /** Larger than, in bytes. */
  larger?: number;
  /** Smaller than, in bytes. */
  smaller?: number;
}

/** What a filter does with mail that matches. */
export interface Then {
  /** Skip the inbox (to Archive, unless a folder is given). */
  skipInbox?: boolean;
  /** A folder's id: the mail goes there (and stays in the inbox too unless `skipInbox`). */
  folder?: string;
  star?: boolean;
  read?: boolean;
  /** Forward a copy to this address. */
  forward?: string;
  /** To Trash. */
  trash?: boolean;
  /** Never to Spam: kept in the inbox even when the spam filter would file it away. */
  neverSpam?: boolean;
}

export interface Rule {
  id: string;
  on: boolean;
  when: When;
  then: Then;
}

/** The person's Mail settings kept on the server (the defaults apply to what is missing). */
export interface Prefs {
  undoSeconds?: number;
  signatureInReplies?: boolean;
  /** "reply" or "replyAll": what Enter on a message and the first button do. */
  replyDefault?: "reply" | "replyAll";
  conversations?: boolean;
  density?: "comfortable" | "compact";
  pane?: "right" | "below" | "off";
  shortcuts?: boolean;
  sendArchive?: boolean;
  /** Which new mail notifies: all in the inbox, only from people written to, none. */
  notify?: "all" | "people" | "none";
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
}

/** Everything Mail keeps in its script. */
export interface MailData {
  v: 1;
  blocked: string[];
  rules: Rule[];
  prefs: Prefs;
  saved: SavedSearch[];
  /** Custom folders' colours by mailbox id: a name from `FOLDER_COLORS`. */
  colors: Record<string, string>;
  /** The vacation reply is on and runs from this script (Stalwart lets one script run at a time). */
  vacation: boolean;
}

export const EMPTY_DATA: MailData = { v: 1, blocked: [], rules: [], prefs: {}, saved: [], colors: {}, vacation: false };

/** The colours a folder may take: the kit's own tones, so they follow the theme. */
export const FOLDER_COLORS = ["primary", "success", "warning", "destructive", "purple", "muted"] as const;

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== false)) as T;

/** A rule as typed or read back, with only what a rule may hold (values trimmed to one line). */
export function cleanRule(r: Partial<Rule> & { when?: Partial<When>; then?: Partial<Then> }): Rule {
  const w = r.when ?? {};
  const t = r.then ?? {};
  return {
    id: id(r.id) ?? Math.random().toString(36).slice(2, 10),
    on: r.on !== false,
    when: clean({ from: str(w.from), to: str(w.to), subject: str(w.subject), words: str(w.words), list: str(w.list), larger: num(w.larger), smaller: num(w.smaller) }),
    then: clean({ skipInbox: !!t.skipInbox, folder: id(t.folder), star: !!t.star, read: !!t.read, forward: str(t.forward, 254)?.toLowerCase(), trash: !!t.trash, neverSpam: !!t.neverSpam }),
  };
}

export const hasCondition = (w: When) => Object.keys(w).length > 0;
export const hasAction = (t: Then) => Object.keys(t).length > 0;

/** The data line read back: anything malformed is dropped, never trusted. */
export function parseData(script: string | null | undefined): MailData {
  const lines = (script ?? "").split(/\r?\n/);
  const line = lines.find((l) => l.startsWith(DATA));
  let raw: Partial<MailData> = {};
  try {
    raw = line ? (JSON.parse(line.slice(DATA.length)) as Partial<MailData>) : {};
  } catch {
    raw = {};
  }
  // A wave-1 script lists blocked senders on lines of their own.
  const legacy = lines.filter((l) => l.startsWith(BLOCKED)).map((l) => l.slice(BLOCKED.length).trim());
  const blocked = [...new Set([...(Array.isArray(raw.blocked) ? raw.blocked : []), ...legacy].map((a) => str(a, 254)?.toLowerCase()).filter((a): a is string => !!a && a.includes("@")))];
  const p = (raw.prefs ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, ok: readonly T[]) => (ok.includes(v as T) ? (v as T) : undefined);
  const prefs: Prefs = clean({
    undoSeconds: typeof p.undoSeconds === "number" && p.undoSeconds >= 0 && p.undoSeconds <= 60 ? Math.floor(p.undoSeconds) : undefined,
    replyDefault: pick(p.replyDefault, ["reply", "replyAll"] as const),
    density: pick(p.density, ["comfortable", "compact"] as const),
    pane: pick(p.pane, ["right", "below", "off"] as const),
    notify: pick(p.notify, ["all", "people", "none"] as const),
  });
  for (const k of ["signatureInReplies", "conversations", "shortcuts", "sendArchive"] as const) if (typeof p[k] === "boolean") prefs[k] = p[k] as boolean;
  return {
    v: 1,
    blocked,
    rules: (Array.isArray(raw.rules) ? raw.rules : []).slice(0, 200).map((r) => cleanRule(r as Rule)).filter((r) => hasCondition(r.when) && hasAction(r.then)),
    prefs,
    saved: (Array.isArray(raw.saved) ? raw.saved : [])
      .slice(0, 50)
      .map((s) => ({ id: id((s as SavedSearch).id) ?? "", name: str((s as SavedSearch).name, 80) ?? "", query: str((s as SavedSearch).query) ?? "" }))
      .filter((s) => s.id && s.name && s.query),
    colors: Object.fromEntries(Object.entries(raw.colors && typeof raw.colors === "object" ? raw.colors : {}).filter(([k, v]) => id(k) && (FOLDER_COLORS as readonly string[]).includes(v as string))) as Record<string, string>,
    vacation: raw.vacation === true,
  };
}

/** A Sieve quoted string (RFC 5228 §2.4.2): backslash and double quote escaped; nothing in it is ever code. Control characters never get in. */
export const sieveString = (s: string) => `"${s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\"]/g, "\\$&")}"`;

/** Where to file into: by the folder's id (the `mailboxid` extension, so a renamed folder still works), with its name as the fallback. */
export interface Target {
  id: string;
  name: string;
}

export interface Folders {
  inbox?: Target;
  junk?: Target;
  trash?: Target;
  archive?: Target;
  /** The person's folders by id. */
  byId: Record<string, Target>;
}

const fileinto = (t: Target, copy = false) => `fileinto${copy ? " :copy" : ""} :mailboxid ${sieveString(t.id)} ${sieveString(t.name)};`;

/** Mail the spam filter thinks is spam (Stalwart: 50% and over, as it files to Spam): left to it, so filters never star, file or forward spam. */
const NOT_SPAM = 'not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50"';

/** The tests of a rule (all must hold). */
export function ruleTests(w: When): string[] {
  const out: string[] = [];
  if (w.from) out.push(`header :contains "from" ${sieveString(w.from)}`);
  if (w.to) out.push(`header :contains ["to", "cc"] ${sieveString(w.to)}`);
  if (w.subject) out.push(`header :contains "subject" ${sieveString(w.subject)}`);
  if (w.words) out.push(`anyof (header :contains "subject" ${sieveString(w.words)}, body :text :contains ${sieveString(w.words)})`);
  if (w.list) out.push(`header :contains "list-id" ${sieveString(w.list)}`);
  if (w.larger) out.push(`size :over ${Math.floor(w.larger)}`);
  if (w.smaller) out.push(`size :under ${Math.floor(w.smaller)}`);
  return out;
}

/** A rule's actions, flags before filing (so they reach the copy filed). */
export function ruleActions(t: Then, f: Folders): string[] {
  const out: string[] = [];
  if (t.star) out.push('addflag "\\\\Flagged";');
  if (t.read) out.push('addflag "\\\\Seen";');
  if (t.forward) out.push(`redirect :copy ${sieveString(t.forward)};`);
  if (t.trash && f.trash) out.push(fileinto(f.trash));
  else {
    const folder = t.folder ? f.byId[t.folder] : undefined;
    if (folder) out.push(fileinto(folder, !t.skipInbox));
    else if (t.skipInbox && f.archive) out.push(fileinto(f.archive));
    // Filing anywhere (a :copy too) keeps it out of Spam; with nothing else to do it is filed to the inbox.
    else if (t.neverSpam && f.inbox) out.push(fileinto(f.inbox));
  }
  return out;
}

/** Whether the script has anything to run (else it only keeps Mail's data and need not be the active one). */
export const runs = (d: MailData) => d.blocked.length > 0 || d.rules.some((r) => r.on);

/** The whole script for Mail's data. */
export function buildScript(d: MailData, f: Folders): string {
  const data: MailData = { ...d, blocked: [...new Set(d.blocked.map((a) => a.trim().toLowerCase()).filter(Boolean))] };
  const rules = data.rules.filter((r) => r.on && hasCondition(r.when) && hasAction(r.then));
  const body: string[] = [];
  if (data.blocked.length && f.junk) body.push(`# Blocked senders go to Spam.`, `if address :is "from" [${data.blocked.map(sieveString).join(", ")}] { ${fileinto(f.junk)} stop; }`);
  for (const r of rules) {
    const tests = [...ruleTests(r.when), ...(r.then.neverSpam ? [] : [NOT_SPAM])];
    const actions = ruleActions(r.then, f);
    if (!actions.length) continue;
    body.push(`# Filter ${r.id}`, `if allof (${tests.join(", ")}) {`, ...actions.map((a) => `  ${a}`), "}");
  }
  // The vacation reply answers what is not spam (never a spammer).
  if (data.vacation) body.push("# The vacation reply (Mail settings), not to spam.", `if ${NOT_SPAM} { include :personal :optional ${sieveString(VACATION_SCRIPT)}; }`);
  const text = body.join("\n");
  const need = ["fileinto", "mailboxid", "copy", "imap4flags", "body", "relational", "spamtest", "spamtestplus", "comparator-i;ascii-numeric", "include"].filter((ext) => {
    if (ext === "fileinto" || ext === "mailboxid") return /fileinto/.test(text);
    if (ext === "copy") return /:copy/.test(text);
    if (ext === "imap4flags") return /addflag/.test(text);
    if (ext === "body") return /body :text/.test(text);
    if (ext === "include") return /include :personal/.test(text);
    return /spamtest/.test(text);
  });
  return [
    "# Ferrum Mail: blocked senders, filters and settings, made by Mail. Change them in Mail settings; edits here are overwritten.",
    DATA + JSON.stringify(data),
    ...(need.length ? [`require [${need.map(sieveString).join(", ")}];`] : []),
    text,
    "",
  ].join("\n");
}

// ───────────────────────────── checks on what is typed ─────────────────────────────

/** Why a rule cannot be kept, or null. `own` are the person's own addresses (no forwarding to oneself). */
export function ruleProblem(r: Rule, own: string[], others: Rule[]): string | null {
  if (!hasCondition(r.when)) return "condition";
  if (!hasAction(r.then)) return "action";
  if (r.then.forward) {
    if (!/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(r.then.forward)) return "address";
    if (own.some((a) => a.toLowerCase() === r.then.forward)) return "loop";
    // The mail server forwards a message to one address at most (maxNumberRedirects 1).
    if (others.some((o) => o.id !== r.id && o.on && o.then.forward)) return "one-forward";
  }
  return null;
}

/** The addresses mail is being forwarded to (for the banner that says so). */
export const forwardsTo = (d: MailData) => [...new Set(d.rules.filter((r) => r.on && r.then.forward).map((r) => r.then.forward!))];

/** A filter from a message: its sender. */
export const ruleFromSender = (email: string): Rule => cleanRule({ when: { from: email }, then: {} });

/** A filter from a search: what the query says that a filter can test. */
export function ruleFromQuery(terms: { op: string | null; value: string; negated: boolean; or: boolean }[]): Rule {
  const w: When = {};
  const words: string[] = [];
  for (const t of terms) {
    if (t.negated || t.or) continue;
    if ((t.op === "from" || t.op === "to" || t.op === "subject" || t.op === "list") && !w[t.op]) w[t.op] = t.value;
    else if (!t.op) words.push(t.value.replace(/^"|"$/g, ""));
  }
  if (words.length) w.words = words.join(" ");
  return cleanRule({ when: w, then: {} });
}

/** What a rule looks at, for the list (JMAP filter of the same mail, for "also apply to matching mail now"). */
export function ruleQuery(w: When): Record<string, unknown> {
  const c: Record<string, unknown>[] = [];
  if (w.from) c.push({ from: w.from });
  if (w.to) c.push({ operator: "OR", conditions: [{ to: w.to }, { cc: w.to }] });
  if (w.subject) c.push({ subject: w.subject });
  if (w.words) c.push({ text: w.words });
  if (w.list) c.push({ header: ["List-Id", w.list] });
  if (w.larger) c.push({ minSize: w.larger });
  if (w.smaller) c.push({ maxSize: w.smaller });
  return c.length === 1 ? c[0]! : { operator: "AND", conditions: c };
}

/** The JMAP patch "apply now" sends to a message already in the mailbox for a rule's actions (forwarding is never done to old mail). */
export function rulePatch(t: Then, f: Folders, from: Record<string, boolean>): Record<string, unknown> | null {
  const p: Record<string, unknown> = {};
  if (t.star) p["keywords/$flagged"] = true;
  if (t.read) p["keywords/$seen"] = true;
  const inbox = f.inbox?.id;
  if (t.trash && f.trash) p.mailboxIds = { [f.trash.id]: true };
  else if (t.folder && f.byId[t.folder]) {
    if (t.skipInbox) p.mailboxIds = { ...Object.fromEntries(Object.keys(from).filter((k) => k !== inbox).map((k) => [k, true])), [t.folder]: true };
    else p[`mailboxIds/${t.folder}`] = true;
  } else if (t.skipInbox && f.archive && inbox && from[inbox]) {
    p[`mailboxIds/${inbox}`] = null;
    p[`mailboxIds/${f.archive.id}`] = true;
  }
  if (t.neverSpam && f.junk && from[f.junk.id] && inbox) {
    p[`mailboxIds/${f.junk.id}`] = null;
    p[`mailboxIds/${inbox}`] = true;
    p["keywords/$junk"] = null;
    p["keywords/$notjunk"] = true;
  }
  // A whole-mailboxIds patch and a path patch of the same property cannot go together.
  if (p.mailboxIds) for (const k of Object.keys(p)) if (k.startsWith("mailboxIds/")) delete p[k];
  return Object.keys(p).length ? p : null;
}
