import { useEffect, useState } from "react";
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
  active_issuer: string;
  mounted: boolean;
  restart_pending: boolean;
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
  const [settings, setSettings] = useState<Integration>({
    profile: "lan",
    companion_url: `https://${location.hostname}:18443`,
    omni_url: `https://${location.hostname}:19443`,
    s3_endpoint: `https://${location.hostname}:19444`,
  });
  const [status, setStatus] = useState<Status | null>(null);
  const [source, setSource] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    void api<Status>("/api/omni")
      .then((result) => {
        setStatus(result);
        if (result.integration.companion_url) setSettings(result.integration);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not load integration");
      });
  }, []);
  function change(name: keyof Integration, value: string) {
    setSettings((previous) => ({ ...previous, [name]: value }));
    setPlan(null);
    setAccepted(false);
    setNotice("");
  }
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card omni-setup">
      <div className="eyebrow">OMNI SETUP & REPAIR</div>
      <h2>Connect a new or existing Omni</h2>
      <p>
        Choose how you reach your services. Import an existing configuration to
        check it, or use the home installer for a fresh instance. Repairs use a
        separate overlay and preserve the original database, identity and
        encryption keys.
      </p>
      <label className="field">
        <span>Access profile</span>
        <select
          value={settings.profile}
          onChange={(e) => {
            const value = e.target.value;
            if (
              value === "lan" ||
              value === "cloudflare" ||
              value === "tailscale"
            )
              change("profile", value);
          }}
        >
          <option value="lan">LAN — generated private CA</option>
          <option value="cloudflare">
            Cloudflare — DNS-validated trusted certificates
          </option>
          <option value="tailscale">
            Tailscale — private tailnet with trusted HTTPS
          </option>
        </select>
      </label>
      {settings.profile === "lan" && (
        <p className="hint">
          No domain or cloud account needed. The installer generates your LAN
          certificate authority. Install its public root certificate on each
          browser/client before switching to HTTPS. Keep the CA private key on
          the host. Talos nodes also need the root in their initial
          configuration before joining Omni.{" "}
          <a href="/api/omni/ca">Download public root certificate</a>
          {" · "}
          <a href="/api/omni/talos-ca">Download Talos TrustedRootsConfig</a>
        </p>
      )}
      {settings.profile === "cloudflare" && (
        <p className="hint">
          Use a domain you control. The installer requests certificates using
          Cloudflare DNS validation and a narrowly scoped token entered on your
          server. DNS records remain unproxied; no ports are opened
          automatically. Cloudflare Tunnel alone does not carry Omni’s WireGuard
          UDP traffic.
        </p>
      )}
      {settings.profile === "tailscale" && (
        <p className="hint">
          Use your signed-in device’s .ts.net hostname. Enable HTTPS
          certificates in your tailnet. Every browser and Talos node needs a
          working route to the advertised services; Tailscale on your laptop
          alone does not connect Talos nodes.
        </p>
      )}
      {(
        [
          ["companion_url", "Companion HTTPS address"],
          ["omni_url", "Omni HTTPS address"],
          ["s3_endpoint", "S3 receiver address reachable from Omni"],
        ] as const
      ).map(([name, label]) => (
        <label className="field" key={name}>
          <span>{label}</span>
          <input
            type="url"
            value={settings[name]}
            onChange={(e) => {
              change(name, e.target.value);
            }}
            required
          />
        </label>
      ))}
      <details>
        <summary>Import / repair an existing instance</summary>
        <p>
          Upload its main YAML/JSON configuration. It is inspected in memory;
          private keys are not needed. The checker covers OIDC and S3 enablement
          only. Existing CLI flags or later config files can override these
          values.
        </p>
        <label className="field">
          <span>Existing Omni configuration (maximum 256 KiB)</span>
          <input
            type="file"
            accept=".yaml,.yml,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void work(async () => {
                  if (file.size > 262144)
                    throw new Error("Configuration exceeds 256 KiB");
                  setSource(await file.text());
                  setPlan(null);
                  setAccepted(false);
                  setNotice(
                    "Configuration imported for inspection. It has not been applied.",
                  );
                });
            }}
          />
        </label>
        <label className="field">
          <span>Or paste configuration</span>
          <textarea
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPlan(null);
              setAccepted(false);
            }}
            rows={5}
            spellCheck={false}
          />
        </label>
      </details>
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
          An issuer migration is saved. Prepare HTTPS, restart Companion, and
          open {status.integration.companion_url}. The active issuer is still{" "}
          {status.active_issuer}.
        </p>
      )}
      <button
        disabled={busy}
        onClick={() => {
          void work(async () => {
            const result = await api<{ message: string }>(
              "/api/omni/check",
              settings,
            );
            setNotice(result.message);
          });
        }}
      >
        Check HTTPS reachability
      </button>{" "}
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
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
      >
        Check configuration & preview
      </button>
      {plan && (
        <div className="recovery-box">
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
          <p className="hint">
            Downloads contain credentials. Store them privately. TLS, storage,
            account UUID, initial administrator roles and EULA acceptance are
            not rewritten by this repair.
          </p>
          <button
            disabled={busy}
            onClick={() => {
              download("companion-overlay.yaml", plan.overlay);
            }}
          >
            Download Omni overlay
          </button>{" "}
          <button
            disabled={busy}
            onClick={() => {
              download("companion-s3.yaml", plan.s3_resource);
            }}
          >
            Download S3 resource
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => {
                setAccepted(e.target.checked);
              }}
            />{" "}
            Switch Omni sign-in to this Companion, enable S3 backups, and
            register the shown callback. I have prepared HTTPS and a recovery
            copy.
          </label>
          <button
            className="primary"
            disabled={busy || !accepted || !plan.mounted}
            onClick={() => {
              void work(async () => {
                await api("/api/omni/apply", {
                  integration: settings,
                  primary_config: source,
                  revision: plan.revision,
                });
                setPlan(null);
                setStatus(await api<Status>("/api/omni"));
                setNotice(
                  "Overlay saved. Restart Omni after activating it and apply the downloaded S3 resource. Restart Companion after HTTPS is ready.",
                );
              });
            }}
          >
            Apply managed overlay & save migration
          </button>
          {!plan.mounted && (
            <p className="hint">
              Direct repair requires the dedicated /omni-managed mount. Use the
              home installer to add it. Download mode works without host access.
            </p>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
