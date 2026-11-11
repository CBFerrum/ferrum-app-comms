// Searching mail as Gmail does: one box, all mail by default, operators (`from:ann has:attachment
// older_than:1y -in:sent "exact words" OR other`) parsed into a JMAP Email/query filter (RFC 8621
// §4.4.1). Pure: the parser never throws, and whatever is typed becomes a well-formed filter or a
// plain sentence saying what could not be understood (then nothing is asked of the server).

import { t as tr } from "@ferrum/client";
import { folderName } from "./folders";
import { byRole, type Mailbox } from "./mail";

/** What one word of the query is. */
export interface Term {
  /** The operator (`from`, `is`…), or null for words to look for anywhere. */
  op: string | null;
  value: string;
  negated: boolean;
  /** Joined to the term before it by OR. */
  or: boolean;
  /** The text it was typed as (a chip removes exactly this). */
  raw: string;
}

/** The longest query taken, and the most terms: past that the rest is left out (a pasted page is not a search). */
export const MAX_QUERY = 500;
export const MAX_TERMS = 40;

const OPERATORS = new Set(["from", "to", "cc", "bcc", "subject", "has", "is", "in", "label", "before", "after", "older", "newer", "older_than", "newer_than", "filename", "larger", "smaller", "list"]);

/** The words of a query: quoted phrases kept whole, `op:value` and `op:"quoted value"` as one, `-` for not, `OR` between two. */
export function tokenize(input: string): Term[] {
  const s = String(input ?? "").slice(0, MAX_QUERY).replace(/[\u0000-\u001f\u007f]/g, " ");
  const out: Term[] = [];
  const re = /(-?)(?:([A-Za-z_]+):)?(?:"([^"]*)"?|(\S+))/g;
  let or = false;
  for (let m: RegExpExecArray | null; (m = re.exec(s)) && out.length < MAX_TERMS; ) {
    const [raw, neg, rawOp, quoted, bare] = m;
    if (!raw.trim()) continue;
    if (!rawOp && quoted === undefined && (bare === "OR" || bare === "|") && !neg) {
      or = out.length > 0;
      continue;
    }
    const op = rawOp && OPERATORS.has(rawOp.toLowerCase()) ? rawOp.toLowerCase() : null;
    // An unknown "word:" stays a word to look for, as typed.
    const value = op ? (quoted ?? bare ?? "") : rawOp ? `${rawOp}:${quoted ?? bare ?? ""}` : (quoted ?? bare ?? "");
    const phrase = !op && quoted !== undefined && !rawOp;
    if (!value.trim()) continue;
    out.push({ op, value: phrase ? `"${value}"` : value, negated: neg === "-", or, raw });
    or = false;
  }
  return out;
}

export interface Scope {
  /** The folders of the mailbox (for `in:` and for leaving Trash and Spam out). */
  boxes: Mailbox[];
  /** Where to look when the query names no folder: everywhere but Trash and Spam (`null`), or a folder's id. */
  folder?: string | null;
  /** Now, for `older_than:` and `newer_than:`. */
  now?: number;
  /** Midnight of a day on the person's clock as a moment (`2026-11-12` → ISO); the browser's zone by default. */
  midnight?: (ymd: string) => string | null;
}

type Filter = Record<string, unknown>;

export interface Built {
  filter: Filter | null;
  /** Why it cannot be searched as typed (an unknown folder, a date that is not one). */
  problems: string[];
  /** The query names a folder itself (`in:`), so the folder chip does not apply. */
  namesFolder: boolean;
}

const localMidnight = (ymd: string): string | null => {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(ymd.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
};

/** `3d`, `2w`, `6m`, `1y` in milliseconds (Gmail's units), or null. */
export function span(v: string): number | null {
  const m = /^(\d{1,4})([dwmy])$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n * { d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 }[m[2]!.toLowerCase() as "d"]!;
}

/** `10M`, `500K`, `2000000` in bytes, or null. */
export function bytes(v: string): number | null {
  const m = /^(\d{1,10})([kmg]?)b?$/i.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * ({ "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2]!.toLowerCase()] ?? 1);
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A folder by what people call it: its role's name in their language or the server's, or its own name. */
export function folderNamed(boxes: Mailbox[], name: string): Mailbox | undefined {
  const n = name.trim().toLowerCase().replace(/^"|"$/g, "");
  const role = { inbox: "inbox", sent: "sent", drafts: "drafts", draft: "drafts", spam: "junk", junk: "junk", trash: "trash", bin: "trash", archive: "archive" }[n];
  return (role && byRole(boxes, role)) || boxes.find((b) => folderName(b).toLowerCase() === n || b.name.toLowerCase() === n);
}

/** One term as a JMAP condition, or a problem in plain words. */
function condition(t: Term, s: Scope): Filter | string {
  const v = t.value.trim();
  const now = s.now ?? Date.now();
  const midnight = s.midnight ?? localMidnight;
  switch (t.op) {
    case null:
      return { text: v };
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
      return { [t.op]: v };
    case "list":
      return { header: ["List-Id", v] };
    case "filename":
      // JMAP has no condition on a file's name: mail with files whose words (names included) have it.
      return { operator: "AND", conditions: [{ hasAttachment: true }, { text: v }] };
    case "has": {
      const k = v.toLowerCase();
      if (k === "attachment" || k === "attachments") return { hasAttachment: true };
      if (k === "star" || k === "yellow-star") return { hasKeyword: "$flagged" };
      return tr("“has:{value}” is not something mail can be searched by.", { value: v });
    }
    case "is": {
      const k = v.toLowerCase();
      if (k === "unread") return { notKeyword: "$seen" };
      if (k === "read") return { hasKeyword: "$seen" };
      if (k === "starred" || k === "flagged") return { hasKeyword: "$flagged" };
      if (k === "answered" || k === "replied") return { hasKeyword: "$answered" };
      return tr("“is:{value}” is not something mail can be searched by.", { value: v });
    }
    case "in":
    case "label": {
      const k = v.toLowerCase();
      if (k === "anywhere" || k === "all" || k === "allmail") return {};
      if (k === "starred") return { hasKeyword: "$flagged" };
      const box = folderNamed(s.boxes, v);
      return box ? { inMailbox: box.id } : tr("There is no folder called “{value}”.", { value: v });
    }
    case "before":
    case "after": {
      const at = midnight(v);
      return at ? { [t.op]: at } : tr("“{value}” is not a date. Write it as 2026/11/30.", { value: v });
    }
    case "older":
    case "newer":
    case "older_than":
    case "newer_than": {
      const ms = span(v);
      if (ms === null) return tr("“{value}” is not a time span. Write it as 3d, 2w, 6m or 1y.", { value: v });
      return t.op.startsWith("older") ? { before: iso(now - ms) } : { after: iso(now - ms) };
    }
    case "larger":
    case "smaller": {
      const b = bytes(v);
      if (b === null) return tr("“{value}” is not a size. Write it as 500K or 10M.", { value: v });
      return t.op === "larger" ? { minSize: b } : { maxSize: b };
    }
    default:
      return { text: v };
  }
}

const and = (conditions: Filter[]): Filter => (conditions.length === 1 ? conditions[0]! : { operator: "AND", conditions });

/** The query as a JMAP filter for Email/query: terms ANDed, `OR` groups, `-` as NOT, and the folder to look in. */
export function buildFilter(input: string | Term[], s: Scope): Built {
  const terms = typeof input === "string" ? tokenize(input) : input;
  const problems: string[] = [];
  const groups: Filter[][] = [];
  let namesFolder = false;
  for (const t of terms) {
    const c = condition(t, s);
    if (typeof c === "string") {
      problems.push(c);
      continue;
    }
    if (t.op === "in" || t.op === "label") namesFolder = true;
    if (!Object.keys(c).length) continue; // in:anywhere
    const one = t.negated ? { operator: "NOT", conditions: [c] } : c;
    if (t.or && groups.length) groups[groups.length - 1]!.push(one);
    else groups.push([one]);
  }
  const anywhere = terms.some((t) => (t.op === "in" || t.op === "label") && /^(anywhere|all|allmail)$/i.test(t.value.trim()));
  const parts = groups.map((g) => (g.length === 1 ? g[0]! : { operator: "OR", conditions: g }));
  if (!namesFolder) {
    if (s.folder) parts.unshift({ inMailbox: s.folder });
    else {
      // All mail, as Gmail's: everything but Trash and Spam unless asked for.
      const out = ["trash", "junk"].map((r) => byRole(s.boxes, r)?.id).filter(Boolean) as string[];
      if (out.length) parts.unshift({ inMailboxOtherThan: out });
    }
  } else if (anywhere && !parts.length) parts.push({});
  if (problems.length) return { filter: null, problems, namesFolder };
  return { filter: parts.length ? and(parts) : {}, problems, namesFolder };
}

/** The query with one term taken out (a chip's ×). */
export const without = (terms: Term[], i: number): string => terms.filter((_, j) => j !== i).map((t, j) => (t.or && j > 0 ? `OR ${t.raw}` : t.raw)).join(" ");

/** A chip's words for a term. */
export function termLabel(t: Term): string {
  const not = t.negated ? tr("not") + " " : "";
  const names: Record<string, string> = {
    from: tr("From"),
    to: tr("To"),
    cc: tr("Cc"),
    bcc: tr("Bcc"),
    subject: tr("Subject"),
    has: tr("Has"),
    is: tr("Is"),
    in: tr("In"),
    label: tr("In"),
    before: tr("Before"),
    after: tr("After"),
    older: tr("Older than"),
    older_than: tr("Older than"),
    newer: tr("Newer than"),
    newer_than: tr("Newer than"),
    filename: tr("File name"),
    larger: tr("Larger than"),
    smaller: tr("Smaller than"),
    list: tr("List"),
  };
  return t.op ? `${not}${names[t.op] ?? t.op}: ${t.value}` : `${not}${t.value}`;
}

// ───────────────────────────── the form for people who do not type operators ─────────────────────────────

export interface SearchForm {
  from: string;
  to: string;
  subject: string;
  words: string;
  without: string;
  /** `""` any time, else a span such as `1w`. */
  within: string;
  attachment: boolean;
  /** `""` all mail, else a folder's name as `in:` takes it. */
  folder: string;
}

export const EMPTY_FORM: SearchForm = { from: "", to: "", subject: "", words: "", without: "", within: "", attachment: false, folder: "" };

/** A value as one operand: quoted when it has a space (and its own quotes dropped, which the parser could not keep). */
const operand = (v: string) => {
  const s = v.replace(/"/g, "").trim();
  return /\s/.test(s) ? `"${s}"` : s;
};

/** The form as the query it stands for (what the box then shows). */
export function formQuery(f: SearchForm): string {
  const out: string[] = [];
  if (f.from.trim()) out.push(`from:${operand(f.from)}`);
  if (f.to.trim()) out.push(`to:${operand(f.to)}`);
  if (f.subject.trim()) out.push(`subject:${operand(f.subject)}`);
  if (f.words.trim()) out.push(f.words.trim().slice(0, MAX_QUERY));
  for (const w of f.without.trim().split(/\s+/).filter(Boolean)) out.push(`-${operand(w)}`);
  if (f.within && span(f.within)) out.push(`newer_than:${f.within}`);
  if (f.attachment) out.push("has:attachment");
  if (f.folder.trim()) out.push(`in:${operand(f.folder)}`);
  return out.join(" ");
}

/** The query as far as the form can show it (what it cannot is left in "Has the words"). */
export function queryForm(q: string): SearchForm {
  const f: SearchForm = { ...EMPTY_FORM };
  const rest: string[] = [];
  for (const t of tokenize(q)) {
    if (t.or) rest.push("OR");
    if (!t.negated && !t.or && (t.op === "from" || t.op === "to" || t.op === "subject") && !f[t.op]) f[t.op] = t.value;
    else if (!t.negated && t.op === "has" && /^attachments?$/i.test(t.value)) f.attachment = true;
    else if (!t.negated && t.op === "in" && !f.folder) f.folder = t.value;
    else if (!t.negated && t.op === "newer_than" && !f.within) f.within = t.value;
    else if (t.negated && !t.op) f.without = [f.without, t.value].filter(Boolean).join(" ");
    else rest.push(t.raw);
  }
  f.words = rest.join(" ");
  return f;
}

// ───────────────────────────── what matched ─────────────────────────────

/** A search snippet (`SearchSnippet/get`: the text with `&`, `<`, `>` escaped and the matches in `<mark>`) as plain pieces; nothing in it is ever HTML. */
export function snippetParts(s: string | null | undefined): { text: string; mark: boolean }[] {
  if (!s) return [];
  const decode = (x: string) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const out: { text: string; mark: boolean }[] = [];
  let mark = false;
  for (const piece of s.split(/(<\/?mark>)/i)) {
    if (/^<mark>$/i.test(piece)) mark = true;
    else if (/^<\/mark>$/i.test(piece)) mark = false;
    else if (piece) out.push({ text: decode(piece), mark });
  }
  return out;
}

/** Whether a search snippet's text has anything marked (else the line's own subject is shown). */
export const hasMark = (s: string | null | undefined) => !!s && /<mark>/i.test(s);

// ───────────────────────────── recent searches (this browser) ─────────────────────────────

const RECENT = "ferrum.mail.recent.";

export function recentSearches(account: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT + account) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(account: string, q: string): void {
  const s = q.trim();
  if (!s) return;
  try {
    localStorage.setItem(RECENT + account, JSON.stringify([s, ...recentSearches(account).filter((x) => x !== s)].slice(0, 8)));
  } catch {
    // Not kept: a convenience only.
  }
}

export function forgetSearches(account: string): void {
  try {
    localStorage.removeItem(RECENT + account);
  } catch {
    // nothing kept
  }
}
