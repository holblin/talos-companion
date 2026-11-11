import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2/Provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { OmniConfiguration } from "../src/AccessPages";
import { downloadOmni } from "../src/omniDownloads";

vi.mock("../src/omniDownloads", () => ({
  downloadOmni: vi.fn().mockResolvedValue(undefined),
}));
const config = {
  omni_url: "https://omni.invalid",
  companion_url: "https://companion.example.test",
  account_name: "my-omni",
  admin_email: "admin@example.test",
  wireguard_ip: "192.0.2.20",
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
};
const generated = {
  account_id: "e38965f5-a1ad-40a0-aac0-7aab3e206945",
  config,
  generated_at: 1,
  connected_at: null as number | null,
  callback: "https://omni.invalid/oidc/consume",
  image: "ghcr.io/siderolabs/omni:v1.13.2",
};
let saved: typeof generated | null;
let calls: { path: string; method: string }[];
let connected: boolean;
beforeEach(() => {
  saved = null;
  calls = [];
  connected = false;
  vi.mocked(downloadOmni).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET" });
      let value: unknown;
      if (path === "/api/omni/bootstrap" && init?.method === "POST") {
        saved = {
          ...generated,
          config: JSON.parse(
            typeof init.body === "string" ? init.body : "{}",
          ) as typeof config,
        };
        value = saved;
      } else if (path === "/api/omni/bootstrap")
        value = {
          bootstrap: saved,
          active_issuer: config.companion_url,
          admin_email: config.admin_email,
        };
      else if (path === "/api/omni/bootstrap/check") {
        saved = { ...generated, connected_at: connected ? 123 : null };
        value = { connected, bootstrap: saved };
      } else throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(
        new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
});
function mount() {
  return render(
    <Provider>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <OmniConfiguration />
      </QueryClientProvider>
    </Provider>,
  );
}
async function open() {
  const events = userEvent.setup();
  await events.click(
    screen.getByRole("button", { name: "Set up a new Omni instance" }),
  );
  await screen.findByRole("textbox", { name: "Planned Omni URL" });
  return events;
}
it("offers new and existing setup explicitly and generates before any live checks", async () => {
  mount();
  expect(
    screen.getByRole("button", { name: "Connect an existing Omni instance" }),
  ).toBeTruthy();
  expect(calls).toEqual([]);
  const events = await open();
  expect(screen.getByText(/Omni does not need to be running/)).toBeTruthy();
  await events.type(
    screen.getByRole("textbox", { name: "Planned Omni URL" }),
    config.omni_url,
  );
  await events.type(
    screen.getByRole("textbox", { name: "Node-reachable WireGuard IP" }),
    config.wireguard_ip,
  );
  await events.click(
    screen.getByRole("button", { name: "Generate omni.yaml" }),
  );
  await screen.findByRole("heading", { name: "Configuration generated" });
  expect(screen.getByText("Omni connection not validated")).toBeTruthy();
  expect(calls.every((c) => c.path === "/api/omni/bootstrap")).toBe(true);
  expect(saved?.config.etcd_path).toBe("/data/etcd");
  expect(
    screen.getByText(/This download contains the OIDC client secret/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Companion does not accept terms for you/),
  ).toBeTruthy();
  await events.click(
    screen.getByRole("button", { name: "Download omni.yaml" }),
  );
  await waitFor(() => {
    expect(downloadOmni).toHaveBeenCalledWith("/api/omni/bootstrap/config");
  });
  await events.type(
    screen.getByRole("textbox", { name: "Omni account name" }),
    " edited",
  );
  expect(
    screen
      .getByRole("button", { name: "Download omni.yaml" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("restores generated identity and distinguishes failed checks from successful reachability", async () => {
  saved = generated;
  mount();
  const events = await open();
  await screen.findByText(generated.account_id, { exact: false });
  expect(
    screen.getByRole("textbox", { name: "Planned Omni URL" }),
  ).toHaveProperty("value", config.omni_url);
  await events.click(
    screen.getByRole("button", { name: "Validate connection after startup" }),
  );
  await screen.findByText("Omni not connected");
  expect(
    screen.getByRole("heading", { name: "Configuration generated" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Download omni.yaml" })
      .hasAttribute("disabled"),
  ).toBe(false);
  connected = true;
  await events.click(
    screen.getByRole("button", { name: "Validate connection after startup" }),
  );
  await screen.findByText("Omni connected");
  expect(
    screen.getByText(/HTTPS reachability was checked from Companion/),
  ).toBeTruthy();
});
