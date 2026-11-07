import FilePicker from "./FilePicker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTask } from "./useTask";
import { classes } from "./layout";
import {
  TextArea,
  Picker,
  PickerItem,
  TextField,
  Button,
  Checkbox,
  StatusLight,
  ToastQueue,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Profile = "lan" | "cloudflare" | "tailscale";
type Integration = {
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
export default function OmniSetup() {
  const queryClient = useQueryClient();
  const integration = useQuery({
    queryKey: ["omni"],
    queryFn: () => api<Status>("/api/omni"),
  });
  const status = integration.data ?? null;
  const [draft, setSettings] = useState<Integration | null>(null);
  const settings = draft ??
    status?.defaults ?? {
      profile: "lan",
      companion_url: "",
      omni_url: "",
      s3_endpoint: "",
    };
  const [step, setStep] = useState(1);
  const [complete, setComplete] = useState<boolean | null>(null);
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
      job?.state === "connected" &&
      job.integration &&
      status &&
      appliedConnection.current !== job.id
    ) {
      appliedConnection.current = job.id;
      if (
        startedConnection.current === job.id ||
        (!connection.data?.saved && !status.integration.companion_url)
      ) {
        setStep(4);
        setSettings(job.integration);
        setChecks(null);
        setPlan(null);
        setAccepted(false);
        const endpoints = job.integration;
        void work(async () => {
          await verify(endpoints);
        });
      }
    }
  }, [job, status, connection.data?.saved]);
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

  const saved = complete ?? !!connection.data?.saved;
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
      <div className={classes("eyebrow")}>OMNI CONNECTION</div>
      <h2>{saved ? "Your saved connection" : "Connect your Omni"}</h2>
      {integration.error && <p role="alert">{integration.error.message}</p>}
      {saved ? (
        <>
          {addresses}
          <Button
            variant="secondary"
            onPress={() => {
              setComplete(false);
              setStep(1);
            }}
          >
            Change connection
          </Button>
          <Button
            variant="secondary"
            onPress={() => {
              setComplete(false);
              setStep(4);
              void work(async () => {
                await verify(settings);
              });
            }}
          >
            Check connection
          </Button>
        </>
      ) : (
        <>
          <p>
            Step {step} of 4 ·{" "}
            {step === 1
              ? "Choose a connection"
              : step === 2
                ? "Find your Omni"
                : step === 3
                  ? "Sign in"
                  : "Check and finish"}
          </p>
          {step === 1 && (
            <>
              <p>
                Choose how you want to reach Companion and Omni. We’ll handle
                the connection details.
              </p>
              <Picker
                label="Connection method"
                value={settings.profile}
                isDisabled={busy || connecting || integration.isPending}
                onChange={(value) => {
                  if (
                    value === "lan" ||
                    value === "cloudflare" ||
                    value === "tailscale"
                  ) {
                    change("profile", value);
                    setAuthorized(false);
                  }
                }}
                styles={style({ width: "full", marginY: 12 })}
              >
                <PickerItem id="lan">This network (LAN)</PickerItem>
                <PickerItem id="cloudflare">Cloudflare</PickerItem>
                <PickerItem id="tailscale">Tailscale</PickerItem>
              </Picker>
              <Button
                variant="accent"
                isDisabled={busy || integration.isPending}
                onPress={() => {
                  setStep(2);
                }}
              >
                Continue
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <h3>Where do you open Omni?</h3>
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
                  setStep(1);
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
                    if (settings.profile === "lan") {
                      const endpoints = {
                        ...settings,
                        omni_url: result.origin,
                      };
                      setSettings(endpoints);
                      setStep(4);
                      await verify(endpoints);
                    } else {
                      setStep(3);
                    }
                  });
                }}
              >
                {busy ? "Finding Omni…" : "Continue"}
              </Button>
            </>
          )}
          {step === 3 && (
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
                      setStep(2);
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
                  setStep(2);
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
          {step === 4 && (
            <>
              <h3>
                {checking
                  ? "Checking your connection"
                  : allReady
                    ? "Your connection is ready"
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
                        <StatusLight
                          variant={result.ok ? "positive" : "negative"}
                        >
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
              <Button
                variant="secondary"
                isDisabled={busy || connecting}
                onPress={() => {
                  setStep(settings.profile === "lan" ? 2 : 3);
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
                isDisabled={busy || !allReady}
                onPress={() => {
                  void work(async () => {
                    await api("/api/omni/connection/finish", settings);
                    setComplete(true);
                    await queryClient.invalidateQueries({ queryKey: ["omni"] });
                    await queryClient.invalidateQueries({
                      queryKey: ["omni-connection"],
                    });
                    ToastQueue.positive(
                      "Connection saved. Your services are ready.",
                    );
                  });
                }}
              >
                Save connection
              </Button>
              <details>
                <summary>Advanced settings</summary>
                <div>
                  <h4>Manual addresses</h4>
                  <p>
                    Override advertised addresses for an existing proxy or
                    custom deployment. Changing an address does not create a
                    listener, certificate or proxy route.
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
                      isDisabled={busy || connecting}
                      styles={style({ width: "full", marginY: 12 })}
                    />
                  ))}
                </div>
                <details>
                  <summary>Import / repair an existing instance</summary>
                  <p>
                    Upload its main YAML/JSON configuration. It is inspected in
                    memory; private keys are not needed. The checker covers OIDC
                    and S3 enablement only. Existing CLI flags or later config
                    files can override these values.
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
                    An issuer migration is saved. Prepare HTTPS, restart
                    Companion, and open {status.integration.companion_url}. The
                    active issuer is still {status.active_issuer}.
                  </p>
                )}
                <h4>Omni account configuration</h4>
                <p>
                  Use this section to change Omni’s existing sign-in and backup
                  settings. Saving the network connection leaves these settings
                  unchanged.
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
                        No primary configuration was supplied. This is a
                        proposed configuration, not verification of a running
                        instance.
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
                      storage, account UUID, initial administrator roles and
                      EULA acceptance are not rewritten by this repair.
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
                      Switch Omni sign-in to this Companion, enable S3 backups,
                      and register the shown callback. I have prepared HTTPS and
                      a recovery copy.
                    </Checkbox>
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
                            "Overlay saved. Restart Omni after activating it and apply the downloaded S3 resource. Restart Companion after HTTPS is ready.",
                          );
                        });
                      }}
                      type="button"
                      variant="accent"
                    >
                      Apply managed overlay & save migration
                    </Button>
                    {!plan.mounted && (
                      <p className={classes("hint")}>
                        Direct repair requires the dedicated /omni-managed
                        mount. Use the home installer to add it. Download mode
                        works without host access.
                      </p>
                    )}
                  </div>
                )}

                {job?.message && <p>Connection details: {job.message}</p>}
              </details>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}
