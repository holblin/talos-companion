import { documentClass } from "./layout";
import { type ReactNode, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  Picker,
  PickerItem,
  StatusLight,
  ToastQueue,
} from "@react-spectrum/s2";
import { api } from "./api";
import { classes } from "./layout";
import { useTask } from "./useTask";
import {
  cloudflareDnsPendingMessage,
  type CompanionVerification,
} from "./verifyCompanion";
import SetupFlow, { type Integration, type Profile } from "./OmniSetup";
import ContextHelp from "./ContextHelp";

export type AccessMethod = {
  integration: Integration;
  verified_at: number;
  local_dns_pending?: boolean;
};
export type AccessCatalog = {
  accesses: AccessMethod[];
  active_issuer: string;
  active_profile?: Profile | null;
  local_ca_available?: boolean;
};
const methods: { profile: Profile; name: string; description: string }[] = [
  {
    profile: "lan",
    name: "Local HTTPS",
    description:
      "HTTPS on your local network, using Companion’s certificate or an existing reverse proxy.",
  },
  {
    profile: "tailscale",
    name: "Tailscale",
    description: "Private HTTPS for devices and Omni hosts on your tailnet.",
  },
  {
    profile: "cloudflare",
    name: "Cloudflare",
    description:
      "Public HTTPS through your domain and a managed reverse tunnel.",
  },
];
function useAccessCatalog() {
  return useQuery({
    queryKey: ["companion-access"],
    queryFn: () => api<AccessCatalog>("/api/companion/access"),
  });
}
export function CompanionAccess() {
  const catalog = useAccessCatalog();
  const client = useQueryClient();
  const [editing, setEditing] = useState<Integration | null>(null);
  const { busy, work } = useTask({ toastErrors: true });
  if (editing)
    return (
      <SetupFlow
        key={editing.profile}
        mode="access"
        initial={editing}
        onDone={() => {
          setEditing(null);
        }}
      />
    );
  return (
    <section className={classes("card")}>
      <h2 className={documentClass("h2")}>Companion access</h2>
      <ContextHelp title="How Companion access methods work">
        <p className={documentClass("p")}>
          Configure any or all three methods. Adding access keeps your existing
          methods running and does not change Omni’s identity provider.
        </p>
      </ContextHelp>
      {catalog.data && (
        <p className={documentClass("p")}>
          Omni’s canonical issuer:{" "}
          <code className={documentClass("code")}>
            {catalog.data.active_issuer}
          </code>
        </p>
      )}
      {catalog.isPending && (
        <p className={documentClass("p")} role="status">
          Loading access methods…
        </p>
      )}
      {catalog.error && (
        <p className={documentClass("p")} role="alert">
          {catalog.error.message}
        </p>
      )}
      <div className={classes("three-cols")}>
        {methods.map((method) => {
          const saved = catalog.data?.accesses.find(
            (a) => a.integration.profile === method.profile,
          );
          return (
            <section
              key={method.profile}
              aria-label={method.name}
              className={classes("card")}
            >
              <h3 className={documentClass("h3")}>{method.name}</h3>
              <p className={documentClass("p")}>{method.description}</p>
              <StatusLight
                variant={
                  saved?.verified_at && !saved.local_dns_pending
                    ? "positive"
                    : "neutral"
                }
              >
                {saved?.local_dns_pending
                  ? "Cloudflare verified · local DNS updating"
                  : saved?.verified_at
                    ? "Verified access"
                    : saved
                      ? "Needs verification"
                      : "Not configured"}
              </StatusLight>
              {saved && (
                <>
                  {saved.local_dns_pending && (
                    <p className={documentClass("p")} role="status">
                      {cloudflareDnsPendingMessage}
                    </p>
                  )}
                  <p className={documentClass("p")}>
                    <code className={documentClass("code")}>
                      {saved.integration.companion_url}
                    </code>
                  </p>
                  {saved.verified_at > 0 && (
                    <p className={documentClass("p")}>
                      Last verified:{" "}
                      {new Date(saved.verified_at * 1000).toLocaleString()}
                    </p>
                  )}
                  {catalog.data?.active_issuer ===
                    saved.integration.companion_url &&
                    catalog.data.active_profile === method.profile && (
                      <p className={documentClass("p")}>
                        Selected for Omni’s identity provider.
                      </p>
                    )}
                </>
              )}
              <Button
                variant={saved ? "secondary" : "accent"}
                isDisabled={busy || catalog.isPending || !!catalog.error}
                onPress={() => {
                  setEditing(
                    saved?.integration ?? {
                      profile: method.profile,
                      companion_url: "",
                      omni_url: "",
                      s3_endpoint: "",
                    },
                  );
                }}
              >
                {saved ? "Manage " : "Add "}
                {method.name}
              </Button>
              {saved && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    void work(async () => {
                      try {
                        const result = await api<CompanionVerification>(
                          "/api/companion/access",
                          {
                            profile: method.profile,
                            companion_url: saved.integration.companion_url,
                          },
                        );
                        ToastQueue.positive(
                          result.local_dns_pending
                            ? cloudflareDnsPendingMessage
                            : method.name + " access verified.",
                        );
                      } finally {
                        await client.invalidateQueries({
                          queryKey: ["companion-access"],
                        });
                      }
                    });
                  }}
                >
                  Check {method.name}
                </Button>
              )}
              {method.profile === "lan" &&
                saved &&
                catalog.data?.local_ca_available && (
                  <p className={documentClass("p")}>
                    <a className={documentClass("a")} href="/api/companion/ca">
                      Download local trust certificate
                    </a>
                  </p>
                )}
            </section>
          );
        })}
      </div>
      <p className={documentClass("p")}>
        Once a method is verified, choose it in{" "}
        <a className={documentClass("a")} href="/omni-configuration">
          Omni configuration
        </a>
        . Each selection is checked again before use.
      </p>
    </section>
  );
}
export function OmniConfiguration({ children }: { children?: ReactNode } = {}) {
  const catalog = useAccessCatalog();
  const client = useQueryClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [configured, setConfigured] = useState<Integration | null>(null);
  const { busy, work } = useTask({ toastErrors: true });
  if (configured)
    return (
      <>
        <SetupFlow
          mode="omni"
          initial={configured}
          onDone={() => {
            setConfigured(null);
            setAccepted(false);
          }}
        />
        {children}
      </>
    );
  const verified =
    catalog.data?.accesses.filter((a) => a.verified_at > 0) ?? [];
  const selected = verified.find(
    (a) => a.integration.profile === profile,
  )?.integration;
  const changesIssuer =
    selected && selected.companion_url !== catalog.data?.active_issuer;
  return (
    <>
      <section className={classes("card")}>
        <h2 className={documentClass("h2")}>Omni configuration</h2>
        {catalog.isPending ? (
          <p className={documentClass("p")} role="status">
            Loading verified Companion access…
          </p>
        ) : catalog.error ? (
          <p className={documentClass("p")} role="alert">
            {catalog.error.message}
          </p>
        ) : verified.length === 0 ? (
          <>
            <h3 className={documentClass("h3")}>
              Configure Companion access first
            </h3>
            <p className={documentClass("p")}>
              Omni needs a verified HTTPS endpoint for Companion. Add Local
              HTTPS, Tailscale or Cloudflare before configuring Omni.
            </p>
            <a className={documentClass("a")} href="/access">
              Set up Companion access →
            </a>
          </>
        ) : (
          <>
            <p className={documentClass("p")}>
              Step 1 of 3 · Choose the access method Omni will use
            </p>
            <ContextHelp title="How Omni uses Companion access">
              <p className={documentClass("p")}>
                All configured access methods remain available. Companion
                advertises one canonical OpenID Connect issuer.
              </p>
            </ContextHelp>
            <p className={documentClass("p")}>
              Active identity-provider URL:{" "}
              <code className={documentClass("code")}>
                {catalog.data.active_issuer}
              </code>
            </p>
            <Picker
              label="Companion access for Omni"
              placeholder="Choose a verified access method"
              value={profile}
              isDisabled={busy}
              onChange={(value) => {
                setProfile(value as Profile);
                setAccepted(false);
              }}
            >
              {verified.map((access) => (
                <PickerItem
                  key={access.integration.profile}
                  id={access.integration.profile}
                >
                  {methods.find((m) => m.profile === access.integration.profile)
                    ?.name ?? access.integration.profile}
                </PickerItem>
              ))}
            </Picker>
            {selected && (
              <>
                <dl>
                  <dt className={documentClass("dt")}>
                    Companion identity provider
                  </dt>
                  <dd className={documentClass("dd")}>
                    <code className={documentClass("code")}>
                      {selected.companion_url}
                    </code>
                  </dd>
                  <dt className={documentClass("dt")}>S3 backup receiver</dt>
                  <dd className={documentClass("dd")}>
                    <code className={documentClass("code")}>
                      {selected.s3_endpoint}
                    </code>
                  </dd>
                </dl>
                {changesIssuer && (
                  <Checkbox
                    isSelected={accepted}
                    onChange={setAccepted}
                    isDisabled={busy}
                  >
                    Use this address as the canonical issuer. Existing Omni
                    sign-in configuration must be updated to use the new URL.
                  </Checkbox>
                )}
              </>
            )}
            <Button
              variant="accent"
              isDisabled={busy || !selected || (!!changesIssuer && !accepted)}
              onPress={() => {
                if (selected)
                  void work(async () => {
                    await api("/api/companion/activate", {
                      profile: selected.profile,
                      companion_url: selected.companion_url,
                    });
                    await client.invalidateQueries({
                      queryKey: ["companion-access"],
                    });
                    await client.invalidateQueries({ queryKey: ["omni"] });
                    await client.invalidateQueries({ queryKey: ["admin"] });
                    const latest = await api<{ defaults: Integration }>(
                      "/api/omni",
                    );
                    setConfigured(
                      latest.defaults.profile === selected.profile &&
                        latest.defaults.companion_url === selected.companion_url
                        ? latest.defaults
                        : selected,
                    );
                  });
              }}
            >
              Use this access for Omni
            </Button>
            <p className={documentClass("p")}>
              <a className={documentClass("a")} href="/access">
                Manage Companion access methods
              </a>
            </p>
          </>
        )}
      </section>
      {verified.length > 0 && children}
    </>
  );
}
