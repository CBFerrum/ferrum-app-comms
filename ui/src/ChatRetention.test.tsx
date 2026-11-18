// The retention section's states as it first draws them: loading, none set, and the two rules set.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatRetention, retentionKey } from "./ChatRetention";
import type { RetentionRule } from "./lib/chat";

const draw = (rules?: RetentionRule[]) => {
  const qc = new QueryClient();
  if (rules) qc.setQueryData(retentionKey, { rules });
  return renderToString(<QueryClientProvider client={qc}><ChatRetention channel="c1" /></QueryClientProvider>);
};
const rule = (id: string, condition: unknown, after_days: number): RetentionRule => ({ id, entity: "ChatMessage", condition, after_days, date_field: "posted_at", action: "delete", reason: `keep ${id}`, is_active: true });

describe("how long messages are kept", () => {
  it("draws a skeleton while the rules load", () => {
    const h = draw();
    expect(h).toContain("How long messages are kept");
    expect(h).not.toContain("This channel");
  });
  it("says messages are kept when no rule is set, with empty labelled fields", () => {
    const h = draw([{ ...rule("mail", {}, 5), entity: "Communication" }]);
    expect(h).toContain("Messages are kept until someone deletes them");
    expect(h).toContain("This channel");
    expect(h).toContain("Every channel");
    expect(h.match(/<label[^>]*for=/g)?.length).toBe(4);
    expect(h).not.toContain(">Remove<");
  });
  it("shows both rules and that the shorter one wins", () => {
    const h = draw([rule("mine", [["channel", "=", "c1"]], 30), rule("all", {}, 365)]);
    expect(h).toContain("the shorter time applies to this channel");
    expect(h).toContain('value="30"');
    expect(h).toContain('value="365"');
    expect(h).toContain("keep mine");
    expect(h.match(/>Remove</g)?.length).toBe(2);
  });
});
