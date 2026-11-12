// The composer's Send button: its name says what it does and the key, and the key is exposed to assistive technology.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@ferrum/kit/primitives";
import { SEND_KEYS, SendButton } from "./MailComposer";

const html = (busy: boolean) => renderToString(<TooltipProvider><SendButton busy={busy} disabled={busy} split onSend={() => {}} /></TooltipProvider>);

describe("the Send button", () => {
  it("is named with what it does and its key, and exposes the key", () => {
    const h = html(false);
    expect(h).toContain(`aria-label="Send (${SEND_KEYS.shown})"`);
    expect(h).toContain(`aria-keyshortcuts="Control+Enter Meta+Enter"`);
    expect(h).toMatch(/<button[^>]*type="button"/);
  });
  it("says it is sending while the mail server has not taken the message", () => {
    const h = html(true);
    expect(h).toContain(`aria-label="Sending…"`);
    expect(h).toContain("disabled");
  });
});
