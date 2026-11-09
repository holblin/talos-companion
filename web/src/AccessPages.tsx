import Panel from "./Panel";
import { Link } from "@react-spectrum/s2/Link";
import { documentClass } from "./layout";
import { type ReactNode, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@react-spectrum/s2/Button";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { Picker, PickerItem } from "@react-spectrum/s2/Picker";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { ToastQueue } from "@react-spectrum/s2/Toast";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import { Dialog } from "@react-spectrum/s2/Dialog";
import { DialogContainer } from "@react-spectrum/s2/Dialog";
import { Heading } from "@react-spectrum/s2/Heading";
import { Content } from "@react-spectrum/s2/Content";
import { ContextualHelp } from "@react-spectrum/s2/ContextualHelp";
import Refresh from "@react-spectrum/s2/icons/Refresh";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
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
  return (
    <section>
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
            <Panel key={method.profile} label={method.name}>
              <div
                className={style({
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                })}
              >
                <h3 className={documentClass("h3", style({ marginBottom: 0 }))}>
                  {method.name}
                </h3>
                <ContextualHelp aria-label={method.name + " information"}>
                  <Heading>{method.name}</Heading>
                  <Content>
                    <p className={documentClass("p")}>
                      {method.description} Adding access keeps existing methods
                      running and does not change Omni’s identity provider.
                    </p>
                    {saved?.verified_at ? (
                      <p>
                        Last verified:{" "}
                        {new Date(saved.verified_at * 1000).toLocaleString()}
                      </p>
                    ) : null}
                    {method.profile === "lan" &&
                      saved &&
                      catalog.data?.local_ca_available && (
                        <p>
                          <Link href="/api/companion/ca" download>
                            Download local trust certificate
                          </Link>
                        </p>
                      )}
                  </Content>
                </ContextualHelp>
              </div>
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
                </>
              )}
              <div
                className={style({
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginTop: 16,
                })}
              >
                <Button
                  aria-label={(saved ? "Manage " : "Add ") + method.name}
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
                  {saved ? "Manage" : "Add access"}
                </Button>
                {saved && (
                  <ActionButton
                    aria-label={"Check " + method.name}
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
                    <Refresh />
                  </ActionButton>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
      <DialogContainer
        onDismiss={() => {
          setEditing(null);
        }}
      >
        {editing && (
          <Dialog size="L" isDismissible aria-label="Manage access method">
            <Heading slot="title">
              {methods.find((m) => m.profile === editing.profile)?.name} access
            </Heading>
            <Content>
              <SetupFlow
                key={editing.profile}
                mode="access"
                initial={editing}
                onDone={() => {
                  setEditing(null);
                }}
              />
            </Content>
          </Dialog>
        )}
      </DialogContainer>
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
      <Panel>
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
            <Link href="/access">Set up Companion access →</Link>
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
              <Link href="/access">Manage Companion access methods</Link>
            </p>
          </>
        )}
      </Panel>
      {verified.length > 0 && children}
    </>
  );
}
