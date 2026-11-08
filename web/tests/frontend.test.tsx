import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../src/router";
import { queryClient } from "../src/query";

const user = {
  id: "test-admin",
  name: "Test Admin",
  email: "admin@example.test",
  admin: true,
};
const settings = {
  retention: { recovery_keep_last: 7, snapshot_keep_last: 30 },
  schedule: { enabled: true, interval_seconds: 86400, destination: "local" },
};
const overview = {
  settings,
  issuer: "https://companion.example.test",
  client_id: "omni",
  client_secret: "test-only-secret",
  redirect_uri: "https://omni.example.test/callback",
  s3_access_key: "test-key",
  s3_secret_key: "test-only-key",
  bucket: "omni",
  mounted: null,
  drive: { client_id: "", folder_id: "", connected: false },
  retention: settings.retention,
  streaming_backups: true,
};
const backups = [{ name: "test-recovery.tcb", bytes: 1024 }];
let initialized = false;
let authenticated = false;
let requests: { path: string; body: unknown }[] = [];
let router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));

beforeEach(() => {
  router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
  queryClient.clear();
  initialized = false;
  authenticated = false;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const path = input;
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ path, body });
      let value: unknown;
      let status = 200;
      if (path === "/api/status") value = { initialized };
      else if (path === "/api/me") {
        value = authenticated ? user : { error: "Sign in required" };
        status = authenticated ? 200 : 401;
      } else if (path === "/api/login") {
        authenticated = true;
        value = user;
      } else if (path === "/api/logout") {
        authenticated = false;
        value = {};
      } else if (path === "/api/overview") value = overview;
      else if (path === "/api/users") value = [user];
      else if (path === "/api/vault") value = [];
      else if (path === "/api/backups")
        value =
          init?.method === "POST"
            ? { name: "new-test-recovery.tcb", warning: null }
            : backups;
      else if (path === "/api/setup/check")
        value = {
          backup_passphrase: "test recovery passphrase",
          public_url: overview.issuer,
          mounted: null,
          settings,
        };
      else if (path === "/api/setup" || path === "/api/restore") {
        initialized = true;
        value = {};
      } else if (path === "/api/companion/access")
        value = { accesses: [], active_issuer: overview.issuer };
      else if (path === "/api/settings") value = {};
      else {
        status = 404;
        value = { error: `Unexpected test request: ${path}` };
      }
      return Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
});

function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Spectrum frontend workflows", () => {
  it("preserves recovery data when accounts fail and retries only the failed section", async () => {
    initialized = true;
    authenticated = true;
    let failed = true;
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/users" && failed)
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "Accounts service unavailable" }),
              { status: 503 },
            ),
          );
        return fetch(input, init);
      }),
    );
    const events = userEvent.setup();
    mount();
    await screen.findByRole("button", { name: "Retry accounts" });
    await screen.findByText("1 encrypted");
    expect(screen.queryByText("0 encrypted")).toBeNull();
    expect(screen.queryByText("Needs setup")).toBeNull();
    expect(screen.queryByText("Your first backup starts here.")).toBeNull();
    expect(screen.getByText("Some data unavailable")).toBeTruthy();
    const backupRequests = requests.filter(
      (request) => request.path === "/api/backups",
    ).length;
    failed = false;
    await events.click(screen.getByRole("button", { name: "Retry accounts" }));
    await screen.findByText("1 account");
    expect(
      requests.filter((request) => request.path === "/api/backups"),
    ).toHaveLength(backupRequests);
  });

  it("does not present pending recovery files as empty", async () => {
    initialized = true;
    authenticated = true;
    const fetch = globalThis.fetch;
    let resolveBackups: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/backups")
          return new Promise<Response>((resolve) => {
            resolveBackups = resolve;
          });
        return fetch(input, init);
      }),
    );
    mount();
    await screen.findByText("Loading recovery files…");
    expect(screen.queryByText("Your first backup starts here.")).toBeNull();
    expect(screen.queryByText("0 encrypted")).toBeNull();
    expect(screen.queryByText("No recovery file yet")).toBeNull();
    if (!resolveBackups) throw new Error("Recovery request was not started");
    resolveBackups(new Response(JSON.stringify(backups)));
    await screen.findByText("1 encrypted");
  });

  it("focuses route headings and links directly to Google Drive setup", async () => {
    initialized = true;
    authenticated = true;
    const events = userEvent.setup();
    mount();
    await screen.findByRole("button", {
      name: "Connect Google Drive",
    });
    await events.click(screen.getByRole("link", { name: "Backups" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "A way back, always." }),
    );
    await events.click(screen.getByRole("link", { name: "Overview" }));
    await events.click(
      screen.getByRole("button", { name: "Connect Google Drive" }),
    );
    await screen.findByRole("heading", { name: "Connect Google Drive" });
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.hash).toBe("google-drive");
    expect(document.activeElement?.id).toBe("google-drive");
  });

  it("shows recovery errors in a dismissible S2 toast and allows retry", async () => {
    initialized = true;
    const events = userEvent.setup();
    const fallback = globalThis.fetch;
    let failRecovery = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (input === "/api/password/recover") {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                failRecovery
                  ? { error: "Invalid, expired or already used recovery code" }
                  : { ok: true },
              ),
              { status: failRecovery ? 401 : 200 },
            ),
          );
        }
        return fallback(input, init);
      }),
    );
    const { container } = mount();
    await screen.findByRole("button", { name: "Sign in →" });
    await events.click(screen.getByText("Forgot the administrator password?"));
    expect(screen.queryByRole("button", { name: "Sign in →" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Recover administrator access" }),
    ).toBe(document.activeElement);
    await events.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByRole("button", { name: "Sign in →" })).toBeTruthy();
    await events.click(screen.getByText("Forgot the administrator password?"));
    await events.type(
      screen.getByLabelText(/Administrator email/),
      "admin@example.test",
    );
    await events.type(
      screen.getByLabelText(/Recovery code from server/),
      "a".repeat(64),
    );
    await events.type(
      screen.getByLabelText(/^New password/),
      "replacement password",
    );
    await events.type(
      screen.getByLabelText(/Confirm new password/),
      "replacement password",
    );
    await events.click(
      screen.getByRole("button", {
        name: "Reset password using recovery code",
      }),
    );
    const message = await screen.findByText(
      "Invalid, expired or already used recovery code",
    );
    const toast = message.closest('[role="alertdialog"]');
    expect(toast).not.toBeNull();
    expect(container.querySelector(".message.error")).toBeNull();
    if (!(toast instanceof HTMLElement))
      throw new Error("Expected an S2 toast");
    await events.click(within(toast).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(
        screen.queryByText("Invalid, expired or already used recovery code"),
      ).toBeNull();
    });
    failRecovery = false;
    await events.click(
      screen.getByRole("button", {
        name: "Reset password using recovery code",
      }),
    );
    const success = await screen.findByText(
      "Password updated. Your recovery code has been used. Sign in with your new password.",
    );
    const successToast = success.closest('[role="alertdialog"]');
    if (!(successToast instanceof HTMLElement))
      throw new Error("Expected an S2 success toast");
    expect(screen.getByRole("button", { name: "Sign in →" })).toBeTruthy();
    expect(screen.queryByLabelText(/Recovery code from server/)).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Sign in to your companion" }),
    ).toBe(document.activeElement);
    await events.click(
      within(successToast).getByRole("button", { name: "Dismiss" }),
    );
  });

  it("completes setup with S2 controls and protects the recovery confirmation", async () => {
    const events = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Welcome to your companion." });
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await events.type(
      screen.getByLabelText(/Setup token/),
      "test-setup-token-at-least-24-characters",
    );
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await screen.findByRole("heading", { name: "Create your administrator." });
    await events.type(screen.getByLabelText(/Display name/), "Test Admin");
    await events.type(
      screen.getByLabelText(/Email address/),
      "admin@example.test",
    );
    await events.type(screen.getByLabelText(/^Password/), "test-only-password");
    await events.type(
      screen.getByLabelText(/Confirm password/),
      "test-only-password",
    );
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await screen.findByRole("heading", { name: "Choose your backup routine." });
    expect(
      screen.getByRole("button", { name: /Backup frequency/ }).textContent,
    ).toContain("Every day");
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await screen.findByRole("heading", { name: "Review and finish." });
    await events.click(
      screen.getByRole("checkbox", {
        name: /I have saved this backup passphrase/,
      }),
    );
    const confirmation = screen.getByLabelText(
      /Re-enter the saved backup passphrase/,
    );
    expect(confirmation.getAttribute("type")).toBe("password");
    expect(screen.queryByDisplayValue("test recovery passphrase")).toBeNull();
    await events.type(confirmation, "does-not-match");
    await events.click(
      screen.getByRole("button", { name: "Create companion" }),
    );
    await screen.findByRole("alert");
    expect(requests.some((request) => request.path === "/api/setup")).toBe(
      false,
    );
    await events.clear(confirmation);
    await events.type(confirmation, "test recovery passphrase");
    await events.click(
      screen.getByRole("button", { name: "Create companion" }),
    );
    await screen.findByRole("heading", { name: "Your companion is ready." });
    expect(
      requests.find((request) => request.path === "/api/setup")?.body,
    ).toEqual({
      name: "Test Admin",
      email: "admin@example.test",
      password: "test-only-password",
      settings,
      backup_passphrase_confirmation: "test recovery passphrase",
    });
  });

  it("signs in, follows real routes, creates a backup, and clears private data on logout", async () => {
    initialized = true;
    const events = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Sign in to your companion" });
    await events.type(screen.getByLabelText(/Email address/), user.email);
    await events.type(screen.getByLabelText(/^Password/), "test-only-password");
    await events.click(screen.getByRole("button", { name: "Sign in →" }));
    await screen.findByRole("button", { name: /Test Admin.*Sign out/ });
    expect(screen.queryByText("Workspace data loaded")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create local backup" }),
    ).toBeNull();
    await events.click(screen.getByRole("link", { name: "Backups" }));
    expect(router.state.location.pathname).toBe("/backups");
    await screen.findByRole("heading", { name: "Your recovery files" });
    await screen.findByRole("grid", { name: "Encrypted recovery files" });
    await events.click(
      screen.getByRole("button", { name: "Create local backup" }),
    );
    await screen.findByText("Backup saved: new-test-recovery.tcb");
    expect(
      requests.some(
        (request) =>
          request.path === "/api/backups" &&
          JSON.stringify(request.body) === '{"destination":"local"}',
      ),
    ).toBe(true);
    await events.click(screen.getByRole("link", { name: "Settings" }));
    expect(router.state.location.pathname).toBe("/settings");
    await screen.findByRole("heading", { name: "Backup settings" });
    expect(
      screen.queryByRole("button", { name: "Create local backup" }),
    ).toBeNull();
    const settingsHelp = screen.getByRole("button", {
      name: "How backup settings apply",
    });
    expect(settingsHelp.getAttribute("aria-expanded")).toBe("false");
    settingsHelp.focus();
    await events.keyboard("{Enter}");
    expect(settingsHelp.getAttribute("aria-expanded")).toBe("true");
    await screen.findByText(
      /An active backup finishes with its original settings/,
    );
    await events.click(
      screen.getByRole("button", { name: "Save backup settings" }),
    );
    await waitFor(() => {
      expect(
        requests.find((request) => request.path === "/api/settings")?.body,
      ).toEqual(settings);
    });
    await events.click(
      screen.getByRole("button", { name: /Test Admin.*Sign out/ }),
    );
    await screen.findByRole("heading", { name: "Sign in to your companion" });
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["admin", user.id] }),
    ).toHaveLength(0);
  });

  it("streams a selected recovery file with its original passphrase", async () => {
    const events = userEvent.setup();
    const { container } = mount();
    await screen.findByRole("heading", { name: "Welcome to your companion." });
    await events.click(
      screen.getByRole("radio", { name: "Restore an existing companion" }),
    );
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await events.type(
      screen.getByLabelText(/Setup token/),
      "test-setup-token-at-least-24-characters",
    );
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await screen.findByRole("heading", { name: "Choose your recovery file." });
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Recovery file input missing");
    const file = new File(["test-encrypted-archive"], "recovery.tcb", {
      type: "application/octet-stream",
    });
    await events.upload(input, file);
    await events.type(
      screen.getByLabelText(/Original backup passphrase/),
      "original test passphrase",
    );
    await events.click(screen.getByRole("button", { name: "Continue →" }));
    await screen.findByRole("heading", { name: "Review and finish." });
    await events.click(
      screen.getByRole("checkbox", {
        name: /I have saved this backup passphrase/,
      }),
    );
    await events.type(
      screen.getByLabelText(/Re-enter the saved backup passphrase/),
      "test recovery passphrase",
    );
    await events.click(
      screen.getByRole("button", { name: "Restore companion" }),
    );
    await screen.findByRole("heading", { name: "Your companion is ready." });
    const payload = requests.find(
      (request) => request.path === "/api/restore",
    )?.body;
    expect(payload).toBeInstanceOf(FormData);
    if (!(payload instanceof FormData))
      throw new Error("Expected multipart restore payload");
    expect(payload.get("file")).toBe(file);
    expect(payload.get("passphrase")).toBe("original test passphrase");
    expect(payload.get("backup_passphrase_confirmation")).toBe(
      "test recovery passphrase",
    );
    expect(payload.has("account")).toBe(false);
  });

  it("offers separate access and Omni pages and keeps Omni gated until access is configured", async () => {
    initialized = true;
    authenticated = true;
    const events = userEvent.setup();
    mount();
    const accessLink = await screen.findByRole("link", {
      name: "Companion access",
    });
    expect(accessLink.getAttribute("href")).toBe("/access");
    expect(
      screen
        .getByRole("link", { name: "Omni configuration" })
        .getAttribute("href"),
    ).toBe("/omni-configuration");
    expect(screen.queryByRole("link", { name: "Identity" })).toBeNull();
    await events.click(accessLink);
    await screen.findByRole("heading", { name: "Companion access" });
    await events.click(
      within(screen.getByRole("complementary")).getByRole("link", {
        name: "Omni configuration",
      }),
    );
    await screen.findByRole("heading", {
      name: "Configure Companion access first",
    });
    expect(
      screen.queryByText("Advanced settings: identity and backup credentials"),
    ).toBeNull();
  });

  it("offers a retry when the server is unreachable", async () => {
    const events = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Temporarily unavailable" }), {
            status: 503,
          }),
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ initialized: false })),
        ),
    );
    mount();
    await screen.findByText("Temporarily unavailable");
    await events.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Welcome to your companion." });
  });
});
