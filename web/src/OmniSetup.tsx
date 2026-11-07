import FilePicker from "./FilePicker";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "./query";
import { useTask } from "./useTask";
import { classes } from "./layout";
import {
  TextArea,
  Picker,
  PickerItem,
  TextField,
  Button,
  Checkbox,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useState } from "react";
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
  const integration = useQuery({
    queryKey: ["omni"],
    queryFn: () => api<Status>("/api/omni"),
  });
  const status = integration.data ?? null;
  const [draft, setSettings] = useState<Integration | null>(null);
  const settings =
    draft ??
    (status?.integration.companion_url
      ? status.integration
      : {
          profile: "lan",
          companion_url: `https://${location.hostname}:18443`,
          omni_url: `https://${location.hostname}:19443`,
          s3_endpoint: `https://${location.hostname}:19444`,
        });
  const [importFile, setImportFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [accepted, setAccepted] = useState(false);
  const { busy, error, notice, setNotice, work } = useTask();
  function change(name: keyof Integration, value: string) {
    setSettings((previous) => ({ ...(previous ?? settings), [name]: value }));
    setPlan(null);
    setAccepted(false);
    setNotice("");
  }
  return (
    <section className={classes("card omni-setup")}>
      <div className={classes("eyebrow")}>OMNI SETUP & REPAIR</div>
      <h2>Connect a new or existing Omni</h2>
      <p>
        Choose how you reach your services. Import an existing configuration to
        check it, or use the home installer for a fresh instance. Repairs use a
        separate overlay and preserve the original database, identity and
        encryption keys.
      </p>
      <Picker
        label={<>Access profile</>}
        value={settings.profile}
        onChange={(value) => {
          if (
            value === "lan" ||
            value === "cloudflare" ||
            value === "tailscale"
          )
            change("profile", value);
        }}
        styles={style({ width: "full", marginY: 12 })}
      >
        <PickerItem id="lan">LAN — generated private CA</PickerItem>
        <PickerItem id="cloudflare">
          Cloudflare — DNS-validated trusted certificates
        </PickerItem>
        <PickerItem id="tailscale">
          Tailscale — private tailnet with trusted HTTPS
        </PickerItem>
      </Picker>
      {settings.profile === "lan" && (
        <p className={classes("hint")}>
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
        <p className={classes("hint")}>
          Use a domain you control. The installer requests certificates using
          Cloudflare DNS validation and a narrowly scoped token entered on your
          server. DNS records remain unproxied; no ports are opened
          automatically. Cloudflare Tunnel alone does not carry Omni’s WireGuard
          UDP traffic.
        </p>
      )}
      {settings.profile === "tailscale" && (
        <p className={classes("hint")}>
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
        <TextField
          key={name}
          type="url"
          label={<>{label}</>}
          value={settings[name]}
          onChange={(value) => {
            change(name, value);
          }}
          isRequired
          styles={style({ width: "full", marginY: 12 })}
        ></TextField>
      ))}
      <details>
        <summary>Import / repair an existing instance</summary>
        <p>
          Upload its main YAML/JSON configuration. It is inspected in memory;
          private keys are not needed. The checker covers OIDC and S3 enablement
          only. Existing CLI flags or later config files can override these
          values.
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
                setSource(await file.text());
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
      <Button
        isDisabled={busy}
        onPress={() => {
          void work(async () => {
            const result = await api<{ message: string }>(
              "/api/omni/check",
              settings,
            );
            setNotice(result.message);
          });
        }}
        type="button"
        variant="secondary"
      >
        Check HTTPS reachability
      </Button>{" "}
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
            Downloads contain credentials. Store them privately. TLS, storage,
            account UUID, initial administrator roles and EULA acceptance are
            not rewritten by this repair.
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
            register the shown callback. I have prepared HTTPS and a recovery
            copy.
          </Checkbox>
          <Button
            isDisabled={busy || !accepted || !plan.mounted}
            onPress={() => {
              void work(async () => {
                await api("/api/omni/apply", {
                  integration: settings,
                  primary_config: source,
                  revision: plan.revision,
                });
                setPlan(null);
                await queryClient.invalidateQueries({ queryKey: ["omni"] });
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
