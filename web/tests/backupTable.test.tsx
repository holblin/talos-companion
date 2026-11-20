import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2/Provider";
import { expect, it } from "vitest";
import BackupTable from "../src/BackupTable";
import { User } from "@react-aria/test-utils";

const backup = {
  name: "companion-1794078000-abcd1234.tcb",
  bytes: 7 * 1024 * 1024,
};

function mount() {
  render(
    <Provider>
      <BackupTable backups={[backup]} />
    </Provider>,
  );
}

it("keeps Download before Size and preserves the download URL", async () => {
  mount();
  await screen.findByText(backup.name);
  expect(
    screen.getAllByRole("columnheader").map((header) => header.textContent),
  ).toEqual(["Created", "Download", "Size"]);
  const link = screen.getByRole("link", { name: "Download" });
  expect(link.getAttribute("href")).toBe(`/api/backups/${backup.name}`);
  expect(link.hasAttribute("download")).toBe(true);
  expect(screen.getByText("7.00 MB")).toBeTruthy();
});

it("shows the full filename on keyboard focus and dismisses the tooltip with Escape", async () => {
  const events = userEvent.setup();
  mount();
  const filename = await screen.findByRole("link", { name: backup.name });
  act(() => {
    filename.focus();
  });
  await events.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(filename);
  expect((await screen.findByRole("tooltip")).textContent).toBe(backup.name);
  await events.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  expect(screen.queryByRole("button", { name: /Details for/ })).toBeNull();
});

it("preserves the empty state without a tooltip or download action", () => {
  render(
    <Provider>
      <BackupTable backups={[]} />
    </Provider>,
  );
  expect(screen.getByText("Your first backup starts here.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
});

it("sorts through native column menus while keeping unknown dates last", async () => {
  const backups = [
    { name: "imported-recovery.tcb", bytes: 2 },
    { name: "companion-1700000000-old.tcb", bytes: 100 },
    { name: "companion-1794078000-new.tcb", bytes: 9 },
  ];
  render(
    <Provider>
      <BackupTable backups={backups} />
    </Provider>,
  );
  const table = new User({ interactionType: "mouse" }).createTester("Table", {
    root: screen.getByRole("grid", { name: "Encrypted recovery files" }),
  });
  const names = () =>
    table
      .getRowHeaders()
      .map((header) => header.querySelector("code")?.textContent);
  expect(names()).toEqual([
    backups[2]?.name,
    backups[1]?.name,
    backups[0]?.name,
  ]);
  await table.triggerColumnHeaderAction({ column: "Size", action: 0 });
  expect(names()).toEqual([
    backups[0]?.name,
    backups[2]?.name,
    backups[1]?.name,
  ]);
  await table.triggerColumnHeaderAction({ column: "Size", action: 1 });
  expect(names()).toEqual([
    backups[1]?.name,
    backups[2]?.name,
    backups[0]?.name,
  ]);
  await table.triggerColumnHeaderAction({ column: "Created", action: 0 });
  expect(names()).toEqual([
    backups[1]?.name,
    backups[2]?.name,
    backups[0]?.name,
  ]);
  expect(
    screen
      .getByRole("columnheader", { name: /Created/ })
      .getAttribute("aria-sort"),
  ).toBe("ascending");
});

it("offers resize on the download column without meaningless sorting", async () => {
  const events = userEvent.setup();
  mount();
  await events.click(screen.getByRole("button", { name: "Download" }));
  expect(screen.getByRole("menuitem", { name: /Resize/i })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Sort/i })).toBeNull();
});

it("supports keyboard column resizing without changing sort order", async () => {
  const events = userEvent.setup();
  mount();
  await events.click(screen.getByRole("button", { name: "Created" }));
  await events.keyboard("{End}{Enter}");
  const resizer = screen.getByRole<HTMLInputElement>("slider", {
    name: /Created/,
  });
  const original = Number(resizer.value);
  expect(document.activeElement).toBe(resizer);
  await events.keyboard("{ArrowRight}");
  expect(Number(resizer.value)).toBeGreaterThan(original);
  await events.keyboard("{Escape}");
  expect(
    screen
      .getByRole("columnheader", { name: /^Created/ })
      .getAttribute("aria-sort"),
  ).toBe("descending");
});
