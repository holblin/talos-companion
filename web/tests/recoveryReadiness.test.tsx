import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2/Provider";
import { expect, it, vi } from "vitest";
import RecoveryReadiness from "../src/RecoveryReadiness";
import type { NetworkShare } from "../src/BackupSetup";

const overview = {
  settings: {
    schedule: { enabled: true, interval_seconds: 86400, destination: "local" },
  },
  drive: { connected: false },
  mounted: null as string | null,
  network: null as NetworkShare | null,
};

function mount(info: typeof overview | null = overview) {
  const onManage = vi.fn();
  render(
    <Provider>
      <RecoveryReadiness
        overview={info}
        backups={[]}
        onManage={onManage}
        onSettings={vi.fn()}
      />
    </Provider>,
  );
  return onManage;
}

it("offers an actionable notice for local-only backups without losing the restore caveat", async () => {
  const onManage = mount();
  expect(
    screen.getByRole("heading", { name: "Add an external recovery copy" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/A listed archive is not a verified restore/),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Configure backup destinations" }),
  );
  expect(onManage).toHaveBeenCalledOnce();
});

it("does not warn while destination status is unavailable", () => {
  mount(null);
  expect(
    screen.getByText("External destination status unavailable"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Add an external recovery copy" }),
  ).toBeNull();
});

it("keeps connected Google Drive status neutral rather than claiming a verified copy", () => {
  mount({ ...overview, drive: { connected: true } });
  expect(
    screen.getByText(
      "External destination configured; confirm your copy is current",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Add an external recovery copy" }),
  ).toBeNull();
});

it.each(["nfs", "smb"] as const)(
  "recognizes a configured %s share as an external destination",
  (protocol) => {
    mount({
      ...overview,
      network: {
        protocol,
        host: "nas.example.test",
        share: "backups",
        directory: "",
        username: "",
        uid: 0,
        gid: 0,
      },
    });
    expect(
      screen.getByText(
        "External destination configured; confirm your copy is current",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Add an external recovery copy" }),
    ).toBeNull();
  },
);

it("preserves support for a configured legacy mounted destination", () => {
  mount({ ...overview, mounted: "/mnt/nas-backups" });
  expect(
    screen.queryByRole("heading", { name: "Add an external recovery copy" }),
  ).toBeNull();
  expect(
    screen.getByText(
      "External destination configured; confirm your copy is current",
    ),
  ).toBeTruthy();
});
