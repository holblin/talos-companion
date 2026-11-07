import FilePicker from "./FilePicker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTask } from "./useTask";
import { classes } from "./layout";
import {
  TextArea,
  TextField,
  Button,
  Checkbox,
  StatusLight,
  ToastQueue,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export type Profile = "lan" | "cloudflare" | "tailscale";
export type Integration = {
  profile: Profile;
  companion_url: string;
  omni_url: string;
  s3_endpoint: string;
};
type Status = {
  integration: Integration;
  defaults: Integration;
  active_issuer: string;
  mounted: boolean;
  restart_pending: boolean;
};
type Connection = {
  available: boolean;
  bundled: boolean;
  backend_origin: string;
  saved: Integration | null;
  connection: null | {
    id: string;
    profile: Profile;
    state: string;
    message: string;
    auth_url: string | null;
    integration: Integration | null;
  };
};
type Checks = {
  checked_at: number;
  checks: {
    service: string;
    endpoint: string;
    ok: boolean;
    message: string;
    vantage: string;
  }[];
  note: string;
  omni_to_s3_verified: boolean;
};
type Plan = {
  revision: string;
  changes: string[];
  overlay: string;
  s3_resource: string;
  mounted: boolean;
  source_checked: boolean;
  callback: string;
  note: string;
};
function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/yaml" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
export default function SetupFlow({
  mode,
  initial,
  onDone,
}: {
  mode: "access" | "omni";
  initial: Integration;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const integration = useQuery({
    queryKey: ["omni"],
    queryFn: () => api<Status>("/api/omni"),
  });
  const status = integration.data ?? null;
  const [draft, setSettings] = useState<Integration | null>(initial);
  const settings = draft ??
    status?.defaults ?? {
      profile: "lan",
      companion_url: "",
      omni_url: "",
      s3_endpoint: "",
    };
  const [companionVerified, setCompanionVerified] = useState(false);
  const [trustInstalled, setTrustInstalled] = useState(false);
  const [localPrepared, setLocalPrepared] = useState(false);
  const [step, setStep] = useState(
    mode === "access"
      ? initial.companion_url.startsWith("https://")
        ? 3
        : 2
      : 4,
  );
  const [omniAddress, setOmniAddress] = useState<string | null>(null);
  const [certificate, setCertificate] = useState("");
  const [domain, setDomain] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [checking, setChecking] = useState(false);
  async function verify(endpoints: Integration) {
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await api<Checks>("/api/omni/check", endpoints));
    } finally {
      setChecking(false);
    }
  }
  const connection = useQuery({
    queryKey: ["omni-connection"],
    queryFn: () => api<Connection>("/api/omni/connection"),
    refetchInterval: (query) =>
      ["starting", "authorizing", "configuring"].includes(
        query.state.data?.connection?.state ?? "",
      )
        ? 2000
        : query.state.data?.bundled && !query.state.data.available
          ? 2000
          : false,
  });
  const job = connection.data?.connection;
  const appliedConnection = useRef("");
  const startedConnection = useRef("");
  useEffect(() => {
    if (
      mode === "access" &&
      job?.profile === initial.profile &&
      job.state === "connected" &&
      job.integration &&
      status &&
      appliedConnection.current !== job.id
    ) {
      appliedConnection.current = job.id;
      if (startedConnection.current === job.id || !initial.companion_url) {
        setStep(3);
        setSettings(job.integration);
        setChecks(null);
        setPlan(null);
        setAccepted(false);
        setCompanionVerified(false);
      }
    }
  }, [job, status, mode, initial.profile, initial.companion_url]);
  const connecting = ["starting", "authorizing", "configuring"].includes(
    job?.state ?? "",
  );
  const [importFile, setImportFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [accepted, setAccepted] = useState(false);
  const { busy, notice, setNotice, work } = useTask({ toastErrors: true });
  function change(name: keyof Integration, value: string) {
    setSettings((previous) => ({ ...(previous ?? settings), [name]: value }));
    setPlan(null);
    setChecks(null);
    setAccepted(false);
    setNotice("");
  }

  const address = omniAddress ?? connection.data?.backend_origin ?? "";
  const allReady =
    checks?.checks.length === 3 && checks.checks.every((result) => result.ok);
  const provider =
    settings.profile === "cloudflare" ? "Cloudflare" : "Tailscale";
  const addresses = (
    <dl>
      {(
        [
          ["companion_url", "Companion"],
          ["omni_url", "Omni"],
          ["s3_endpoint", "Backup receiver"],
        ] as const
      ).map(([name, label]) => (
        <div key={name}>
          <dt>{label}</dt>
          <dd>{settings[name] || "We’ll configure this automatically."}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <section className={classes("card omni-setup")}>
      <div className={classes("eyebrow")}>
        {mode === "access" ? "COMPANION ACCESS" : "OMNI CONFIGURATION"}
      </div>
      <h2>
        {mode === "access"
          ? settings.profile === "lan"
            ? "Local HTTPS"
            : provider
          : "Configure your Omni"}
      </h2>
      <p>
        Active Omni identity-provider URL:{" "}
        <code>{status?.active_issuer ?? "Loading…"}</code>
      </p>
      <p>
        {mode === "access"
          ? step === 2
            ? "Step 1 of 2 · Prepare HTTPS"
            : "Step 2 of 2 · Verify and save"
          : step === 4
            ? "Step 2 of 3 · Find Omni"
            : "Step 3 of 3 · Check and configure"}
      </p>
      {integration.error && <p role="alert">{integration.error.message}</p>}
      {step === 2 && settings.profile === "lan" && (
        <>
          <h3>Prepare local HTTPS</h3>
          <p>
            Companion creates a certificate on its existing web port. Install
            its public trust certificate on your devices and on the Omni host
            before using it for sign-in. Local access requires Omni to reach
            this network. If you opened this page through a cloud route, enter
            your local hostname or IP under Advanced settings before preparing
            HTTPS.
          </p>
          <Button
            variant="accent"
            isDisabled={busy}
            onPress={() => {
              void work(async () => {
                const url = new URL(
                  settings.companion_url.startsWith("https://")
                    ? settings.companion_url
                    : window.location.origin,
                );
                const port =
                  url.port || (url.protocol === "http:" ? "80" : "443");
                url.protocol = "https:";
                url.port = port;
                const result = await api<{ companion_url: string }>(
                  "/api/companion/local",
                  { profile: "lan", companion_url: url.origin },
                );
                setSettings({
                  ...settings,
                  companion_url: result.companion_url,
                  s3_endpoint: result.companion_url,
                });
                setLocalPrepared(true);
                setCompanionVerified(false);
              });
            }}
          >
            Prepare local HTTPS
          </Button>
          {localPrepared && (
            <>
              <p>
                <a href="/api/companion/ca">
                  Download Companion trust certificate
                </a>
              </p>
              <p>
                Import this certificate into your operating system’s trusted
                root certificates. On the Omni host, add it to the trust store
                used by Omni. Then open the HTTPS address and confirm it loads
                without a certificate warning.
              </p>
              <p>
                <a
                  href={settings.companion_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Companion over HTTPS ↗
                </a>
              </p>
              <Checkbox
                isSelected={trustInstalled}
                onChange={setTrustInstalled}
              >
                I installed the certificate and opened Companion over HTTPS
                without a warning.
              </Checkbox>
            </>
          )}
          <details>
            <summary>Advanced settings</summary>
            <TextField
              label="Companion HTTPS address"
              value={settings.companion_url}
              onChange={(value) => {
                change("companion_url", value);
                setCompanionVerified(false);
              }}
              description="Use an existing trusted reverse proxy if you already have one. A local certificate uses the same published port as this page."
            />
          </details>
          <Button
            variant="secondary"
            onPress={() => {
              onDone();
            }}
          >
            Back
          </Button>
          <Button
            variant="accent"
            isDisabled={
              busy ||
              (localPrepared && !trustInstalled) ||
              !settings.companion_url.startsWith("https://")
            }
            onPress={() => {
              setStep(3);
            }}
          >
            Continue
          </Button>
        </>
      )}
      {step === 3 && mode === "access" && (
        <>
          <h3>Verify and save Companion access</h3>
          <p>
            <code>{settings.companion_url}</code>
          </p>
          <p>
            We verify HTTPS, this installation’s identity, OpenID discovery and
            signing keys. Saving this method keeps every other access method and
            the active Omni issuer unchanged.
          </p>
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              void work(async () => {
                setCompanionVerified(false);
                await api("/api/companion/check", {
                  profile: settings.profile,
                  companion_url: settings.companion_url,
                });
                setCompanionVerified(true);
              });
            }}
          >
            Verify Companion HTTPS
          </Button>
          {companionVerified && (
            <StatusLight variant="positive">
              Companion HTTPS and identity verified
            </StatusLight>
          )}
          <details>
            <summary>Advanced settings</summary>
            <TextField
              label="Companion HTTPS address"
              value={settings.companion_url}
              onChange={(value) => {
                change("companion_url", value);
                setCompanionVerified(false);
              }}
            />
          </details>
          <Button
            variant="secondary"
            onPress={() => {
              setStep(2);
            }}
          >
            Back
          </Button>
          <Button
            variant="accent"
            isDisabled={busy || !companionVerified}
            onPress={() => {
              void work(async () => {
                await api("/api/companion/access", {
                  profile: settings.profile,
                  companion_url: settings.companion_url,
                });
                await queryClient.invalidateQueries({
                  queryKey: ["companion-access"],
                });
                ToastQueue.positive(
                  "Companion access saved. Your other methods and Omni issuer are unchanged.",
                );
                onDone();
              });
            }}
          >
            Save access method
          </Button>
        </>
      )}
      {step === 4 && (
        <>
          <h3>Where do you open Omni?</h3>
          <p>
            Companion is ready at{" "}
            <a href={settings.companion_url} target="_blank" rel="noreferrer">
              {settings.companion_url}
            </a>
            . Opening a different hostname may require signing in again.
          </p>
          <p>
            {address
              ? "We found this address in your settings. Confirm it or paste the address you normally use."
              : "Paste the address you use to open Omni. You don’t need to change Docker settings."}
          </p>
          <TextField
            label="Omni address"
            value={address}
            onChange={setOmniAddress}
            placeholder="omni.example.com"
            isDisabled={busy}
            description="A hostname is enough. You can also paste a complete web address."
            styles={style({ width: "full", marginY: 12 })}
          />
          <details>
            <summary>Advanced settings</summary>
            <TextArea
              label="Public trust certificate (optional)"
              value={certificate}
              onChange={setCertificate}
              description="Only for an Omni server using a private certificate authority. Paste its public PEM certificate, never a private key."
              styles={style({ width: "full", marginY: 12 })}
            />
          </details>
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              onDone();
            }}
          >
            Back
          </Button>
          <Button
            variant="accent"
            isDisabled={busy || !address.trim()}
            onPress={() => {
              void work(async () => {
                const result = await api<{ origin: string }>(
                  "/api/omni/location",
                  { address: address.trim(), certificate },
                );
                setOmniAddress(result.origin);
                const endpoints = {
                  ...settings,
                  omni_url:
                    settings.profile === "lan"
                      ? result.origin
                      : settings.omni_url,
                };
                setSettings(endpoints);
                setStep(5);
                await verify(endpoints);
              });
            }}
          >
            {busy ? "Finding Omni…" : "Continue"}
          </Button>
        </>
      )}
      {step === 2 && settings.profile !== "lan" && (
        <>
          <h3>Connect {provider}</h3>
          <p>
            {settings.profile === "cloudflare"
              ? "Sign in to Cloudflare and approve your domain. We’ll create the tunnel and addresses for you."
              : "Sign in to Tailscale and approve this Companion device. We’ll configure private HTTPS access for you."}
          </p>
          {!connection.data?.available && (
            <div role="status">
              <p>
                {connection.data?.bundled
                  ? "Preparing the built-in connection service…"
                  : "Cloud connections are included in the Companion Docker image. Update Companion to enable them."}
              </p>
              <Button
                variant="secondary"
                isDisabled={connection.isFetching}
                onPress={() => {
                  void connection.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          )}
          {connection.error && (
            <p role="alert">
              Could not check the connection service. Try again.
            </p>
          )}
          {settings.profile === "cloudflare" && (
            <TextField
              label="Your Cloudflare domain"
              value={domain}
              onChange={(value) => {
                setDomain(value);
                setAuthorized(false);
              }}
              placeholder="example.com"
              description="For example: example.com. We’ll create companion, omni and backup addresses under it."
              isDisabled={busy || connecting}
              styles={style({ width: "full", marginY: 12 })}
            />
          )}
          {!connecting && (
            <Checkbox
              isSelected={authorized}
              onChange={setAuthorized}
              isDisabled={busy}
              styles={style({ width: "full", marginY: 12 })}
            >
              {settings.profile === "cloudflare"
                ? "Allow public access to Companion, Omni and the protected backup receiver through this domain."
                : "Allow my Tailscale devices to access Companion, Omni and the backup receiver."}
            </Checkbox>
          )}
          {job?.profile === settings.profile &&
            job.state === "authorizing" &&
            job.auth_url && (
              <p>
                <a href={job.auth_url} target="_blank" rel="noreferrer">
                  Sign in to {provider} ↗
                </a>
              </p>
            )}
          {connecting && (
            <p role="status">
              {job?.auth_url
                ? "Approve the request in the sign-in page, then return here. We’ll continue automatically."
                : "Preparing your connection…"}
            </p>
          )}
          {connecting && (
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => {
                void work(async () => {
                  if (job) appliedConnection.current = job.id;
                  startedConnection.current = "";
                  await api("/api/omni/connection", undefined, "DELETE");
                  await queryClient.invalidateQueries({
                    queryKey: ["omni-connection"],
                  });
                  onDone();
                });
              }}
            >
              Cancel sign-in
            </Button>
          )}
          {job?.profile === settings.profile &&
            ["failed", "expired"].includes(job.state) && (
              <p role="status">
                {job.state === "expired"
                  ? "The sign-in request expired. Try again when you’re ready."
                  : "We couldn’t finish the connection. Check the account and domain you approved, then try again."}
              </p>
            )}
          <Button
            variant="secondary"
            isDisabled={busy || connecting}
            onPress={() => {
              onDone();
            }}
          >
            Back
          </Button>
          <Button
            variant="accent"
            isDisabled={
              busy ||
              connecting ||
              !authorized ||
              !connection.data?.available ||
              (settings.profile === "cloudflare" && !domain.trim())
            }
            onPress={() => {
              void work(async () => {
                const result = await api<{ id: string }>(
                  "/api/omni/connection",
                  { profile: settings.profile, domain: domain.trim() },
                );
                startedConnection.current = result.id;
                await queryClient.invalidateQueries({
                  queryKey: ["omni-connection"],
                });
              });
            }}
          >
            {connecting ? "Connecting…" : "Connect " + provider}
          </Button>
        </>
      )}
      {step === 5 && (
        <>
          <h3>
            {checking
              ? "Checking your connection"
              : allReady
                ? "Network checks passed"
                : "Let’s check your services"}
          </h3>
          {checking && (
            <p role="status">
              Checking Companion, Omni and the backup receiver…
            </p>
          )}
          {checks && (
            <section aria-label="Live connection checks">
              <ul>
                {checks.checks.map((result) => (
                  <li key={result.service}>
                    <StatusLight variant={result.ok ? "positive" : "negative"}>
                      {result.service}:{" "}
                      {result.ok
                        ? result.service === "Omni"
                          ? "Reachable"
                          : "Verified"
                        : "Needs attention"}
                    </StatusLight>
                    {!result.ok && <p>{result.message}</p>}
                  </li>
                ))}
              </ul>
              <p>
                These checks run from Companion. Your first Omni backup will
                also verify the connection from Omni.
              </p>
            </section>
          )}
          {addresses}
          {settings.companion_url !== status?.active_issuer && (
            <Button
              variant="accent"
              onPress={() => {
                setCompanionVerified(false);

                onDone();
              }}
            >
              Select a verified Companion access method
            </Button>
          )}
          <Button
            variant="secondary"
            isDisabled={busy || connecting}
            onPress={() => {
              setStep(4);
            }}
          >
            Back
          </Button>
          <Button
            variant="secondary"
            isDisabled={busy || connecting}
            onPress={() => {
              void work(async () => {
                await verify(settings);
              });
            }}
          >
            Check again
          </Button>
          <Button
            variant="accent"
            isDisabled={
              busy ||
              !allReady ||
              settings.companion_url !== status?.active_issuer
            }
            onPress={() => {
              void work(async () => {
                await api("/api/omni/connection/finish", settings);
                await queryClient.invalidateQueries({ queryKey: ["omni"] });
                await queryClient.invalidateQueries({
                  queryKey: ["admin"],
                });
                await queryClient.invalidateQueries({
                  queryKey: ["omni-connection"],
                });
                ToastQueue.positive(
                  "Network checks passed. Finish the Omni configuration below.",
                );
              });
            }}
          >
            Save verified network
          </Button>
          <details>
            <summary>Advanced settings</summary>
            <div>
              <h4>Manual addresses</h4>
              <p>
                Override advertised addresses for an existing proxy or custom
                deployment. Changing an address does not create a listener,
                certificate or proxy route.
              </p>
              {settings.profile === "lan" && status?.mounted && (
                <p>
                  <a href="/api/omni/ca">Download LAN trust certificate</a>
                  {" · "}
                  <a href="/api/omni/talos-ca">
                    Download Talos trust configuration
                  </a>
                </p>
              )}
              {(
                [
                  ["companion_url", "Companion address"],
                  ["omni_url", "Omni address"],
                  ["s3_endpoint", "S3 receiver address"],
                ] as const
              ).map(([name, label]) => (
                <TextField
                  key={name}
                  type="url"
                  label={label}
                  value={settings[name]}
                  onChange={(value) => {
                    change(name, value);
                  }}
                  isDisabled={busy || connecting || name === "companion_url"}
                  styles={style({ width: "full", marginY: 12 })}
                />
              ))}
            </div>
            <details>
              <summary>Import / repair an existing instance</summary>
              <p>
                Upload its main YAML/JSON configuration. It is inspected in
                memory; private keys are not needed. The checker covers OIDC and
                S3 enablement only. Existing CLI flags or later config files can
                override these values.
              </p>
              <FilePicker
                label="Import Omni configuration (maximum 256 KiB)"
                file={importFile}
                acceptedFileTypes={[".yaml", ".yml", ".json"]}
                isDisabled={busy}
                onChange={(file) => {
                  if (file)
                    void work(async () => {
                      if (file.size > 262144)
                        throw new Error("Configuration exceeds 256 KiB");
                      const text = await file.text();
                      const discovered = await api<{
                        omni_url: string | null;
                      }>("/api/omni/discover", { primary_config: text });
                      if (discovered.omni_url && settings.profile === "lan")
                        change("omni_url", discovered.omni_url);
                      setSource(text);
                      setImportFile(file);
                      setPlan(null);
                      setAccepted(false);
                      setNotice(
                        "Configuration imported for inspection. It has not been applied.",
                      );
                    });
                }}
              />
              <TextArea
                label="Or paste configuration"
                value={source}
                onChange={(value) => {
                  setSource(value);
                  setPlan(null);
                  setAccepted(false);
                }}
                styles={style({ width: "full", marginY: 16 })}
              />
            </details>
            {source.trim() && (
              <Button
                type="button"
                variant="secondary"
                isDisabled={busy}
                onPress={() => {
                  void work(async () => {
                    const discovered = await api<{
                      omni_url: string | null;
                    }>("/api/omni/discover", { primary_config: source });
                    if (discovered.omni_url)
                      change("omni_url", discovered.omni_url);
                    setNotice(
                      discovered.omni_url
                        ? "Omni address discovered from the imported configuration."
                        : "No advertised Omni address was found in this configuration.",
                    );
                  });
                }}
              >
                Discover Omni address from configuration
              </Button>
            )}
            <p>
              <a
                href="https://github.com/holblin/talos-companion/blob/main/docs/home-setup.md"
                target="_blank"
                rel="noreferrer"
              >
                Home installation, certificates and migration tutorial ↗
              </a>
            </p>
            {status?.restart_pending && (
              <p role="status">
                An issuer migration is saved. Prepare HTTPS, restart Companion,
                and open {status.integration.companion_url}. The active issuer
                is still {status.active_issuer}.
              </p>
            )}
          </details>
          <h3>Finish configuring Omni</h3>
          <p>
            Companion HTTPS is active. Omni still needs the sign-in overlay and
            backup resource below. Apply them to Omni, restart Omni, then test
            sign-in and make a real backup.
          </p>
          <Button
            isDisabled={busy}
            onPress={() => {
              void work(async () => {
                setPlan(
                  await api<Plan>("/api/omni/plan", {
                    integration: settings,
                    primary_config: source,
                  }),
                );
                setAccepted(false);
              });
            }}
            type="button"
            variant="accent"
          >
            Check configuration & preview
          </Button>
          {plan && (
            <div className={classes("recovery-box")}>
              <h3>
                {plan.changes.length
                  ? `${String(plan.changes.length)} managed settings need adjustment`
                  : "Managed settings match"}
              </h3>
              {!plan.source_checked && (
                <p>
                  No primary configuration was supplied. This is a proposed
                  configuration, not verification of a running instance.
                </p>
              )}
              <ul>
                {plan.changes.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
              <p>
                Callback: <code>{plan.callback}</code>
              </p>
              <p>{plan.note}</p>
              <p className={classes("hint")}>
                Downloads contain credentials. Store them privately. TLS,
                storage, account UUID, initial administrator roles and EULA
                acceptance are not rewritten by this repair.
              </p>
              <Button
                isDisabled={busy}
                onPress={() => {
                  download("companion-overlay.yaml", plan.overlay);
                }}
                type="button"
                variant="secondary"
              >
                Download Omni overlay
              </Button>{" "}
              <Button
                isDisabled={busy}
                onPress={() => {
                  download("companion-s3.yaml", plan.s3_resource);
                }}
                type="button"
                variant="secondary"
              >
                Download S3 resource
              </Button>
              <Checkbox
                isSelected={accepted}
                onChange={(value) => {
                  setAccepted(value);
                }}
                styles={style({ width: "full", marginY: 12 })}
              >
                {" "}
                Switch Omni sign-in to this Companion, enable S3 backups, and
                register the shown callback. I have prepared HTTPS and a
                recovery copy.
              </Checkbox>
              <Button
                variant="accent"
                isDisabled={
                  busy ||
                  !accepted ||
                  !allReady ||
                  status?.active_issuer !== settings.companion_url
                }
                onPress={() => {
                  void work(async () => {
                    await api("/api/oidc", { redirect_uri: plan.callback });
                    await queryClient.invalidateQueries({
                      queryKey: ["admin"],
                    });
                    ToastQueue.positive(
                      "Omni callback registered. Apply the downloaded configuration in Omni, then test sign-in and a backup.",
                    );
                  });
                }}
              >
                Register Omni callback
              </Button>
              <Button
                isDisabled={
                  busy ||
                  !accepted ||
                  !plan.mounted ||
                  !checks?.checks.every((result) => result.ok)
                }
                onPress={() => {
                  void work(async () => {
                    await api("/api/omni/apply", {
                      integration: settings,
                      primary_config: source,
                      revision: plan.revision,
                    });
                    setPlan(null);
                    await queryClient.invalidateQueries({
                      queryKey: ["omni"],
                    });
                    setNotice(
                      "Overlay saved. Restart Omni after activating it and apply the downloaded S3 resource. Companion’s HTTPS identity provider is already active.",
                    );
                  });
                }}
                type="button"
                variant="accent"
              >
                Apply managed Omni configuration
              </Button>
              {!plan.mounted && (
                <p className={classes("hint")}>
                  Apply these files using Omni’s administration tools. Companion
                  cannot restart a remote Omni server.
                </p>
              )}
            </div>
          )}

          <details>
            <summary>Connection details</summary>
            {job?.message}
          </details>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
