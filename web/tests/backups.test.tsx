import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2";
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
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Connect Google Drive" }),
  );
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

it("returns keyboard focus to the setup trigger when the panel closes", async () => {
  const events = userEvent.setup();
  mount();
  const trigger = screen.getByRole("button", { name: "Set up Google Drive" });
  await events.click(trigger);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Connect Google Drive" }),
  );
  await events.click(screen.getByRole("button", { name: "Close setup" }));
  expect(document.activeElement).toBe(trigger);
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

it("reports a failed share check and supports a successful retry without claiming a NAS mount is verified", async () => {
  const events = userEvent.setup();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Share is unavailable" }), {
        status: 400,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ path: "/destinations/network" })),
    );
  vi.stubGlobal("fetch", fetch);
  const { refresh } = mount({
    ...overview,
    mounted: "/destinations/network",
  });
  await events.click(screen.getByRole("button", { name: "Manage NFS / SMB" }));
  await events.click(
    screen.getByRole("button", { name: "Check share access" }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Share is unavailable",
  );
  expect(screen.queryByText("Write check passed")).toBeNull();
  await events.click(
    screen.getByRole("button", { name: "Check share access" }),
  );
  await screen.findByText("Write check passed");
  expect(refresh).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenLastCalledWith(
    "/api/backups/mounted/check",
    expect.anything(),
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
