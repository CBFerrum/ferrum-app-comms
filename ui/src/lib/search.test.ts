// Mail wave 3: the search box's operators as JMAP filters, against a table of queries (hostile ones too).

import { describe, expect, it } from "vitest";
import { EMPTY_FORM, buildFilter, bytes, formQuery, queryForm, snippetParts, span, termLabel, tokenize, without } from "./search";
import type { Mailbox } from "./mail";

const box = (id: string, name: string, role: string | null): Mailbox => ({ id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0 });
const BOXES = [box("a", "Inbox", "inbox"), box("b", "Deleted Items", "trash"), box("c", "Junk Mail", "junk"), box("e", "Sent Items", "sent"), box("h", "Archive", "archive"), box("k", "Invoices", null)];
const NOW = Date.parse("2026-11-12T10:00:00Z");
const scope = { boxes: BOXES, now: NOW, midnight: (d: string) => (/^\d{4}\/\d{2}\/\d{2}$/.test(d) ? `${d.replace(/\//g, "-")}T00:00:00Z` : null) };
const ALL = { inMailboxOtherThan: ["b", "c"] };
const f = (q: string, folder: string | null = null) => buildFilter(q, { ...scope, folder });

describe("search: the table of queries", () => {
  const table: [string, unknown][] = [
    ["", ALL],
    ["invoice", { operator: "AND", conditions: [ALL, { text: "invoice" }] }],
    ["from:priya", { operator: "AND", conditions: [ALL, { from: "priya" }] }],
    ['from:"Priya Nair" subject:quote', { operator: "AND", conditions: [ALL, { from: "Priya Nair" }, { subject: "quote" }] }],
    ["to:omar cc:ann bcc:x", { operator: "AND", conditions: [ALL, { to: "omar" }, { cc: "ann" }, { bcc: "x" }] }],
    ["has:attachment is:unread is:starred", { operator: "AND", conditions: [ALL, { hasAttachment: true }, { notKeyword: "$seen" }, { hasKeyword: "$flagged" }] }],
    ["in:sent", { inMailbox: "e" }],
    ["in:Invoices from:bank", { operator: "AND", conditions: [{ inMailbox: "k" }, { from: "bank" }] }],
    ["in:spam", { inMailbox: "c" }],
    ["in:anywhere report", { text: "report" }],
    ["after:2026/01/01 before:2026/02/01", { operator: "AND", conditions: [ALL, { after: "2026-01-01T00:00:00Z" }, { before: "2026-02-01T00:00:00Z" }] }],
    ["older_than:1y", { operator: "AND", conditions: [ALL, { before: "2025-11-12T10:00:00Z" }] }],
    ["newer_than:2d", { operator: "AND", conditions: [ALL, { after: "2026-11-10T10:00:00Z" }] }],
    ['"exact words"', { operator: "AND", conditions: [ALL, { text: '"exact words"' }] }],
    ["-newsletter", { operator: "AND", conditions: [ALL, { operator: "NOT", conditions: [{ text: "newsletter" }] }] }],
    ["-in:sent bank", { operator: "AND", conditions: [{ operator: "NOT", conditions: [{ inMailbox: "e" }] }, { text: "bank" }] }],
    ["from:ann OR from:bob", { operator: "AND", conditions: [ALL, { operator: "OR", conditions: [{ from: "ann" }, { from: "bob" }] }] }],
    ["quote OR invoice OR receipt paid", { operator: "AND", conditions: [ALL, { operator: "OR", conditions: [{ text: "quote" }, { text: "invoice" }, { text: "receipt" }] }, { text: "paid" }] }],
    ["filename:pdf", { operator: "AND", conditions: [ALL, { operator: "AND", conditions: [{ hasAttachment: true }, { text: "pdf" }] }] }],
    ["larger:5M smaller:100K", { operator: "AND", conditions: [ALL, { minSize: 5 * 1024 * 1024 }, { maxSize: 100 * 1024 }] }],
    ["list:news.example.com", { operator: "AND", conditions: [ALL, { header: ["List-Id", "news.example.com"] }] }],
    ["https://x.example/a?b=c", { operator: "AND", conditions: [ALL, { text: "https://x.example/a?b=c" }] }],
    ["FROM:Ann", { operator: "AND", conditions: [ALL, { from: "Ann" }] }],
  ];
  for (const [q, want] of table)
    it(JSON.stringify(q), () => {
      const b = f(q);
      expect(b.problems).toEqual([]);
      expect(b.filter).toEqual(want);
    });

  it("looks in the folder when asked, unless the query names one", () => {
    expect(f("bank", "k").filter).toEqual({ operator: "AND", conditions: [{ inMailbox: "k" }, { text: "bank" }] });
    expect(f("in:sent bank", "k").filter).toEqual({ operator: "AND", conditions: [{ inMailbox: "e" }, { text: "bank" }] });
    expect(f("in:sent", "k").namesFolder).toBe(true);
  });

  it("says what it cannot search by, and asks nothing then", () => {
    for (const q of ["in:nowhere", "before:yesterday", "older_than:soon", "has:kittens", "is:important", "larger:huge"]) {
      const b = f(q);
      expect(b.filter, q).toBeNull();
      expect(b.problems.length, q).toBe(1);
    }
  });

  it("hostile input stays a well-formed filter", () => {
    const hostile = ['"', '""', "-", "OR", "OR OR", "from:", 'from:"', "((((", "a\u0000b\nc", "\\", "*", "from:*@*", '"; drop table', "in:", "x".repeat(5000), Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ")];
    for (const q of hostile) {
      const b = f(q);
      expect(() => JSON.stringify(b.filter)).not.toThrow();
      if (b.filter) expect(JSON.stringify(b.filter).length).toBeLessThan(10_000);
      const walk = (x: unknown): void => {
        if (x && typeof x === "object" && !Array.isArray(x)) {
          const o = x as Record<string, unknown>;
          if ("operator" in o) {
            expect(["AND", "OR", "NOT"]).toContain(o.operator);
            expect(Array.isArray(o.conditions) && (o.conditions as unknown[]).length > 0).toBe(true);
            (o.conditions as unknown[]).forEach(walk);
          } else for (const v of Object.values(o)) if (typeof v === "string") expect(v).not.toMatch(/[\u0000-\u001f]/);
        }
      };
      walk(b.filter);
    }
    expect(tokenize(Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ")).length).toBe(40);
  });
});

describe("search: pieces", () => {
  it("reads spans and sizes", () => {
    expect(span("3d")).toBe(3 * 86_400_000);
    expect(span("2w")).toBe(14 * 86_400_000);
    expect(span("x")).toBeNull();
    expect(bytes("10M")).toBe(10 * 1024 * 1024);
    expect(bytes("2000")).toBe(2000);
    expect(bytes("lots")).toBeNull();
  });
  it("takes a chip out and labels it", () => {
    const t = tokenize('from:ann "big deal" OR -is:unread');
    expect(t.map(termLabel)).toEqual(["From: ann", '"big deal"', "not Is: unread"]);
    expect(without(t, 0)).toBe('"big deal" OR -is:unread');
    expect(without(t, 1)).toBe("from:ann OR -is:unread");
  });
  it("the form and the query stand for each other", () => {
    const q = formQuery({ ...EMPTY_FORM, from: "Priya Nair", subject: "quote", words: "price", without: "draft old", within: "1w", attachment: true, folder: "Invoices" });
    expect(q).toBe('from:"Priya Nair" subject:quote price -draft -old newer_than:1w has:attachment in:Invoices');
    expect(queryForm(q)).toEqual({ from: "Priya Nair", to: "", subject: "quote", words: "price", without: "draft old", within: "1w", attachment: true, folder: "Invoices" });
    expect(formQuery({ ...EMPTY_FORM, from: 'a"b c' })).toBe('from:"ab c"');
  });
  it("snippets are text with marks, never HTML", () => {
    expect(snippetParts("Your <mark>invoice</mark> &lt;script&gt; &amp; more")).toEqual([
      { text: "Your ", mark: false },
      { text: "invoice", mark: true },
      { text: " <script> & more", mark: false },
    ]);
    expect(snippetParts(null)).toEqual([]);
  });
});
