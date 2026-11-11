// What a failed request shows: the platform's error says which kind it was, so a refusal is not
// drawn as a breakage and a lost connection is not drawn as an empty page.

import { StatePanel } from "@ferrum/kit";
import { Button } from "@ferrum/kit/primitives";
import { errorMessage, t } from "@ferrum/client";

export function Failure({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const status = (error as { status?: number } | null)?.status;
  const retry = onRetry && <Button onClick={onRetry}>{t("Try again")}</Button>;
  if (status === 0) return <StatePanel kind="offline" title={title} action={retry}>{errorMessage(error)}</StatePanel>;
  if (status === 401 || status === 403) return <StatePanel kind="denied" title={title}>{errorMessage(error)}</StatePanel>;
  return <StatePanel kind="failed" title={title} error={error} onRetry={onRetry} />;
}
