// Writing mail, the pure parts: the subject of an answer in any language, the HTML a message goes
// out with (cleaned of everything another mail client cannot use or should not run, styled inline),
// the plain-text part made from it, the MIME structure handed to the mail server, the quoted
// original, holding a message back (undo send, schedule send), and the checks before sending.
// The browser's own parser does the HTML work (DOMParser): nothing here runs what it reads.

import { t as tr } from "@ferrum/client";
import type { Address, Upload } from "./mail";

// ───────────────────────────── subjects ─────────────────────────────

// What mail programs put before a subject when answering or forwarding, in the languages they write it in.
const REPLY_WORDS = ["re", "aw", "sv", "antw", "odp", "ynt", "res", "rif", "r", "vá", "atb", "vs:re", "回复", "回覆", "答复", "返信", "رد", "ردّ", "उत्तर", "ответ"];
const FORWARD_WORDS = ["fwd", "fw", "wg", "vs", "vb", "doorst", "pd", "ilt", "i̇lt", "enc", "rv", "tr", "i", "továbbítás", "转发", "轉寄", "転送", "إعادة توجيه", "اعادة توجيه", "fwd", "पुनः भेजें"];
const prefix = (words: string[]) => new RegExp(`^\\s*(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*(?:\\[\\d+\\])?\\s*[:：]`, "iu");
const IS_REPLY = prefix(REPLY_WORDS);
const IS_FORWARD = prefix(FORWARD_WORDS);

/** "Re: Q3" for an answer to "Q3", and "Re: Q3" again for an answer to "AW: Q3" or "Re: Q3": the
 *  prefix is added once, whatever language the first one was in. Forwards alike with "Fwd:". */
export function answerSubject(subject: string | null | undefined, kind: "reply" | "forward"): string {
  const s = (subject ?? "").trim();
  if ((kind === "reply" ? IS_REPLY : IS_FORWARD).test(s)) return s;
  return `${kind === "reply" ? "Re" : "Fwd"}: ${s}`;
}

// ───────────────────────────── threading ─────────────────────────────

/** In-Reply-To and References for an answer or forward of `original`: its own id, after the ids it
 *  answered (RFC 5322 §3.6.4), the oldest kept and the newest 19 when the chain is very long. */
export function threadOf(original: { messageId?: string[] | null; references?: string[] | null; inReplyTo?: string[] | null } | undefined): { inReplyTo?: string[]; references?: string[] } {
  const id = original?.messageId?.[0];
  if (!id) return {};
  const before = original.references?.length ? original.references : original.inReplyTo?.length === 1 ? original.inReplyTo : [];
  const chain = [...before.filter((r) => r !== id), id];
  return { inReplyTo: [id], references: chain.length > 20 ? [chain[0]!, ...chain.slice(-19)] : chain };
}

// ───────────────────────────── HTML going out ─────────────────────────────

/** Elements a message may carry; anything else is unwrapped (its text kept) or, below, dropped whole. */
const TAGS = new Set("a abbr b big blockquote br caption center cite code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img li mark ol p pre q s small span strike strong sub sup table tbody td tfoot th thead tr u ul".split(" "));
const DROP = new Set("script style head title iframe frame frameset object embed applet form input button select option textarea svg math template noscript link meta base video audio source track canvas dialog portal".split(" "));
const ATTRS = new Set(["href", "src", "alt", "title", "width", "height", "align", "valign", "colspan", "rowspan", "dir", "bgcolor", "color", "face", "size", "start", "type", "border", "cellpadding", "cellspacing", "lang", "style", "class", "data-cid", "data-blob-id", "data-type", "data-name", "data-remote"]);
/** Classes other mail programs use to fold a quote or a signature; no other class means anything outside our page. */
const CLASSES = new Set(["gmail_quote", "gmail_attr", "gmail_signature"]);
/** Inline styles kept: type, colour, spacing and layout, nothing that loads anything (as the reader's own list in src/webmail.rs). */
const STYLES = new Set(
  "color background-color font font-family font-size font-style font-weight text-align text-decoration text-transform text-indent line-height letter-spacing white-space vertical-align word-break overflow-wrap word-wrap margin margin-top margin-right margin-bottom margin-left margin-inline-start margin-inline-end padding padding-top padding-right padding-bottom padding-left padding-inline-start border border-top border-right border-bottom border-left border-inline-start border-color border-style border-width border-collapse border-spacing border-radius width min-width max-width height min-height max-height display table-layout list-style-type direction".split(" "),
);

const safeStyle = (style: string): string =>
  style
    .split(";")
    .map((d) => d.trim())
    .filter((d) => {
      const i = d.indexOf(":");
      if (i < 1) return false;
      const name = d.slice(0, i).trim().toLowerCase();
      const value = d.slice(i + 1).toLowerCase();
      return STYLES.has(name) && !/url\(|expression\(|javascript:|@import|\\/.test(value);
    })
    .join("; ");

const safeHref = (href: string) => /^(https?:|mailto:|tel:)/i.test(href.trim()) ? href.trim() : null;

function cleanNode(el: Element): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 8) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const c = child as Element;
    const tag = c.tagName.toLowerCase();
    if (DROP.has(tag)) {
      c.remove();
      continue;
    }
    cleanNode(c);
    if (!TAGS.has(tag)) {
      c.replaceWith(...Array.from(c.childNodes));
      continue;
    }
    for (const a of Array.from(c.attributes)) {
      const name = a.name.toLowerCase();
      if (!ATTRS.has(name) || name.startsWith("on")) c.removeAttribute(a.name);
      else if (name === "style") {
        const s = safeStyle(a.value);
        if (s) c.setAttribute("style", s);
        else c.removeAttribute("style");
      } else if (name === "class") {
        const keep = a.value.split(/\s+/).filter((x) => CLASSES.has(x));
        if (keep.length) c.setAttribute("class", keep.join(" "));
        else c.removeAttribute("class");
      } else if (name === "href") {
        const h = tag === "a" ? safeHref(a.value) : null;
        if (h) c.setAttribute("href", h);
        else c.removeAttribute("href");
      } else if (name === "src") {
        if (tag !== "img" || !/^(https?:|cid:|data:image\/(png|jpeg|gif|webp);|blob:|\/api\/)/i.test(a.value.trim())) c.removeAttribute("src");
      }
    }
  }
}

function parse(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  return doc.body;
}

/** HTML from anywhere (an answered message, a signature another program saved) as a message may carry it. */
export function cleanHtml(html: string): string {
  const body = parse(html);
  cleanNode(body);
  return body.innerHTML;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text as HTML: lines kept, web addresses left as text (the receiving program links them). */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => `<div>${l ? escapeHtml(l) : "<br>"}</div>`)
    .join("");
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿऀ-෿぀-鿿]/;

/** The direction the text starts in: its first letter that has one (Arabic, Hebrew right to left). */
export function directionOf(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    if (RTL.test(ch)) return "rtl";
    if (LTR.test(ch)) return "ltr";
  }
  return "ltr";
}

// ui-lint-allow raw-color: the quote's rule goes out inside the message, read by other mail programs, not drawn by our theme
export const QUOTE_STYLE = "margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex";
const BODY_STYLE = "font-family:Arial,Helvetica,sans-serif;font-size:14px";

/** The editor's HTML in the shapes mail programs draw alike: a line is a `div` (Outlook gives `p` a
 *  gap), an empty line a `<div><br></div>`, a list item holds its text directly, a quote is drawn by
 *  its own inline rule, and nothing names our editor. */
export function fromEditor(html: string): string {
  const body = parse(html);
  cleanNode(body);
  for (const li of Array.from(body.querySelectorAll("li"))) {
    const ps = Array.from(li.children).filter((c) => c.tagName === "P");
    ps.forEach((p, i) => {
      const keep = Array.from(p.childNodes);
      if (i > 0) keep.unshift(p.ownerDocument.createElement("br"));
      p.replaceWith(...keep);
    });
  }
  for (const p of Array.from(body.querySelectorAll("p"))) {
    const div = p.ownerDocument.createElement("div");
    for (const a of Array.from(p.attributes)) div.setAttribute(a.name, a.value);
    div.append(...Array.from(p.childNodes));
    if (!div.textContent?.length && !div.querySelector("img,br")) div.append(p.ownerDocument.createElement("br"));
    p.replaceWith(div);
  }
  for (const q of Array.from(body.querySelectorAll("blockquote"))) q.setAttribute("style", QUOTE_STYLE);
  for (const a of Array.from(body.querySelectorAll("a"))) {
    a.removeAttribute("target");
    a.removeAttribute("rel");
  }
  return body.innerHTML;
}

/** An image inside a message, sent as a part of its own and shown by `cid:`. */
export interface InlinePart {
  blobId: string;
  cid: string;
  type: string;
  name: string;
}

/** The message's HTML and text as they go out, and the images in it as parts. `missing` lists images
 *  not on the mail server yet (pasted, or from a copy of a draft): the caller uploads them first. */
export interface MailBody {
  html: string;
  text: string;
  inline: InlinePart[];
  missing: string[];
}

/** One body from what is written, the signature and the quoted original. */
export function mailBody(parts: { body: string; signature?: string | null; quote?: string | null }): MailBody {
  const sig = parts.signature ? `<div class="gmail_signature" dir="auto">-- <br>${parts.signature}</div>` : "";
  const root = parse(`${fromEditor(parts.body)}${sig ? `<br>${sig}` : ""}${parts.quote ?? ""}`);
  cleanNode(root);
  const inline: InlinePart[] = [];
  const missing: string[] = [];
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const cid = img.getAttribute("data-cid");
    const blobId = img.getAttribute("data-blob-id");
    const remote = img.getAttribute("data-remote");
    const src = img.getAttribute("src") ?? "";
    if (cid && blobId) {
      if (!inline.some((i) => i.cid === cid)) inline.push({ blobId, cid, type: img.getAttribute("data-type") || "image/png", name: img.getAttribute("data-name") || "image" });
      img.setAttribute("src", `cid:${cid}`);
    } else if (remote && /^https?:/i.test(remote)) img.setAttribute("src", remote);
    else if (!/^(https?:|cid:)/i.test(src)) {
      if (src) missing.push(src);
      img.remove();
      continue;
    }
    if (!img.getAttribute("alt") && img.getAttribute("data-name")) img.setAttribute("alt", img.getAttribute("data-name")!);
    for (const a of ["data-cid", "data-blob-id", "data-type", "data-name", "data-remote"]) img.removeAttribute(a);
  }
  const text = htmlToText(root);
  const dir = directionOf(root.textContent ?? "");
  return { html: `<div dir="${dir}" style="${BODY_STYLE}">${root.innerHTML}</div>`, text, inline, missing };
}

const BLOCKS = new Set("address article aside blockquote center dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody tfoot thead tr ul".split(" "));
// While the text is built, a block's edge is BREAK and a paragraph's PARA; `settle` turns a run of
// edges and line breaks into lines: one more line than the breaks in it, two at least around a paragraph.
const BREAK = "\u0001";
const PARA = "\u0002";

function settle(s: string): string {
  return s
    .replace(/[\n\u0001\u0002]+/g, (run) => {
      if (!/[\u0001\u0002]/.test(run)) return run;
      const lines = (run.match(/\n/g)?.length ?? 0) + 1;
      return "\n".repeat(run.includes(PARA) ? Math.max(2, lines) : lines);
    })
    .split("\n")
    .map((l) => (l === "-- " ? l : l.replace(/[ \t]+$/g, "").replace(/^ (?=\S)/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/** The plain-text part a reader without HTML gets: lines and paragraphs kept, lists as "- " and
 *  "1. " lines, links as their words and address, quotes with "> ", images by their name. */
export function htmlToText(input: string | Element): string {
  const root = typeof input === "string" ? parse(input) : input;
  const walk = (n: Node, pre: boolean, depth: number): string => {
    if (n.nodeType === 3) return pre ? (n.textContent ?? "") : (n.textContent ?? "").replace(/[ \t\r\n\f]+/g, " ");
    if (n.nodeType !== 1) return "";
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return "";
    if (tag === "br") {
      // A break between words and a block ends the line the block would end anyway: no empty line, as a browser draws it.
      const near = (n: Node | null, dir: "previousSibling" | "nextSibling"): Node | null => (n && n.nodeType === 3 && !n.textContent?.trim() ? near(n[dir], dir) : n);
      const before = near(el.previousSibling, "previousSibling");
      const after = near(el.nextSibling, "nextSibling");
      const block = (x: Node | null) => !!x && x.nodeType === 1 && BLOCKS.has((x as Element).tagName.toLowerCase());
      return before && !block(before) && block(after) ? "" : "\n";
    }
    if (tag === "img") {
      const name = el.getAttribute("alt") || el.getAttribute("data-name") || "";
      return name ? `[${tr("image")}: ${name}]` : "";
    }
    if (tag === "hr") return `${BREAK}----------${BREAK}`;
    const kids = Array.from(el.childNodes);
    // A line's closing <br> draws nothing in a browser; it does not make an empty line here either.
    if (kids.length > 1 && kids.at(-1)?.nodeName === "BR") kids.pop();
    const inner = (d = depth) => kids.map((c) => walk(c, pre || tag === "pre", d)).join("");
    if (tag === "a") {
      const words = inner();
      const raw = el.getAttribute("href") ?? "";
      const href = raw.replace(/^mailto:/i, "");
      return !href || words.trim() === href || words.trim() === raw ? words : `${words} <${href}>`;
    }
    if (tag === "ul" || tag === "ol") {
      let i = Number(el.getAttribute("start") ?? "1") || 1;
      const pad = "  ".repeat(depth);
      const lines = Array.from(el.children)
        .filter((c) => c.tagName === "LI")
        .map((li) => {
          const mark = tag === "ol" ? `${i++}. ` : "- ";
          const body = settle(Array.from(li.childNodes).map((c) => walk(c, pre, depth + 1)).join(""));
          return body
            .split("\n")
            .map((l, k) => (k === 0 ? `${pad}${mark}${l}` : l))
            .join("\n");
        });
      return `${BREAK}${lines.join("\n")}${BREAK}`;
    }
    if (tag === "blockquote") {
      const body = settle(inner());
      return `${BREAK}${body.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}${BREAK}`;
    }
    if (tag === "td" || tag === "th") return `${inner()} `;
    const text = inner();
    if (tag === "p" || /^h[1-6]$/.test(tag)) return `${PARA}${text}${PARA}`;
    return BLOCKS.has(tag) ? `${BREAK}${text}${BREAK}` : text;
  };
  return settle(walk(root, false, 0));
}

// ───────────────────────────── the original, quoted ─────────────────────────────

/** A message as JMAP gives it with its body parts and their values. */
export interface RawEmail {
  htmlBody?: { partId?: string; blobId?: string; type?: string }[] | null;
  attachments?: { partId?: string; blobId?: string; type?: string; name?: string | null; size?: number; cid?: string | null; disposition?: string | null }[] | null;
  bodyValues?: Record<string, { value: string }> | null;
}

/** The address an image of the mailbox is shown from while it is written about (the proxy's download). */
export type BlobUrl = (blobId: string, name: string, type: string) => string;

/**
 * A message's HTML to answer or go on writing: cleaned, its plain parts as lines, and every `cid:`
 * image marked with the part it is (so it goes out again as that part, by reference, never fetched and
 * uploaded) and shown from the mailbox meanwhile. Remote images keep their address aside: they are not
 * loaded while writing, and go out as they came.
 */
export function richOf(email: RawEmail, blobUrl: BlobUrl): string {
  const values = email.bodyValues ?? {};
  let html = "";
  for (const p of email.htmlBody ?? []) {
    const v = values[p.partId ?? ""]?.value ?? "";
    if (p.type === "text/html") html += v;
    else if (p.type === "text/plain") html += textToHtml(v);
  }
  const body = parse(html);
  cleanNode(body);
  const byCid = new Map((email.attachments ?? []).filter((a) => a.cid && a.blobId).map((a) => [a.cid!.replace(/^<|>$/g, ""), a]));
  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = (img.getAttribute("src") ?? "").trim();
    const part = /^cid:/i.test(src) ? byCid.get(src.slice(4).replace(/^<|>$/g, "")) : undefined;
    if (part) {
      const name = part.name || "image";
      const type = part.type || "image/png";
      img.setAttribute("data-cid", newCid());
      img.setAttribute("data-blob-id", part.blobId!);
      img.setAttribute("data-type", type);
      img.setAttribute("data-name", name);
      img.setAttribute("src", blobUrl(part.blobId!, name, type));
    } else if (/^https?:/i.test(src)) {
      img.setAttribute("data-remote", src);
      img.removeAttribute("src");
    } else if (!/^data:image\//i.test(src)) img.remove();
  }
  return body.innerHTML;
}

/** The parts an answer leaves out: those shown in the body by `cid:` (they go with the quote). */
export function inlineIds(email: RawEmail): Set<string> {
  return new Set((email.attachments ?? []).filter((a) => a.cid && a.disposition !== "attachment").map((a) => a.blobId!).filter(Boolean));
}

/** A fresh Content-ID for an image of a message. */
export function newCid(): string {
  const r = typeof crypto !== "undefined" && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("") : Math.random().toString(16).slice(2);
  return `ii_${r}@ferrum`;
}

const nameAddress = (a: Address) => (a.name ? `<strong>${escapeHtml(a.name)}</strong> &lt;${escapeHtml(a.email)}&gt;` : escapeHtml(a.email));

/** The original under an answer: "On …, Priya Nair wrote:" and its words in a quote; a forward's
 *  header block and its words as they were. `when` is already in the person's zone and language. */
export function quoteHtml(kind: "reply" | "forward", original: { from?: Address[] | null; to?: Address[] | null; cc?: Address[] | null; subject?: string | null }, when: string, html: string): string {
  const who = original.from?.[0];
  if (kind === "forward") {
    const lines = [
      `---------- ${escapeHtml(tr("Forwarded message"))} ---------`,
      `${escapeHtml(tr("From"))}: ${who ? nameAddress(who) : ""}`,
      `${escapeHtml(tr("Date"))}: ${escapeHtml(when)}`,
      `${escapeHtml(tr("Subject"))}: ${escapeHtml(original.subject ?? "")}`,
      `${escapeHtml(tr("To"))}: ${(original.to ?? []).map(nameAddress).join(", ")}`,
      ...(original.cc?.length ? [`${escapeHtml(tr("Cc"))}: ${original.cc.map(nameAddress).join(", ")}`] : []),
    ];
    return `<br><div class="gmail_quote"><div dir="auto" class="gmail_attr">${lines.join("<br>")}<br></div><br>${html}</div>`;
  }
  const by = who ? (who.name ? `${escapeHtml(who.name)} &lt;${escapeHtml(who.email)}&gt;` : escapeHtml(who.email)) : "";
  const line = escapeHtml(tr("On {when}, {value} wrote:", { when, value: "\u0000" })).replace("\u0000", by);
  return `<br><div class="gmail_quote"><div dir="auto" class="gmail_attr">${line}<br></div><blockquote class="gmail_quote" style="${QUOTE_STYLE}">${html}</blockquote></div>`;
}

// ───────────────────────────── the message the mail server takes ─────────────────────────────

/** The body of an Email/set creation: `multipart/alternative` (text and HTML) inside
 *  `multipart/related` with the images it shows, inside `multipart/mixed` with its files; plain text
 *  alone when there is no HTML. Each part is a reference to a blob already on the mail server. */
export function structure(p: { text: string; html?: string | null; inline?: InlinePart[]; files?: Upload[]; calendar?: { method: string; blobId?: string } | null }) {
  const bodyValues: Record<string, { value: string }> = { t: { value: p.text } };
  let node: Record<string, unknown> = { partId: "t", type: "text/plain" };
  if (p.html) {
    bodyValues.h = { value: p.html };
    node = { type: "multipart/alternative", subParts: [node, { partId: "h", type: "text/html" }] };
  }
  const inline = p.html ? (p.inline ?? []) : [];
  if (inline.length) node = { type: "multipart/related", subParts: [node, ...inline.map((i) => ({ blobId: i.blobId, type: i.type, name: i.name, cid: i.cid, disposition: "inline" }))] };
  const files = p.files ?? [];
  if (files.length) node = { type: "multipart/mixed", subParts: [node, ...files.map((f) => ({ blobId: f.blobId, type: f.type || "application/octet-stream", name: f.name, disposition: "attachment" }))] };
  return { bodyValues, bodyStructure: node };
}

export interface Outgoing {
  from: { name?: string | null; email: string };
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html?: string | null;
  inline?: InlinePart[];
  files?: Upload[];
  inReplyTo?: string[];
  references?: string[];
}

/** The message as the mail server takes it into a folder (Drafts while written, the same message when sent). */
export function emailCreate(m: Outgoing, mailbox: string, keywords: Record<string, boolean> = { $seen: true, $draft: true }): Record<string, unknown> {
  const clean = (l: Address[]) => l.map((a) => (a.name ? { name: a.name, email: a.email } : { email: a.email }));
  return {
    mailboxIds: { [mailbox]: true },
    keywords,
    from: [m.from.name ? { name: m.from.name, email: m.from.email } : { email: m.from.email }],
    to: clean(m.to),
    // An empty list would go out as an empty header.
    ...(m.cc.length ? { cc: clean(m.cc) } : {}),
    ...(m.bcc.length ? { bcc: clean(m.bcc) } : {}),
    subject: m.subject.trim(),
    ...structure({ text: m.text, html: m.html, inline: m.inline, files: m.files }),
    ...(m.inReplyTo?.length ? { inReplyTo: m.inReplyTo } : {}),
    ...(m.references?.length ? { references: m.references } : {}),
  };
}

// ───────────────────────────── holding a message back ─────────────────────────────

/** Seconds a sent message waits on the mail server, for Undo, by choice: off, 5, 10, 20 or 30. */
export const UNDO_CHOICES = [0, 5, 10, 20, 30] as const;
export const UNDO_DEFAULT = 10;

/** The SMTP FUTURERELEASE parameter (RFC 4865) that holds a submission on the mail server. */
export function holdParams(hold: { seconds: number } | { until: Date } | null): Record<string, string> | null {
  if (!hold) return null;
  if ("until" in hold) return { HOLDUNTIL: hold.until.toISOString().replace(/\.\d{3}Z$/, "Z") };
  return hold.seconds > 0 ? { HOLDFOR: String(Math.round(hold.seconds)) } : null;
}

/** An EmailSubmission's envelope: from the identity, to every recipient once. Needed to pass the hold. */
export function envelope(from: string, m: Pick<Outgoing, "to" | "cc" | "bcc">, params: Record<string, string> | null) {
  const seen = new Set<string>();
  const rcptTo = [...m.to, ...m.cc, ...m.bcc].filter((a) => !seen.has(a.email.toLowerCase()) && !!seen.add(a.email.toLowerCase())).map((a) => ({ email: a.email }));
  return { mailFrom: { email: from, ...(params ? { parameters: params } : {}) }, rcptTo };
}

/** Times offered for "Schedule send", in the person's zone: tomorrow morning, this (or tomorrow)
 *  afternoon, Monday morning. `wall` turns a moment into "YYYY-MM-DDTHH:mm" on their clock and `moment`
 *  back (the client's toZonedInput and fromZonedInput). */
export function schedulePresets(now: Date, wall: (iso: string) => string, moment: (local: string) => string | null): { label: string; at: Date }[] {
  const today = wall(now.toISOString());
  const [y, m, d] = today.slice(0, 10).split("-").map(Number) as [number, number, number];
  const hour = Number(today.slice(11, 13));
  const day = (plus: number) => {
    const x = new Date(Date.UTC(y, m - 1, d + plus));
    return { iso: x.toISOString().slice(0, 10), weekday: x.getUTCDay() };
  };
  const at = (date: string, time: string) => {
    const iso = moment(`${date}T${time}`);
    return iso ? new Date(iso) : null;
  };
  const out: { label: string; at: Date | null }[] = [{ label: tr("Tomorrow morning"), at: at(day(1).iso, "08:00") }];
  out.push(hour < 12 ? { label: tr("This afternoon"), at: at(today.slice(0, 10), "13:00") } : { label: tr("Tomorrow afternoon"), at: at(day(1).iso, "13:00") });
  const toMonday = ((8 - day(0).weekday) % 7) || 7;
  if (toMonday > 1) out.push({ label: tr("Monday morning"), at: at(day(toMonday).iso, "08:00") });
  return out.filter((o): o is { label: string; at: Date } => !!o.at && o.at.getTime() > now.getTime());
}

// ───────────────────────────── before sending ─────────────────────────────

// "Attached", "attachment", "enclosed" in the languages people write mail in here.
const ATTACH_WORDS =
  /(?<![\p{L}\p{N}])(attach(ed|es|ing|ment|ments)?|enclosed|herewith|pi[eè]ces? jointes?|ci-joint|anh[aä]ng|angeh[aä]ngt|adjunt[oa]s?|anex[oa]s?|allegat[oa]|bijlage)(?![\p{L}\p{N}])|संलग्न|अटैच|مرفق|مرفقة|مرفقات|附件|添付/iu;

/** Whether the person's own words say a file is attached (quoted text and the signature are not theirs). */
export const mentionsAttachment = (ownWords: string) => ATTACH_WORDS.test(ownWords);

/** Problems that stop a message going: addresses that are not ones, and no recipient at all. */
export function sendProblem(fields: { to: Address[]; cc: Address[]; bcc: Address[] }, bad: string[]): string | null {
  if (bad.length) return tr("Not an email address: {bad}. Fix it, or take it out, and send again.", { bad: bad.join(", ") });
  if (!fields.to.length && !fields.cc.length && !fields.bcc.length) return tr("Add at least one recipient.");
  return null;
}

// ───────────────────────────── recipients ─────────────────────────────

/** Someone offered while typing an address: a colleague, or someone written to before. */
export interface Suggestion extends Address {
  source: "people" | "recent";
}

/** People written to, most often first, from the To, Cc and Bcc of sent messages; never oneself. */
export function recentRecipients(sent: { to?: Address[] | null; cc?: Address[] | null; bcc?: Address[] | null }[], mine: string[]): Address[] {
  const own = new Set(mine.map((m) => m.toLowerCase()));
  const count = new Map<string, { a: Address; n: number; first: number }>();
  sent.forEach((m, i) => {
    for (const a of [...(m.to ?? []), ...(m.cc ?? []), ...(m.bcc ?? [])]) {
      const k = a.email.toLowerCase();
      if (own.has(k)) continue;
      const c = count.get(k);
      if (c) {
        c.n++;
        if (!c.a.name && a.name) c.a = { name: a.name, email: c.a.email };
      } else count.set(k, { a: a.name ? { name: a.name, email: a.email } : { email: a.email }, n: 1, first: i });
    }
  });
  return [...count.values()].sort((x, y) => y.n - x.n || x.first - y.first).map((c) => c.a);
}

/** What to offer for `query`: names and addresses beginning with it first, then containing it;
 *  colleagues before people written to before when equally good; nobody already on the message. */
export function suggest(query: string, people: { full_name?: string | null; email: string }[], recent: Address[], exclude: string[], limit = 6): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const all = new Map<string, Suggestion>();
  for (const p of people) if (!skip.has(p.email.toLowerCase())) all.set(p.email.toLowerCase(), { name: p.full_name || null, email: p.email, source: "people" });
  for (const a of recent) if (!skip.has(a.email.toLowerCase()) && !all.has(a.email.toLowerCase())) all.set(a.email.toLowerCase(), { ...a, source: "recent" });
  const rank = (s: Suggestion) => {
    const name = (s.name ?? "").toLowerCase();
    const email = s.email.toLowerCase();
    if (name.startsWith(q) || email.startsWith(q)) return 0;
    if (name.split(/\s+/).some((w) => w.startsWith(q)) || email.split(/[@.]/).some((w) => w.startsWith(q))) return 1;
    return name.includes(q) || email.includes(q) ? 2 : 9;
  };
  return [...all.values()]
    .map((s, i) => ({ s, r: rank(s), i }))
    .filter((x) => x.r < 9)
    .sort((a, b) => a.r - b.r || (a.s.source === b.s.source ? a.i - b.i : a.s.source === "people" ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.s);
}

// ───────────────────────────── files ─────────────────────────────

/** The largest file the platform takes in one request (its site body limit, measured on the
 *  running server: 32 MiB answered "request body larger than 32768 KB"). */
export const MAX_FILE = 32 * 1024 * 1024;

/** Why a file cannot be added, before it is uploaded: too large alone, or too much together. */
export function fileProblem(size: number, already: number, total: number): string | null {
  if (size > MAX_FILE) return tr("Too large: a file can be at most {value} MB.", { value: Math.floor(MAX_FILE / 1024 / 1024) });
  if (already + size > total) return tr("Too large: a message can carry at most {value} MB of files.", { value: Math.floor(total / 1000 / 1000) });
  return null;
}

// ───────────────────────────── the person's choices for writing ─────────────────────────────

export interface WritePrefs {
  /** Seconds a sent message can still be called back. */
  undoSeconds: number;
  /** The signature goes into answers and forwards too (above the quote), not only new messages. */
  signatureInReplies: boolean;
}

const PREFS = "ferrum.mail.write.";

/** Kept in this browser per mailbox (the mail server has nowhere for them). */
export function writePrefs(account: string): WritePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS + account) ?? "{}") as Partial<WritePrefs>;
    return {
      undoSeconds: (UNDO_CHOICES as readonly number[]).includes(raw.undoSeconds ?? -1) ? raw.undoSeconds! : UNDO_DEFAULT,
      signatureInReplies: raw.signatureInReplies ?? true,
    };
  } catch {
    return { undoSeconds: UNDO_DEFAULT, signatureInReplies: true };
  }
}

export function saveWritePrefs(account: string, p: WritePrefs): void {
  try {
    localStorage.setItem(PREFS + account, JSON.stringify(p));
  } catch {
    // Not kept: the defaults apply next time.
  }
}

/** The folder templates are kept in: one of the person's own, named as Thunderbird names it, so other mail programs see the same ones. */
export const TEMPLATES = "Templates";
