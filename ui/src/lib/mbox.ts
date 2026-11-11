// The mbox format (mboxrd: RFC 4155 with ">From " quoting both ways) for importing and exporting mail.

/** The messages of an mbox file (or one .eml when it has no "From " separator lines). */
export function splitMbox(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.startsWith("From ")) return text.trim() ? [text.replace(/\r?\n/g, "\r\n")] : [];
  const out: string[][] = [];
  let cur: string[] | null = null;
  lines.forEach((l, i) => {
    if (l.startsWith("From ") && (i === 0 || lines[i - 1] === "")) {
      if (cur) out.push(cur);
      cur = [];
    } else cur?.push(l.replace(/^>(>*From )/, "$1"));
  });
  if (cur) out.push(cur);
  return out.map((m) => m.join("\n").replace(/\n+$/, "")).filter((m) => m.trim()).map((m) => `${m}\r\n`.replace(/\r?\n/g, "\r\n"));
}

const ctime = (d: Date) => d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4");

/** One message as an mbox entry. */
export function mboxEntry(raw: string, from: string, date: Date): string {
  const body = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "").replace(/^(>*From )/gm, ">$1");
  return `From ${from.replace(/\s/g, "") || "MAILER-DAEMON"} ${ctime(date)}\n${body}\n\n`;
}
