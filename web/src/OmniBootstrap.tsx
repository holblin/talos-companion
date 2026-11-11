import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Form } from "@react-spectrum/s2/Form";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import {
  Disclosure,
  DisclosureTitle,
  DisclosurePanel,
} from "@react-spectrum/s2/Disclosure";
import { Link } from "@react-spectrum/s2/Link";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Panel from "./Panel";
import Field from "./Field";
import { documentClass } from "./layout";
import { api } from "./api";
import { downloadOmni } from "./omniDownloads";
import { useTask } from "./useTask";

type Config = {
  omni_url: string;
  companion_url: string;
  account_name: string;
  admin_email: string;
  wireguard_ip: string;
  api_port: number;
  kubernetes_port: number;
  machine_port: number;
  wireguard_port: number;
  event_sink_port: number;
  log_server_port: number;
  metrics_port: number;
  tls_cert: string;
  tls_key: string;
  private_key_file: string;
  etcd_path: string;
  sqlite_path: string;
};
type Generated = {
  account_id: string;
  config: Config;
  generated_at: number;
  connected_at: number | null;
  callback: string;
  image: string;
};
type Status = {
  bootstrap: Generated | null;
  active_issuer: string;
  admin_email: string;
};
export default function OmniBootstrap() {
  const status = useQuery({
    queryKey: ["omni-bootstrap"],
    queryFn: () => api<Status>("/api/omni/bootstrap"),
    staleTime: 0,
  });
  if (status.isPending) return <p role="status">Loading Omni setup…</p>;
  if (status.error) return <p role="alert">{status.error.message}</p>;
  return <BootstrapForm status={status.data} />;
}
function BootstrapForm({ status }: { status: Status }) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<Config>(
    status.bootstrap?.config ?? {
      omni_url: "",
      companion_url: status.active_issuer,
      account_name: "my-omni",
      admin_email: status.admin_email,
      wireguard_ip: "",
      api_port: 8443,
      kubernetes_port: 8100,
      machine_port: 8090,
      wireguard_port: 50180,
      event_sink_port: 8091,
      log_server_port: 8092,
      metrics_port: 2122,
      tls_cert: "/config/tls/fullchain.pem",
      tls_key: "/config/tls/privkey.pem",
      private_key_file: "/config/omni.asc",
      etcd_path: "/data/etcd",
      sqlite_path: "/data/secondary-storage/sqlite.db",
    },
  );
  const [generated, setGenerated] = useState(status.bootstrap);
  const [checked, setChecked] = useState<boolean | null>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, error, work } = useTask();
  function change(key: keyof Config, value: string) {
    setConfig((previous) => ({
      ...previous,
      [key]: key.endsWith("_port") ? Number(value) : value,
    }));
    setDirty(true);
    setChecked(null);
  }
  const fields = (items: [keyof Config, string][], numeric = false) =>
    items.map(([key, label]) => (
      <Field
        compact
        key={key}
        label={label}
        value={config[key]}
        type={
          numeric
            ? "number"
            : key.endsWith("_url")
              ? "url"
              : key === "admin_email"
                ? "email"
                : "text"
        }
        {...(numeric ? { min: 1, max: 65535, step: 1 } : {})}
        onChange={(value) => {
          change(key, value);
        }}
      />
    ));
  return (
    <Panel>
      <h2 className={documentClass("h2")}>Set up a new Omni instance</h2>
      <p className={documentClass("p")}>
        Omni does not need to be running. Plan its addresses and container
        paths, then generate the configuration before its first start. This flow
        targets <code>ghcr.io/siderolabs/omni:v1.13.2</code>.
      </p>
      <p className={documentClass("p")}>
        Companion must already have its stable HTTPS issuer. The issuer below
        must match the active issuer: <code>{status.active_issuer}</code>.{" "}
        <Link href="/access">Manage Companion access</Link>.
      </p>
      <p className={documentClass("p")}>
        Use this flow only for a new installation. For an existing Omni, choose
        Connect an existing Omni instance to preserve its identity and storage
        configuration. Generating a configuration registers the planned callback
        for Companion’s single OIDC client.
      </p>
      <Form
        isDisabled={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void work(async () => {
            const result = await api<Generated>("/api/omni/bootstrap", config);
            queryClient.setQueryData<Status>(["omni-bootstrap"], {
              ...status,
              bootstrap: result,
            });
            setGenerated(result);
            setConfig(result.config);
            setDirty(false);
            setChecked(null);
          });
        }}
      >
        <div
          className={style({
            display: "grid",
            gridTemplateColumns: { default: "1fr", md: "1fr 1fr" },
            gap: 24,
          })}
        >
          {fields([
            ["omni_url", "Planned Omni URL"],
            ["companion_url", "Companion issuer"],
            ["account_name", "Omni account name"],
            ["admin_email", "Initial administrator email"],
            ["wireguard_ip", "Node-reachable WireGuard IP"],
          ])}
        </div>
        <p className={documentClass("p")}>
          Use a literal host IP that Talos nodes can reach, rather than a DNS
          name or a tunnel-only HTTP address. The initial administrator email
          must match a Companion account; Omni roles are managed separately.
        </p>
        <Disclosure>
          <DisclosureTitle>Ports and container paths</DisclosureTitle>
          <DisclosurePanel>
            <p className={documentClass("p")}>
              Host networking uses these listener ports directly. The planned
              URL controls the public API address, including any reverse-proxy
              port. Kubernetes and machine API URLs use the same hostname with
              their ports below.
            </p>
            <div
              className={style({
                display: "grid",
                gridTemplateColumns: { default: "1fr", md: "1fr 1fr" },
                gap: 24,
              })}
            >
              {fields(
                [
                  ["api_port", "API TLS port"],
                  ["kubernetes_port", "Kubernetes proxy TLS port"],
                  ["machine_port", "Machine API TLS port"],
                  ["wireguard_port", "WireGuard UDP port"],
                  ["event_sink_port", "Event sink TCP port"],
                  ["log_server_port", "Log server TCP port"],
                  ["metrics_port", "Local metrics TCP port"],
                ],
                true,
              )}
              {fields([
                ["tls_cert", "TLS certificate path"],
                ["tls_key", "TLS private key path"],
                ["private_key_file", "Omni encryption key path"],
                ["etcd_path", "Embedded etcd directory"],
                ["sqlite_path", "SQLite file path"],
              ])}
            </div>
            <p className={documentClass("p")}>
              Certificates and encryption material belong under read-only
              /config. Databases belong under writable /data.
            </p>
          </DisclosurePanel>
        </Disclosure>
        {error && (
          <p role="alert" className={documentClass("p")}>
            {error}
          </p>
        )}
        <Button type="submit" variant="accent" isPending={busy}>
          {generated ? "Update generated configuration" : "Generate omni.yaml"}
        </Button>
      </Form>
      {generated && (
        <section aria-label="Generated Omni configuration">
          <h3 className={documentClass("h3")}>Configuration generated</h3>
          <p className={documentClass("p")}>
            Permanent account UUID: <code>{generated.account_id}</code>. This
            identity and Companion’s existing OIDC credentials are preserved
            across edits and downloads.
          </p>
          <p className={documentClass("p")}>
            Registered callback: <code>{generated.callback}</code>
          </p>
          <p className={documentClass("p")}>
            This download contains the OIDC client secret. Keep it private,
            restrict filesystem access and never commit it or share it in
            screenshots.
          </p>
          {dirty && (
            <p role="status">
              You have unsaved changes. Generate the updated configuration
              before downloading or validating it.
            </p>
          )}
          <ButtonGroup>
            <Button
              variant="accent"
              isDisabled={busy || dirty}
              onPress={() => {
                void work(() => downloadOmni("/api/omni/bootstrap/config"));
              }}
            >
              Download omni.yaml
            </Button>
            <Button
              variant="secondary"
              isDisabled={busy || dirty}
              onPress={() => {
                void work(async () => {
                  const result = await api<{
                    connected: boolean;
                    bootstrap: Generated;
                  }>("/api/omni/bootstrap/check", {});
                  setChecked(result.connected);
                  queryClient.setQueryData<Status>(["omni-bootstrap"], {
                    ...status,
                    bootstrap: result.bootstrap,
                  });
                  setGenerated(result.bootstrap);
                });
              }}
            >
              Validate connection after startup
            </Button>
          </ButtonGroup>
          <h3 className={documentClass("h3")}>Prepare and start Omni</h3>
          <ol>
            <li>
              Save the download as <code>omni.yaml</code> in a private host
              configuration directory. Mount it at <code>/config</code>{" "}
              read-only, and mount a separate writable appdata directory at{" "}
              <code>/data</code>. Start the supported image with{" "}
              <code>--config-path=/config/omni.yaml</code>.
            </li>
            <li>
              Prepare trusted TLS certificates for the planned hostname at the
              configured certificate and key paths. Generate an Omni GPG
              encryption key and export its private key as <code>omni.asc</code>{" "}
              at the configured encryption-key path. Preserve an offline copy of
              the key and UUID; Companion does not generate this key.
            </li>
            <li>
              Read the{" "}
              <Link
                href="https://siderolabs.com/eula/"
                target="_blank"
                rel="noreferrer"
              >
                Omni EULA
              </Link>
              . If you accept, add <code>eulaAccept.name</code> and{" "}
              <code>eulaAccept.email</code> with your own details to the
              downloaded file. Companion does not accept terms for you.
            </li>
            <li>
              Review the Unraid mounts, free TCP/UDP ports and node routing,
              then start Omni. Return here to validate connectivity, test
              Companion sign-in, and connect a test node.
            </li>
            <li>
              S3 mode is enabled in the file, but you must configure Omni’s
              backup destination after startup using Companion’s S3 receiver
              endpoint and credentials. Then test an actual backup. Choose
              Companion’s recovery-file destination separately in Backups.
            </li>
          </ol>
          <p className={documentClass("p")}>
            <Link
              href="https://github.com/holblin/talos-companion/blob/main/deploy/unraid/omni-install.md"
              target="_blank"
              rel="noreferrer"
            >
              Unraid installation, certificates and encryption-key instructions
            </Link>
          </p>
          <StatusLight
            variant={generated.connected_at ? "positive" : "neutral"}
          >
            {generated.connected_at
              ? "Omni connected"
              : checked === false
                ? "Omni not connected"
                : "Omni connection not validated"}
          </StatusLight>
          <p className={documentClass("p")}>
            {checked === false
              ? "The planned HTTPS endpoint could not be reached. The generated configuration is still available. Start Omni and check DNS, TLS and port mappings, then retry."
              : generated.connected_at
                ? "HTTPS reachability was checked from Companion. Sign-in, node connectivity and a real backup still need testing."
                : "Generating configuration does not establish an Omni connection. Validate only after startup."}
          </p>
        </section>
      )}
    </Panel>
  );
}
