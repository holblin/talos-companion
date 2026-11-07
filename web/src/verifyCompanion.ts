import { api, ApiError } from "./api";
import type { Integration } from "./OmniSetup";

export type CompanionVerification = { local_dns_pending?: boolean };
export const cloudflareDnsPendingMessage =
  "Cloudflare is ready; local DNS access is still updating. The address is saved. Choose Check Cloudflare again after your DNS cache refreshes.";

// A newly created DNS record can be hidden by a cached wildcard or negative
// answer for several minutes, even after the provider has configured its route.
export async function waitForCompanion(
  endpoints: Integration,
  signal: AbortSignal,
  onVerified?: (result: CompanionVerification) => void,
): Promise<boolean> {
  const deadline = Date.now() + 600_000;
  const cancelled = () => signal.aborted;
  while (!cancelled()) {
    try {
      const result = await api<CompanionVerification>("/api/companion/check", {
        profile: endpoints.profile,
        companion_url: endpoints.companion_url,
      });
      if (cancelled()) return false;
      onVerified?.(result);
      return true;
    } catch (error) {
      if (cancelled()) return false;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        throw error;
      if (Date.now() >= deadline)
        throw new Error(
          "Provider routes are configured, but Companion HTTPS could not be verified after 10 minutes. Check DNS and certificate trust, then save again to retry verification.",
          { cause: error },
        );
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(5000, deadline - Date.now()));
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  return false;
}
