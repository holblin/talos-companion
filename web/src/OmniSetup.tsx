import { documentClass } from "./layout";
import FilePicker from "./FilePicker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTask } from "./useTask";
import { classes } from "./layout";
import { TextArea } from "@react-spectrum/s2/TextArea";
import { TextField } from "@react-spectrum/s2/TextField";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Checkbox } from "@react-spectrum/s2/Checkbox";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { ToastQueue } from "@react-spectrum/s2/Toast";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  waitForCompanion,
  cloudflareDnsPendingMessage,
  type CompanionVerification,
} from "./verifyCompanion";

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
  providers: Profile[];
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
  const [companionDnsPending, setCompanionDnsPending] = useState(false);
  const [autoCheck, setAutoCheck] = useState<Integration | null>(null);
  const [checkingCompanion, setCheckingCompanion] = useState(false);
  const [companionHint, setCompanionHint] = useState("");
  useEffect(() => {
    if (!autoCheck) return;
    const endpoints = autoCheck;
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted;
    async function check() {
      setCheckingCompanion(true);
      setCompanionHint("");
      try {
        if (
          await waitForCompanion(endpoints, controller.signal, (result) => {
            setCompanionDnsPending(!!result.local_dns_pending);
            setCompanionHint(
              result.local_dns_pending
                ? "Cloudflare is ready; local DNS access is still updating. Save this address to keep the verified Cloudflare configuration."
                : "",
            );
          })
        )
          setCompanionVerified(true);
      } catch (error) {
        if (!cancelled())
          setCompanionHint(
            error instanceof Error
              ? error.message
              : "Companion HTTPS verification failed",
          );
      } finally {
        if (!cancelled()) setCheckingCompanion(false);
      }
    }
    void check();
    return () => {
      controller.abort();
    };
  }, [autoCheck]);
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
  const providerIncluded =
    connection.data?.providers.includes(settings.profile) ?? false;
  const appliedConnection = useRef("");
  const startedConnection = useRef("");
  const configuredAccess = useRef(initial);
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
        configuredAccess.current = job.integration;
        setChecks(null);
        setPlan(null);
        setAccepted(false);
        setCompanionVerified(false);
        if (job.profile === "cloudflare") setAutoCheck(job.integration);
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
  const updateController = useRef<AbortController | null>(null);
  const pendingVerification = useRef(false);
  useEffect(() => () => updateController.current?.abort(), []);
  async function saveAccess() {
    let endpoints = settings;
    const controller = new AbortController();
    const cancelled = () => controller.signal.aborted;
    updateController.current = controller;
    if (
      settings.profile !== "lan" &&
      settings.companion_url.trim().replace(/\/$/, "") !==
        configuredAccess.current.companion_url.trim().replace(/\/$/, "")
    ) {
      if (
        settings.profile === "tailscale" &&
        window.location.hostname ===
          new URL(initial.companion_url || settings.companion_url).hostname
      ) {
        throw new Error(
          "Open Companion through Local HTTPS or Cloudflare before renaming Tailscale, so this page stays connected during the update.",
        );
      }
      setAutoCheck(null);
      setCompanionVerified(false);
      setNotice(`Updating ${provider} configuration…`);
      const { id } = await api<{ id: string }>("/api/omni/connection", {
        profile: settings.profile,
        companion_url: settings.companion_url.trim(),
      });
      const deadline = Date.now() + 600_000;
      let configured = false;
      while (Date.now() < deadline) {
        if (cancelled()) return;
        const current = await api<Connection>("/api/omni/connection");
        if (cancelled()) return;
        const update = current.connection;
        if (update?.id === id) {
          if (["failed", "expired"].includes(update.state))
            throw new Error(update.message);
          if (update.state === "connected" && update.integration) {
            endpoints = update.integration;
            configuredAccess.current = endpoints;
            pendingVerification.current = true;
            setSettings(endpoints);
            configured = true;
            break;
          }
          setNotice(update.message || `Updating ${provider} configuration…`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!configured)
        throw new Error(
          "Provider update timed out. Check the connection and try saving again.",
        );
    }
    if (pendingVerification.current) {
      setNotice(
        "Provider updated. Waiting for DNS caches and HTTPS certificates (up to 10 minutes), then verifying this Companion…",
      );
      if (!(await waitForCompanion(endpoints, controller.signal))) return;
    }
    const saved = await api<CompanionVerification>("/api/companion/access", {
      profile: endpoints.profile,
      companion_url: endpoints.companion_url,
    });
    pendingVerification.current = false;
    await queryClient.invalidateQueries({ queryKey: ["companion-access"] });
    ToastQueue.positive(
      saved.local_dns_pending
        ? cloudflareDnsPendingMessage
        : "Companion access saved. Your other methods and Omni issuer are unchanged.",
    );
    onDone();
  }
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
          <dt className={documentClass("dt")}>{label}</dt>
          <dd className={documentClass("dd")}>
            {settings[name] || "We’ll configure this automatically."}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <section
      className={mode === "omni" ? classes("card omni-setup") : undefined}
    >
      {mode === "omni" && (
        <h2 className={documentClass("h2")}>Configure your Omni</h2>
      )}
      {mode === "omni" && (
        <p className={documentClass("p")}>
          Active Omni identity-provider URL:{" "}
          <code className={documentClass("code")}>
            {status?.active_issuer ?? "Loading…"}
          </code>
        </p>
      )}
      <p className={documentClass("p")}>
        {mode === "access"
          ? step === 2
            ? "Step 1 of 2 · Prepare HTTPS"
            : "Step 2 of 2 · Verify and save"
          : step === 4
            ? "Step 2 of 3 · Find Omni"
            : "Step 3 of 3 · Check and configure"}
      </p>
      {integration.error && (
        <p className={documentClass("p")} role="alert">
          {integration.error.message}
        </p>
      )}
      {step === 2 && settings.profile === "lan" && (
        <>
          <h3 className={documentClass("h3")}>Prepare local HTTPS</h3>
          <p className={documentClass("p")}>
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
              <p className={documentClass("p")}>
                <a className={documentClass("a")} href="/api/companion/ca">
                  Download Companion trust certificate
                </a>
              </p>
              <p className={documentClass("p")}>
                Import this certificate into your operating system’s trusted
                root certificates. On the Omni host, add it to the trust store
                used by Omni. Then open the HTTPS address and confirm it loads
                without a certificate warning.
              </p>
              <p className={documentClass("p")}>
                <a
                  className={documentClass("a")}
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
          <details className={documentClass("details")}>
            <summary className={documentClass("summary")}>
              Advanced settings
            </summary>
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
          <ButtonGroup slot={null}>
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
          </ButtonGroup>
        </>
      )}
      {step === 3 && mode === "access" && (
        <>
          <h3 className={documentClass("h3")}>
            Verify and save Companion access
          </h3>
          <p className={documentClass("p")}>
            <code className={documentClass("code")}>
              {settings.companion_url}
            </code>
          </p>
          <p className={documentClass("p")}>
            We verify HTTPS, this installation’s identity, OpenID discovery and
            signing keys when you save. Saving this method keeps every other
            access method and the active Omni issuer unchanged.
          </p>
          <Button
            variant="secondary"
            isDisabled={busy || checkingCompanion}
            onPress={() => {
              void work(async () => {
                setCompanionVerified(false);
                const result = await api<CompanionVerification>(
                  "/api/companion/check",
                  {
                    profile: settings.profile,
                    companion_url: settings.companion_url,
                  },
                );
                setCompanionDnsPending(!!result.local_dns_pending);
                setCompanionHint(
                  result.local_dns_pending
                    ? "Cloudflare is ready; local DNS access is still updating. Save this address to keep the verified Cloudflare configuration."
                    : "",
                );
                setCompanionVerified(true);
              });
            }}
          >
            {checkingCompanion
              ? "Checking Companion HTTPS…"
              : "Verify Companion HTTPS"}
          </Button>
          {checkingCompanion && (
            <p className={documentClass("p")} role="status">
              The tunnel is ready. Checking HTTPS and this Companion’s identity
              automatically…
            </p>
          )}
          {companionHint && (
            <p className={documentClass("p")} role="status">
              {companionHint}
            </p>
          )}
          {companionVerified && (
            <StatusLight variant="positive">
              {companionDnsPending
                ? "Companion HTTPS and identity verified through Cloudflare DNS"
                : "Companion HTTPS and identity verified"}
            </StatusLight>
          )}
          <details className={documentClass("details")}>
            <summary className={documentClass("summary")}>
              Advanced settings
            </summary>
            <TextField
              label="Companion HTTPS address"
              value={settings.companion_url}
              isDisabled={busy}
              description={
                settings.profile === "lan"
                  ? "Choose Save access method to verify and save this address. It must already route to this Companion."
                  : settings.profile === "cloudflare"
                    ? "Saving updates Cloudflare DNS and tunnel routes, then verifies HTTPS. Choose a subdomain of your approved domain. Existing routes remain available."
                    : "Saving renames this Tailscale device and updates Companion, Omni and backup addresses. Use Local HTTPS or Cloudflare for this change so the page stays connected. Change only the device name within your current tailnet. If Omni uses this device as its issuer, select another verified access method first."
              }
              onChange={(value) => {
                setAutoCheck(null);
                setCheckingCompanion(false);
                setCompanionHint("");
                change("companion_url", value);
                setCompanionVerified(false);
              }}
            />
          </details>
          <ButtonGroup slot={null}>
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() => {
                setStep(2);
              }}
            >
              Back
            </Button>
            <Button
              variant="accent"
              isDisabled={
                busy ||
                checkingCompanion ||
                !settings.companion_url.trim().startsWith("https://")
              }
              onPress={() => {
                void work(async () => {
                  await saveAccess();
                });
              }}
            >
              {busy ? "Verifying and saving…" : "Save access method"}
            </Button>
          </ButtonGroup>
        </>
      )}
      {step === 4 && (
        <>
          <h3 className={documentClass("h3")}>Where do you open Omni?</h3>
          <p className={documentClass("p")}>
            Companion is ready at{" "}
            <a
              className={documentClass("a")}
              href={settings.companion_url}
              target="_blank"
              rel="noreferrer"
            >
              {settings.companion_url}
            </a>
            . Opening a different hostname may require signing in again.
          </p>
          <p className={documentClass("p")}>
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
          <details className={documentClass("details")}>
            <summary className={documentClass("summary")}>
              Advanced settings
            </summary>
            <TextArea
              label="Public trust certificate (optional)"
              value={certificate}
              onChange={setCertificate}
              description="Only for an Omni server using a private certificate authority. Paste its public PEM certificate, never a private key."
              styles={style({ width: "full", marginY: 12 })}
            />
          </details>
          <ButtonGroup slot={null}>
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
          </ButtonGroup>
        </>
      )}
      {step === 2 && settings.profile !== "lan" && (
        <>
          <h3 className={documentClass("h3")}>Connect {provider}</h3>
          <p className={documentClass("p")}>
            {settings.profile === "cloudflare"
              ? "Sign in to Cloudflare, choose the domain you want to use, then return here. We’ll detect your approved domain, create the tunnel and addresses, and check Companion HTTPS. Your domain must already be managed by Cloudflare."
              : "Sign in to Tailscale and approve this Companion device. We’ll configure private HTTPS access for you."}
          </p>
          {(!connection.data?.available || !providerIncluded) && (
            <div role="status">
              <p className={documentClass("p")}>
                {connection.data && !providerIncluded
                  ? `${provider} is not included in this image. Use the default Companion image or the ${provider} variant to enable it.`
                  : connection.data?.bundled
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
            <p className={documentClass("p")} role="alert">
              Could not check the connection service. Try again.
            </p>
          )}
          {settings.profile === "cloudflare" && (
            <details className={documentClass("details")}>
              <summary className={documentClass("summary")}>
                Advanced settings
              </summary>
              <TextField
                label="Cloudflare domain override (optional)"
                value={domain}
                onChange={(value) => {
                  setDomain(value);
                  setAuthorized(false);
                }}
                placeholder="example.com"
                description="Normally detected from Cloudflare. Only enter the domain you approved if automatic detection fails. Use example.com without https:// or a port."
                isDisabled={busy || connecting}
                styles={style({ width: "full", marginY: 12 })}
              />
            </details>
          )}
          {!connecting && (
            <Checkbox
              isSelected={authorized}
              onChange={setAuthorized}
              isDisabled={busy}
              styles={style({ width: "full", marginY: 12 })}
            >
              {settings.profile === "cloudflare"
                ? "Allow public access to Companion, Omni and the protected backup receiver through the domain I approve in Cloudflare."
                : "Allow my Tailscale devices to access Companion, Omni and the backup receiver."}
            </Checkbox>
          )}
          {job?.profile === settings.profile &&
            job.state === "authorizing" &&
            job.auth_url && (
              <p className={documentClass("p")}>
                <a
                  className={documentClass("a")}
                  href={job.auth_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {provider === "Cloudflare"
                    ? "Open Cloudflare sign-in ↗"
                    : "Sign in to Tailscale ↗"}
                </a>
              </p>
            )}
          {connecting && (
            <p className={documentClass("p")} role="status">
              {job?.message
                ? job.message
                : job?.auth_url
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
              <p className={documentClass("p")} role="status">
                {job.state === "expired"
                  ? "The sign-in request expired. Try again when you’re ready."
                  : job.message ||
                    "We couldn’t finish the connection. Check the account and domain you approved, then try again."}
              </p>
            )}
          <ButtonGroup slot={null}>
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
                !providerIncluded
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
              {connecting
                ? "Connecting…"
                : settings.profile === "cloudflare"
                  ? "Continue with Cloudflare"
                  : "Connect Tailscale"}
            </Button>
          </ButtonGroup>
        </>
      )}
      {step === 5 && (
        <>
          <h3 className={documentClass("h3")}>
            {checking
              ? "Checking your connection"
              : allReady
                ? "Network checks passed"
                : "Let’s check your services"}
          </h3>
          {checking && (
            <p className={documentClass("p")} role="status">
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
                    {!result.ok && (
                      <p className={documentClass("p")}>{result.message}</p>
                    )}
                  </li>
                ))}
              </ul>
              <p className={documentClass("p")}>
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
          <ButtonGroup slot={null}>
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
          </ButtonGroup>
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
          <details className={documentClass("details")}>
            <summary className={documentClass("summary")}>
              Advanced settings
            </summary>
            <div>
              <h4>Manual addresses</h4>
              <p className={documentClass("p")}>
                Override advertised addresses for an existing proxy or custom
                deployment. Changing an address does not create a listener,
                certificate or proxy route.
              </p>
              {settings.profile === "lan" && status?.mounted && (
                <p className={documentClass("p")}>
                  <a className={documentClass("a")} href="/api/omni/ca">
                    Download LAN trust certificate
                  </a>
                  {" · "}
                  <a className={documentClass("a")} href="/api/omni/talos-ca">
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
            <details className={documentClass("details")}>
              <summary className={documentClass("summary")}>
                Import / repair an existing instance
              </summary>
              <p className={documentClass("p")}>
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
            <p className={documentClass("p")}>
              <a
                className={documentClass("a")}
                href="https://github.com/holblin/talos-companion/blob/main/docs/home-setup.md"
                target="_blank"
                rel="noreferrer"
              >
                Home installation, certificates and migration tutorial ↗
              </a>
            </p>
            {status?.restart_pending && (
              <p className={documentClass("p")} role="status">
                An issuer migration is saved. Prepare HTTPS, restart Companion,
                and open {status.integration.companion_url}. The active issuer
                is still {status.active_issuer}.
              </p>
            )}
          </details>
          <h3 className={documentClass("h3")}>Finish configuring Omni</h3>
          <p className={documentClass("p")}>
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
              <h3 className={documentClass("h3")}>
                {plan.changes.length
                  ? `${String(plan.changes.length)} managed settings need adjustment`
                  : "Managed settings match"}
              </h3>
              {!plan.source_checked && (
                <p className={documentClass("p")}>
                  No primary configuration was supplied. This is a proposed
                  configuration, not verification of a running instance.
                </p>
              )}
              <ul>
                {plan.changes.map((path) => (
                  <li key={path}>
                    <code className={documentClass("code")}>{path}</code>
                  </li>
                ))}
              </ul>
              <p className={documentClass("p")}>
                Callback:{" "}
                <code className={documentClass("code")}>{plan.callback}</code>
              </p>
              <p className={documentClass("p")}>{plan.note}</p>
              <p className={documentClass("p", classes("hint"))}>
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
              <ButtonGroup slot={null}>
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
              </ButtonGroup>
              {!plan.mounted && (
                <p className={documentClass("p", classes("hint"))}>
                  Apply these files using Omni’s administration tools. Companion
                  cannot restart a remote Omni server.
                </p>
              )}
            </div>
          )}

          <details className={documentClass("details")}>
            <summary className={documentClass("summary")}>
              Connection details
            </summary>
            {job?.message}
          </details>
        </>
      )}
      {notice && (
        <p className={documentClass("p")} role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
