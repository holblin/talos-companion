import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, ToastContainer } from "@react-spectrum/s2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import OmniSetup from "../src/OmniSetup";

const defaults = {
  profile: "lan",
  companion_url: "https://companion.existing.test",
  omni_url: "https://omni.existing.test",
  s3_endpoint: "http://receiver.internal.test:9000",
};
const generated = {
  profile: "cloudflare",
  companion_url: "https://companion.lab.example.test",
  omni_url: "https://omni.lab.example.test",
  s3_endpoint: "https://s3.lab.example.test",
};
type Job = {
  id: string;
  profile: string;
  state: string;
  message: string;
  auth_url: string | null;
  integration: typeof generated | null;
};
let job: Job | null;
let available = true;
let networkSaved: typeof generated | null = null;
let receiverOk = false;
let posted: { path: string; body: unknown }[];
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  job = null;
  networkSaved = null;
  available = true;
  receiverOk = false;
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (init?.method === "POST") posted.push({ path, body });
      let value: unknown;
      if (path === "/api/omni")
        value = {
          integration: defaults,
          defaults,
          active_issuer: defaults.companion_url,
          mounted: true,
          restart_pending: false,
        };
      else if (path === "/api/omni/connection") {
        if (init?.method === "POST") {
          const tailscale =
            typeof body === "object" &&
            body !== null &&
            "profile" in body &&
            body.profile === "tailscale";
          job = {
            id: "test-job",
            profile: tailscale ? "tailscale" : "cloudflare",
            state: "authorizing",
            message: "Approve provider",
            auth_url: tailscale
              ? "https://login.tailscale.com/a/test-only"
              : "https://dash.cloudflare.com/argotunnel?test-only",
            integration: null,
          };
          value = { id: job.id };
        } else
          value = {
            available,
            bundled: true,
            backend_origin: defaults.omni_url,
            saved: networkSaved,
            connection: job,
          };
      } else if (path === "/api/omni/location")
        value = { origin: defaults.omni_url };
      else if (path === "/api/omni/connection/finish") {
        networkSaved = job?.integration ?? generated;
        value = { ok: true };
      } else if (path === "/api/omni/check")
        value = {
          checked_at: 1,
          checks: [
            {
              service: "Companion",
              endpoint: generated.companion_url,
              ok: true,
              message: "Verified this installation",
              vantage: "Companion",
            },
            {
              service: "Omni",
              endpoint: generated.omni_url,
              ok: true,
              message: "HTTP response verified",
              vantage: "Companion",
            },
            {
              service: "S3",
              endpoint: generated.s3_endpoint,
              ok: receiverOk,
              message: receiverOk
                ? "Bucket access verified"
                : "Wrong receiver identity",
              vantage: "Companion",
            },
          ],
          omni_to_s3_verified: false,
          note: "A real backup from Omni is still required.",
        };
      else if (path === "/api/omni/plan")
        value = {
          revision: "test-revision",
          changes: [],
          overlay: "test",
          s3_resource: "test",
          mounted: true,
          source_checked: false,
          callback: "test-callback",
          note: "Review before applying",
        };
      else value = { ok: true };
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
    <QueryClientProvider client={client}>
      <Provider locale="en-US">
        <OmniSetup />
        <ToastContainer />
      </Provider>
    </QueryClientProvider>,
  );
}

async function choose(method: string) {
  const events = userEvent.setup();
  mount();
  await screen.findByRole("button", { name: /Connection method/ });
  await events.click(screen.getByRole("button", { name: /Connection method/ }));
  await events.click(screen.getByRole("option", { name: method }));
  await events.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Where do you open Omni?" });
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Omni address" })
      .value,
  ).toBe(defaults.omni_url);
  await events.click(screen.getByRole("button", { name: "Continue" }));
  return events;
}
it("guides Cloudflare setup one step at a time, checks services and saves without Docker setup", async () => {
  const events = await choose("Cloudflare");
  expect(screen.queryByRole("textbox", { name: "Omni address" })).toBeNull();
  expect(screen.queryByText(/Install the connector/)).toBeNull();
  await events.type(
    screen.getByRole("textbox", { name: "Your Cloudflare domain" }),
    "example.test",
  );
  await events.click(
    screen.getByRole("checkbox", { name: /Allow public access/ }),
  );
  await events.click(
    screen.getByRole("button", { name: "Connect Cloudflare" }),
  );
  expect(
    (
      await screen.findByRole("link", { name: "Sign in to Cloudflare ↗" })
    ).getAttribute("href"),
  ).toBe("https://dash.cloudflare.com/argotunnel?test-only");
  job = {
    id: "test-job",
    profile: "cloudflare",
    state: "connected",
    message: "Routes configured",
    auth_url: null,
    integration: generated,
  };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["omni-connection"] });
  });
  await screen.findByText("Wrong receiver identity");
  expect(
    screen.queryByRole("textbox", { name: "Your Cloudflare domain" }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Save connection" })
      .hasAttribute("disabled"),
  ).toBe(true);
  receiverOk = true;
  await events.click(screen.getByRole("button", { name: "Check again" }));
  await screen.findByRole("heading", { name: "Your connection is ready" });
  expect(
    screen
      .getByRole("textbox", { name: "S3 receiver address" })
      .closest("details")?.open,
  ).toBe(false);
  await events.click(screen.getByRole("button", { name: "Save connection" }));
  await screen.findByRole("heading", { name: "Your saved connection" });
  expect(posted.some((x) => x.path === "/api/omni/location")).toBe(true);
  expect(posted.find((x) => x.path === "/api/omni/connection")?.body).toEqual({
    profile: "cloudflare",
    domain: "example.test",
  });
  expect(
    posted.find((x) => x.path === "/api/omni/connection/finish")?.body,
  ).toEqual(generated);
  const toast = await screen.findByRole("alertdialog");
  await events.click(within(toast).getByRole("button", { name: "Dismiss" }));
});
it("handles Tailscale authorization expiry in the wizard", async () => {
  const events = await choose("Tailscale");
  expect(
    screen.queryByRole("textbox", { name: "Your Cloudflare domain" }),
  ).toBeNull();
  await events.click(
    screen.getByRole("checkbox", { name: /Allow my Tailscale devices/ }),
  );
  await events.click(screen.getByRole("button", { name: "Connect Tailscale" }));
  expect(
    (
      await screen.findByRole("link", { name: "Sign in to Tailscale ↗" })
    ).getAttribute("href"),
  ).toBe("https://login.tailscale.com/a/test-only");
  job = {
    id: "test-job",
    profile: "tailscale",
    state: "expired",
    message: "Expired",
    auth_url: null,
    integration: null,
  };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["omni-connection"] });
  });
  await screen.findByText(
    "The sign-in request expired. Try again when you’re ready.",
  );
  expect(
    screen.queryByRole("link", { name: "Sign in to Tailscale ↗" }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Connect Tailscale" })
      .hasAttribute("disabled"),
  ).toBe(false);
});
it("waits for the included service without suggesting an extra installation", async () => {
  available = false;
  const events = await choose("Tailscale");
  await screen.findByText("Preparing the built-in connection service…");
  expect(screen.queryByText(/Install the connector/)).toBeNull();
  await events.click(
    screen.getByRole("checkbox", { name: /Allow my Tailscale devices/ }),
  );
  expect(
    screen
      .getByRole("button", { name: "Connect Tailscale" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("invalidates checks when an advanced address is changed", async () => {
  receiverOk = true;
  const events = await choose("This network (LAN)");
  await screen.findByRole("heading", { name: "Your connection is ready" });
  await events.click(screen.getByText("Advanced settings"));
  const field = screen.getByRole("textbox", { name: "S3 receiver address" });
  await events.clear(field);
  await events.type(field, "https://other.example.test");
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Live connection checks" }),
    ).toBeNull();
  });
  expect(
    screen
      .getByRole("button", { name: "Save connection" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
