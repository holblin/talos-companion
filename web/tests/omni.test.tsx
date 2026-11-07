import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, ToastContainer } from "@react-spectrum/s2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CompanionAccess,
  OmniConfiguration,
  type AccessMethod,
} from "../src/AccessPages";
import type { Integration } from "../src/OmniSetup";

const local: Integration = {
  profile: "lan",
  companion_url: "https://companion.local.test:18480",
  omni_url: "",
  s3_endpoint: "https://companion.local.test:18480",
};
const cloud: Integration = {
  profile: "cloudflare",
  companion_url: "https://companion.example.test",
  omni_url: "https://omni.example.test",
  s3_endpoint: "https://s3.example.test",
};
const tailscale: Integration = {
  profile: "tailscale",
  companion_url: "https://companion.example.ts.net",
  omni_url: "https://companion.example.ts.net:8443",
  s3_endpoint: "https://companion.example.ts.net:10000",
};
type Job = {
  id: string;
  profile: string;
  state: string;
  auth_url: string | null;
  integration: Integration | null;
  message?: string;
};
let accesses: AccessMethod[],
  issuer: string,
  job: Job | null,
  posted: { path: string; body: unknown }[],
  rejectActivation: boolean;
let client: QueryClient;
let providers: Integration["profile"][];
beforeEach(() => {
  providers = ["cloudflare", "tailscale"];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  accesses = [];
  issuer = "http://companion.local.test:18480";
  job = null;
  posted = [];
  rejectActivation = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Partial<Integration>)
          : {};
      if (init?.method === "POST") posted.push({ path, body });
      let value: unknown = { ok: true },
        status = 200;
      if (path === "/api/companion/access") {
        if (init?.method === "POST") {
          const integration =
            [local, cloud, tailscale].find((i) => i.profile === body.profile) ??
            local;
          accesses = [
            ...accesses.filter((a) => a.integration.profile !== body.profile),
            { integration, verified_at: 100 },
          ];
        }
        value = { accesses, active_issuer: issuer };
      } else if (path === "/api/omni")
        value = {
          integration: local,
          defaults: local,
          active_issuer: issuer,
          mounted: false,
          restart_pending: false,
        };
      else if (path === "/api/companion/local")
        value = { companion_url: local.companion_url, trust_required: true };
      else if (path === "/api/companion/activate") {
        if (rejectActivation) {
          status = 400;
          value = { error: "Endpoint verification failed" };
        } else {
          issuer = body.companion_url ?? "";
          value = { ok: true, active_issuer: issuer };
        }
      } else if (path === "/api/omni/connection") {
        if (init?.method === "POST") {
          job = {
            id: "job-1",
            profile: body.profile ?? "cloudflare",
            state: "authorizing",
            auth_url:
              body.profile === "cloudflare"
                ? "https://dash.cloudflare.com/argotunnel?demo"
                : "https://login.tailscale.com/a/demo",
            integration: null,
          };
          value = { id: "job-1" };
        } else
          value = {
            available: true,
            bundled: true,
            providers,
            backend_origin: "",
            saved: null,
            connection: job,
          };
      } else if (path === "/api/omni/location")
        value = { origin: "https://omni.existing.test" };
      else if (path === "/api/omni/check")
        value = {
          checks: ["Companion", "Omni", "S3"].map((service) => ({
            service,
            ok: true,
            message: "Verified",
            endpoint: "https://demo.test",
            vantage: "Companion",
          })),
          checked_at: 100,
          omni_to_s3_verified: false,
          note: "A real backup is required",
        };
      return Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
});
function mount(component = <CompanionAccess />) {
  return render(
    <QueryClientProvider client={client}>
      <Provider locale="en-US">
        {component}
        <ToastContainer />
      </Provider>
    </QueryClientProvider>,
  );
}
async function selectOmni(name: string) {
  const events = userEvent.setup();
  mount(<OmniConfiguration />);
  await events.click(
    await screen.findByRole("button", { name: /Companion access for Omni/ }),
  );
  await events.click(screen.getByRole("option", { name }));
  return events;
}
it("enumerates independent access methods without an Omni prerequisite", async () => {
  accesses = [
    { integration: local, verified_at: 100 },
    { integration: tailscale, verified_at: 100 },
  ];
  issuer = local.companion_url;
  mount();
  await screen.findByRole("button", { name: "Manage Local HTTPS" });
  expect(
    screen.getByRole("button", { name: "Manage Local HTTPS" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage Tailscale" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Omni address" })).toBeNull();
  expect(posted).toEqual([]);
});
it("saves local access after explicit trust and verification without changing the issuer", async () => {
  const events = userEvent.setup();
  mount();
  await events.click(
    await screen.findByRole("button", { name: "Add Local HTTPS" }),
  );
  await events.click(
    screen.getByRole("button", { name: "Prepare local HTTPS" }),
  );
  await screen.findByRole("link", {
    name: "Download Companion trust certificate",
  });
  expect(
    screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
  ).toBe(true);
  await events.click(
    screen.getByRole("checkbox", { name: /I installed the certificate/ }),
  );
  await events.click(screen.getByRole("button", { name: "Continue" }));
  await events.click(
    screen.getByRole("button", { name: "Verify Companion HTTPS" }),
  );
  await screen.findByText("Companion HTTPS and identity verified");
  await events.click(
    screen.getByRole("button", { name: "Save access method" }),
  );
  await screen.findByRole("button", { name: "Manage Local HTTPS" });
  expect(issuer).toBe("http://companion.local.test:18480");
  expect(
    posted.some(
      (p) =>
        p.path === "/api/companion/activate" || p.path === "/api/omni/location",
    ),
  ).toBe(false);
});
it("explains an excluded connector and blocks authorization in smaller images", async () => {
  providers = ["tailscale"];
  const events = userEvent.setup();
  mount();
  await events.click(
    await screen.findByRole("button", { name: "Add Cloudflare" }),
  );
  await screen.findByText(/Cloudflare is not included in this image/);
  await events.click(
    screen.getByRole("checkbox", { name: /Allow public access/ }),
  );
  expect(
    screen
      .getByRole("button", { name: "Continue with Cloudflare" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(posted.some((p) => p.path === "/api/omni/connection")).toBe(false);
});

it("adds Cloudflare alongside existing methods without implicitly selecting it for Omni", async () => {
  accesses = [
    { integration: local, verified_at: 100 },
    { integration: tailscale, verified_at: 100 },
  ];
  issuer = local.companion_url;
  const events = userEvent.setup();
  mount();
  await events.click(
    await screen.findByRole("button", { name: "Add Cloudflare" }),
  );
  expect(
    screen.getByRole("textbox", { name: /domain override/ }).closest("details")
      ?.open,
  ).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "Continue with Cloudflare" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await events.click(
    screen.getByRole("checkbox", { name: /Allow public access/ }),
  );
  await events.click(
    screen.getByRole("button", { name: "Continue with Cloudflare" }),
  );
  await screen.findByRole("link", { name: "Open Cloudflare sign-in ↗" });
  job = {
    id: "job-1",
    profile: "cloudflare",
    state: "connected",
    auth_url: null,
    integration: cloud,
  };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["omni-connection"] });
  });
  await screen.findByRole("heading", {
    name: "Verify and save Companion access",
  });

  await screen.findByText("Companion HTTPS and identity verified");
  await events.click(
    screen.getByRole("button", { name: "Save access method" }),
  );
  await screen.findByRole("button", { name: "Manage Cloudflare" });
  expect(posted.find((p) => p.path === "/api/omni/connection")?.body).toEqual({
    profile: "cloudflare",
    domain: "",
  });
  expect(posted.filter((p) => p.path === "/api/companion/check")).toHaveLength(
    1,
  );
  expect(accesses).toHaveLength(3);
  expect(issuer).toBe(local.companion_url);
});
it("blocks Omni configuration until an access method has been verified", async () => {
  accesses = [{ integration: cloud, verified_at: 0 }];
  mount(<OmniConfiguration />);
  await screen.findByRole("heading", {
    name: "Configure Companion access first",
  });
  expect(
    screen
      .getByRole("link", { name: /Set up Companion access/ })
      .getAttribute("href"),
  ).toBe("/access");
  expect(
    screen.queryByRole("button", { name: "Use this access for Omni" }),
  ).toBeNull();
});
it("requires explicit issuer consent and uses the selected automatic endpoints for Omni", async () => {
  accesses = [local, cloud, tailscale].map((integration) => ({
    integration,
    verified_at: 100,
  }));
  issuer = local.companion_url;
  const events = await selectOmni("Tailscale");
  expect(
    screen
      .getByRole("button", { name: "Use this access for Omni" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await events.click(
    screen.getByRole("checkbox", { name: /Use this address as the canonical/ }),
  );
  await events.click(
    screen.getByRole("button", { name: "Use this access for Omni" }),
  );
  await screen.findByRole("heading", { name: "Where do you open Omni?" });
  await events.type(
    screen.getByRole("textbox", { name: "Omni address" }),
    "omni.existing.test",
  );
  await events.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Network checks passed" });
  await events.click(
    screen.getByRole("button", { name: "Save verified network" }),
  );
  await waitFor(() => {
    expect(
      posted.find((p) => p.path === "/api/omni/connection/finish")?.body,
    ).toEqual(tailscale);
  });
  expect(accesses).toHaveLength(3);
});
it("rechecks a saved access method before it can be used for Omni", async () => {
  accesses = [{ integration: local, verified_at: 100 }];
  issuer = local.companion_url;
  rejectActivation = true;
  const events = await selectOmni("Local HTTPS");
  await events.click(
    screen.getByRole("button", { name: "Use this access for Omni" }),
  );
  await screen.findByText("Endpoint verification failed");
  expect(screen.queryByRole("textbox", { name: "Omni address" })).toBeNull();
  expect(posted.some((p) => p.path === "/api/companion/activate")).toBe(true);
});

it("keeps manual Cloudflare domain entry under Advanced and displays actionable failures", async () => {
  job = {
    id: "failed",
    profile: "cloudflare",
    state: "failed",
    auth_url: null,
    integration: null,
    message:
      "Couldn’t detect the domain. Open Advanced settings and try again.",
  };
  const events = userEvent.setup();
  mount();
  await events.click(
    await screen.findByRole("button", { name: "Add Cloudflare" }),
  );
  await screen.findByText(/Couldn’t detect the domain/);
  await events.click(screen.getByText("Advanced settings"));
  await events.type(
    screen.getByRole("textbox", { name: /domain override/ }),
    "example.test",
  );
  await events.click(
    screen.getByRole("checkbox", { name: /Allow public access/ }),
  );
  await events.click(
    screen.getByRole("button", { name: "Continue with Cloudflare" }),
  );
  await screen.findByRole("link", { name: "Open Cloudflare sign-in ↗" });
  expect(posted.find((p) => p.path === "/api/omni/connection")?.body).toEqual({
    profile: "cloudflare",
    domain: "example.test",
  });
});
