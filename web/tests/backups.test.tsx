import { User } from "@react-aria/test-utils";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2/Provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import BackupDestinations, { BackupFrequency } from "../src/BackupSetup";

const overview = {
  issuer: "https://companion.example.test",
  mounted: null,
  drive: { client_id: "", folder_id: "", connected: false },
};
const verifiedAccess = {
  integration: {
    profile: "cloudflare",
    companion_url: overview.issuer,
    omni_url: "",
    s3_endpoint: "https://s3.example.test",
  },
  verified_at: 1,
};
beforeEach(() => {
  vi.stubGlobal("location", { origin: overview.issuer, assign: vi.fn() });
});

function mount(
  info: Omit<typeof overview, "mounted"> & {
    mounted: string | null;
  } = overview,
  accesses = [verifiedAccess],
) {
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) =>
      input === "/api/companion/access"
        ? Promise.resolve(
            new Response(
              JSON.stringify({ accesses, active_issuer: overview.issuer }),
            ),
          )
        : fetch(input, init),
    ),
  );
  const createBackup = vi.fn(async () => {});
  const refresh = vi.fn(async () => {});
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider locale="en-US">
        <BackupDestinations
          overview={info}
          createBackup={createBackup}
          refresh={refresh}
        />
      </Provider>
    </QueryClientProvider>,
  );
  return { ...result, createBackup, refresh };
}

it("offers setup directly on unconfigured backup cards and saves Google credentials before sign-in", async () => {
  const events = userEvent.setup();
  const fetch = vi.fn((path: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          path === "/api/drive"
            ? { ok: true }
            : { error: "Google is temporarily unavailable" },
        ),
        { status: path === "/api/drive" ? 200 : 503 },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  mount();
  expect(
    screen.queryByRole("button", { name: "Back up to Drive →" }),
  ).toBeNull();
  await events.click(
    screen.getByRole("button", { name: "Set up Google Drive" }),
  );
  await screen.findByRole("dialog", { name: "Google Drive setup" });
  expect(screen.getByLabelText("Google client ID")).toBeTruthy();
  expect(
    await screen.findByText(overview.issuer + "/oauth/google/callback"),
  ).toBeTruthy();
  await events.type(
    screen.getByLabelText(/Google client ID/),
    "application-id",
  );
  await events.type(
    screen.getByLabelText(/Google client secret/),
    "test-client-value",
  );
  await events.click(
    screen.getByRole("button", { name: "Save and authorize Google Drive ↗" }),
  );
  await screen.findByRole("alert");
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    "/api/drive",
    "/api/drive/connect",
  ]);
  const init = vi
    .mocked(globalThis.fetch)
    .mock.calls.find(([path]) => path === "/api/drive")?.[1] as RequestInit;
  expect(init.body).toBe(
    JSON.stringify({
      client_id: "application-id",
      client_secret: "test-client-value",
      folder_id: "",
    }),
  );
  await events.click(
    screen.getByRole("button", { name: "Sign in with Google ↗" }),
  );
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  expect(fetch.mock.calls[2]?.[0]).toBe("/api/drive/connect");
});

it("warns before Google setup when verified HTTPS access is missing", async () => {
  const events = userEvent.setup();
  mount({ ...overview, issuer: "http://192.0.2.10:8080" }, []);
  await events.click(
    screen.getByRole("button", { name: "Set up Google Drive" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Set up verified HTTPS Companion access",
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Save and authorize Google Drive ↗",
    }).disabled,
  ).toBe(true);
  expect(
    screen.queryByText("http://192.0.2.10:8080/oauth/google/callback"),
  ).toBeNull();
});

it("reuses verified access for Google instructions when opened through HTTP", async () => {
  vi.stubGlobal("location", {
    origin: "http://192.0.2.10:8080",
    assign: vi.fn(),
  });
  const events = userEvent.setup();
  mount({ ...overview, issuer: "http://192.0.2.10:8080" });
  await events.click(
    screen.getByRole("button", { name: "Set up Google Drive" }),
  );
  expect(
    await screen.findByText(overview.issuer + "/oauth/google/callback"),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Continue setup over HTTPS" })
      .getAttribute("href"),
  ).toBe(overview.issuer + "/backups#google-drive");
});

it("opens a Spectrum dialog and returns keyboard focus to the setup trigger when it closes", async () => {
  mount();
  const trigger = screen.getByRole("button", { name: "Set up Google Drive" });
  const dialog = new User({ interactionType: "keyboard" }).createTester(
    "Dialog",
    { root: trigger },
  );
  await dialog.open();
  expect(dialog.getDialog()?.contains(document.activeElement)).toBe(true);
  await dialog.close();
  await waitFor(() => {
    expect(document.activeElement).toBe(trigger);
  });
});

it("reconnects an existing Google application without overwriting its credentials", async () => {
  const events = userEvent.setup();
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "Try again" }), { status: 503 }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  mount({
    ...overview,
    drive: {
      client_id: "saved-app",
      folder_id: "saved-folder",
      connected: true,
    },
  });
  await events.click(
    screen.getByRole("button", { name: "Manage Google Drive" }),
  );
  expect(screen.queryByLabelText(/Google client secret/)).toBeNull();
  await events.click(
    screen.getByRole("button", { name: "Reconnect Google Drive ↗" }),
  );
  await screen.findByRole("alert");
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/drive/connect",
    expect.anything(),
  );
});

it("checks and saves a native SMB destination, retaining entered details on failure", async () => {
  const events = userEvent.setup();
  let finishCheck: ((response: Response) => void) | undefined;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishCheck = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  const { refresh } = mount();
  await events.click(screen.getByRole("button", { name: "Set up NFS / SMB" }));
  const submit = screen.getByRole<HTMLButtonElement>("button", {
    name: "Check access and save",
  });
  expect(submit.form).toBeTruthy();
  expect(submit.closest("form")).toBeNull();
  expect(
    submit.parentElement?.contains(
      screen.getByRole("button", { name: "Close setup" }),
    ),
  ).toBe(true);
  expect(screen.queryByText("MOUNTED_BACKUP_DIR")).toBeNull();
  await events.type(
    screen.getByLabelText(/Server hostname/),
    "nas.example.test",
  );
  await events.type(screen.getByLabelText(/SMB share name/), "Backups");
  await events.type(screen.getByLabelText(/SMB username/), "backup-user");
  await events.type(screen.getByLabelText(/SMB password/), "share-secret");
  await events.click(
    screen.getByRole("button", { name: "Check access and save" }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Checking share…" })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Close setup" })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByLabelText<HTMLInputElement>(/Server hostname/).disabled,
  ).toBe(true);
  finishCheck?.(
    new Response(JSON.stringify({ error: "Share is unavailable" }), {
      status: 400,
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Share is unavailable",
  );
  expect(refresh).not.toHaveBeenCalled();
  await events.click(
    screen.getByRole("button", { name: "Check access and save" }),
  );
  await screen.findByRole("status");
  expect(refresh).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/backups/network",
    expect.objectContaining({
      body: JSON.stringify({
        protocol: "smb",
        host: "nas.example.test",
        share: "Backups",
        directory: "",
        username: "backup-user",
        password: "share-secret",
        uid: 99,
        gid: 100,
      }),
    }),
  );
});

it("switches the native setup to NFS export and identity fields", async () => {
  const events = userEvent.setup();
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  mount();
  await events.click(screen.getByRole("button", { name: "Set up NFS / SMB" }));
  await new User()
    .createTester("Select", {
      root: screen.getByRole("button", { name: /Share protocol/ }),
    })
    .toggleOptionSelection({ option: "NFSv3" });
  expect(screen.queryByLabelText(/SMB password/)).toBeNull();
  await events.type(
    screen.getByLabelText(/Server hostname/),
    "nas.example.test",
  );
  await events.type(
    screen.getByLabelText(/NFS export path/),
    "/exports/backups",
  );
  await events.click(
    screen.getByRole("button", { name: "Check access and save" }),
  );
  await screen.findByRole("status");
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/backups/network",
    expect.objectContaining({
      body: JSON.stringify({
        protocol: "nfs",
        host: "nas.example.test",
        share: "/exports/backups",
        directory: "",
        username: "",
        password: "",
        uid: 99,
        gid: 100,
      }),
    }),
  );
});

it("submits human-readable schedule choices as the backend interval", async () => {
  const { container } = render(
    <Provider locale="en-US">
      <form>
        <BackupFrequency seconds={86400} />
      </form>
    </Provider>,
  );
  const form = container.querySelector("form");
  if (!form) throw new Error("Expected schedule form");
  expect(new FormData(form).get("interval_seconds")).toBe("86400");
  await new User({ interactionType: "keyboard" })
    .createTester("Select", {
      root: screen.getByRole("button", { name: /Backup frequency/ }),
    })
    .toggleOptionSelection({ option: "Every week" });
  expect(new FormData(form).get("interval_seconds")).toBe("604800");
});

it("opens local management before creating a local backup", async () => {
  const events = userEvent.setup();
  const { createBackup } = mount();
  expect(
    screen.queryByRole("button", { name: /Create local backup/ }),
  ).toBeNull();
  await events.click(
    screen.getByRole("button", { name: "Manage Local storage" }),
  );
  await screen.findByRole("dialog", { name: "Local backup management" });
  expect(createBackup).not.toHaveBeenCalled();
  await events.click(
    screen.getByRole("button", { name: "Create local backup" }),
  );
  await waitFor(() => {
    expect(createBackup).toHaveBeenCalledExactlyOnceWith("local");
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("manages a saved Google application before authorization is complete", async () => {
  const events = userEvent.setup();
  mount({
    ...overview,
    drive: { client_id: "saved-app", folder_id: "", connected: false },
  });
  expect(
    screen.queryByRole("button", { name: "Set up Google Drive" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Back up to Drive →" }),
  ).toBeNull();
  await events.click(
    screen.getByRole("button", { name: "Manage Google Drive" }),
  );
  await screen.findByRole("dialog", { name: "Google Drive setup" });
  expect(
    screen.getByRole("button", { name: "Sign in with Google ↗" }),
  ).toBeTruthy();
});
