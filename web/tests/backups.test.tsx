import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2/Provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import BackupDestinations, { BackupFrequency } from "../src/BackupSetup";

const overview = {
  issuer: "https://companion.example.test",
  mounted: null,
  drive: { client_id: "", folder_id: "", connected: false },
};

function mount(
  info: Omit<typeof overview, "mounted"> & {
    mounted: string | null;
  } = overview,
) {
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
    screen.getByText(overview.issuer + "/oauth/google/callback"),
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
  const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
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

it("opens a Spectrum dialog and returns keyboard focus to the setup trigger when it closes", async () => {
  const events = userEvent.setup();
  mount();
  const trigger = screen.getByRole("button", { name: "Set up Google Drive" });
  await events.click(trigger);
  expect(
    screen
      .getByRole("dialog", { name: "Google Drive setup" })
      .contains(document.activeElement),
  ).toBe(true);
  await events.click(screen.getByRole("button", { name: "Close setup" }));
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
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Share is unavailable" }), {
        status: 400,
      }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  const { refresh } = mount();
  await events.click(screen.getByRole("button", { name: "Set up NFS / SMB" }));
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
  await events.click(screen.getByRole("button", { name: /Share protocol/ }));
  await events.click(screen.getByRole("option", { name: "NFSv3" }));
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
  const events = userEvent.setup();
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
  await events.click(screen.getByRole("button", { name: /Backup frequency/ }));
  await events.click(screen.getByRole("option", { name: "Every week" }));
  expect(new FormData(form).get("interval_seconds")).toBe("604800");
});
