import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { Link } from "@react-spectrum/s2/Link";
import { ToastQueue } from "@react-spectrum/s2/Toast";
import { api } from "./api";
import Panel from "./Panel";
import Field from "./Field";
import RemoveAction from "./RemoveAction";
import { documentClass } from "./layout";
import { useTask } from "./useTask";
import type { AccessCatalog } from "./AccessPages";
import type { Integration } from "./OmniSetup";

type Health = {
  results: {
    integration: Integration;
    available: boolean;
    local_dns_pending: boolean;
    message?: string;
  }[];
};
export default function PublicUrls({
  catalog,
  onEdit,
}: {
  catalog: AccessCatalog;
  onEdit: (integration: Integration) => void;
}) {
  const client = useQueryClient();
  const [url, setUrl] = useState(window.location.origin);
  const [migration, setMigration] = useState<string | null>(null);
  const { busy, work } = useTask({ toastErrors: true });
  const health = useQuery({
    queryKey: ["public-url-health", catalog.accesses],
    queryFn: () => api<Health>("/api/companion/access/health", {}, "POST"),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: catalog.accesses.length > 0,
  });
  async function refresh() {
    await client.invalidateQueries({ queryKey: ["companion-access"] });
    await client.invalidateQueries({ queryKey: ["public-url-health"] });
    await client.invalidateQueries({ queryKey: ["admin"] });
    await client.invalidateQueries({ queryKey: ["omni"] });
  }
  const currentMissing =
    !catalog.accesses.some(
      (a) => a.integration.companion_url === window.location.origin,
    ) && catalog.active_issuer !== window.location.origin;
  return (
    <Panel label="Public URLs">
      <h2 className={documentClass("h2")}>Public URLs</h2>
      <p className={documentClass("p")}>
        Active public URL:{" "}
        <code className={documentClass("code")}>{catalog.active_issuer}</code>
      </p>
      <p className={documentClass("p")}>
        Add addresses without restarting Docker. Changing the active URL
        requires updating Omni’s identity-provider configuration.
      </p>
      {currentMissing && (
        <p className={documentClass("p")} role="status">
          You’re using a different address. Verify and add this browser address,
          or migrate to it after verification.
        </p>
      )}
      <Field
        label="Additional public URL"
        type="url"
        value={url}
        onChange={setUrl}
        description="HTTPS origin without a path. Existing URLs remain saved."
      />
      <ButtonGroup>
        <Button
          isDisabled={busy || !url.trim()}
          onPress={() => {
            onEdit({
              profile: "lan",
              companion_url: url.trim(),
              omni_url: "",
              s3_endpoint: url.trim(),
            });
          }}
        >
          Verify and add URL
        </Button>
        <Button
          variant="secondary"
          isDisabled={
            busy || health.isFetching || catalog.accesses.length === 0
          }
          onPress={() => {
            void health.refetch();
          }}
        >
          Check saved URLs
        </Button>
      </ButtonGroup>
      {health.isFetching && (
        <p className={documentClass("p")} role="status">
          Checking saved URLs and this installation’s identity…
        </p>
      )}
      {health.error && (
        <p className={documentClass("p")} role="alert">
          Could not check saved URLs. {health.error.message}
        </p>
      )}
      {catalog.accesses.map((access) => {
        const integration = access.integration;
        const key = integration.profile + integration.companion_url;
        const result = health.data?.results.find(
          (r) =>
            r.integration.profile === integration.profile &&
            r.integration.companion_url === integration.companion_url,
        );
        const active = integration.companion_url === catalog.active_issuer;
        const providerActive =
          catalog.active_profile === integration.profile ||
          catalog.accesses.some(
            (entry) =>
              entry.integration.profile === integration.profile &&
              entry.integration.companion_url === catalog.active_issuer,
          );
        const providerName =
          integration.profile === "tailscale" ? "Tailscale" : "Cloudflare";
        return (
          <section key={key} aria-label={integration.companion_url}>
            <h3 className={documentClass("h3")}>{integration.companion_url}</h3>
            <p className={documentClass("p")}>
              {active ? "Active public URL · " : "Additional URL · "}
              {result
                ? result.available
                  ? result.local_dns_pending
                    ? "Verified; local DNS updating"
                    : "Available"
                  : "Unavailable — check routing and certificate trust, migrate to a working URL, or remove this entry."
                : "Not checked yet"}
            </p>
            {result?.message && (
              <p className={documentClass("p")}>{result.message}</p>
            )}
            {!active && result?.available && (
              <Checkbox
                isSelected={migration === key}
                onChange={(selected) => {
                  setMigration(selected ? key : null);
                }}
                isDisabled={busy}
              >
                Use this as the active public URL. I will update Omni’s sign-in
                configuration.
              </Checkbox>
            )}
            <ButtonGroup>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => {
                  onEdit(integration);
                }}
              >
                Update URL
              </Button>
              {!active && result?.available && (
                <Button
                  isDisabled={busy || migration !== key}
                  onPress={() => {
                    void work(async () => {
                      await api("/api/companion/access", {
                        profile: integration.profile,
                        companion_url: integration.companion_url,
                      });
                      await api("/api/companion/activate", {
                        profile: integration.profile,
                        companion_url: integration.companion_url,
                      });
                      setMigration(null);
                      await refresh();
                    });
                  }}
                >
                  Migrate public URL
                </Button>
              )}
              <RemoveAction
                title="Remove public URL?"
                isDisabled={busy || active}
                disabledReason={
                  active
                    ? "Migrate to a working URL before removing the active public URL."
                    : undefined
                }
                onRemove={() => {
                  void work(async () => {
                    await api(
                      "/api/companion/access",
                      {
                        profile: integration.profile,
                        companion_url: integration.companion_url,
                      },
                      "DELETE",
                    );
                    await refresh();
                  });
                }}
              >
                This removes the saved address. Provider tunnels keep running.
                Check that clients have migrated before removing it.
              </RemoveAction>
              {integration.profile !== "lan" && (
                <RemoveAction
                  title={`Disconnect ${providerName} and clean up?`}
                  actionLabel={`Disconnect ${providerName}`}
                  isDisabled={
                    busy ||
                    providerActive ||
                    window.location.origin === integration.companion_url
                  }
                  disabledReason={
                    providerActive
                      ? "Migrate the active public URL to another provider or Local HTTPS first."
                      : window.location.origin === integration.companion_url
                        ? "Open Companion through another access method before disconnecting this provider."
                        : undefined
                  }
                  onRemove={() => {
                    void work(async () => {
                      const result = await api<{ message: string }>(
                        "/api/companion/access",
                        {
                          profile: integration.profile,
                          companion_url: integration.companion_url,
                          cleanup_provider: true,
                        },
                        "DELETE",
                      );
                      await refresh();
                      ToastQueue.positive(result.message);
                    });
                  }}
                >
                  {integration.profile === "tailscale"
                    ? "Disconnect the entire Companion Tailscale device, clear its HTTPS routes, expire its node key by logging out, and remove its local identity. All saved Tailscale URLs are removed. Omni and backups using this device will stop working. An expired device record may remain in the Tailscale admin console; delete it there if needed. This does not revoke account-wide permissions."
                    : "Disconnect the entire Companion Cloudflare tunnel and delete its managed DNS routes and local credentials. All saved Cloudflare URLs are removed. Omni and backups using this tunnel will stop working. Other tunnels and unrelated DNS records are preserved. Account-wide Cloudflare authorization is not revoked; manage it in Cloudflare if needed."}
                </RemoveAction>
              )}
            </ButtonGroup>
          </section>
        );
      })}
      <p className={documentClass("p")}>
        <Link href="/omni-configuration">
          Update Omni configuration after migrating
        </Link>
      </p>
    </Panel>
  );
}
