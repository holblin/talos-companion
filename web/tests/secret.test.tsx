import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "@react-spectrum/s2/Provider";
import { ToastQueue } from "@react-spectrum/s2/Toast";
import { expect, it, vi } from "vitest";
import Secret from "../src/Secret";

const value = "private-test-value";

function mount() {
  const events = userEvent.setup();
  const positive = vi.spyOn(ToastQueue, "positive").mockReturnValue(vi.fn());
  const negative = vi.spyOn(ToastQueue, "negative").mockReturnValue(vi.fn());
  render(
    <Provider>
      <Secret label="Client secret" value={value} />
    </Provider>,
  );
  return { events, positive, negative };
}

it("copies the actual credential without revealing it or putting it in a toast", async () => {
  const { events, positive, negative } = mount();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await events.click(
    screen.getByRole("button", { name: "Copy Client secret" }),
  );
  await waitFor(() => {
    expect(positive).toHaveBeenCalledWith("Client secret copied.");
  });
  expect(write).toHaveBeenCalledExactlyOnceWith(value);
  expect(screen.queryByText(value)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Reveal Client secret" }),
  ).toBeTruthy();
  expect(negative).not.toHaveBeenCalled();
});

it("provides a safe fallback when clipboard permission is denied", async () => {
  const { events, positive, negative } = mount();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error(value),
  );
  await events.click(
    screen.getByRole("button", { name: "Copy Client secret" }),
  );
  await waitFor(() => {
    expect(negative).toHaveBeenCalledWith(
      "Could not copy. Reveal and select the value instead.",
    );
  });
  expect(positive).not.toHaveBeenCalled();
  expect(screen.queryByText(value)).toBeNull();
});

it("handles browsers without the Clipboard API", async () => {
  const { events, negative } = mount();
  const clipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  try {
    await events.click(
      screen.getByRole("button", { name: "Copy Client secret" }),
    );
    await waitFor(() => {
      expect(negative).toHaveBeenCalledWith(
        "Could not copy. Reveal and select the value instead.",
      );
    });
  } finally {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
  }
});

it("does not repeat clipboard requests while a copy is pending", async () => {
  const { events, positive } = mount();
  let finish: (() => void) | undefined;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const button = screen.getByRole("button", { name: "Copy Client secret" });
  await events.click(button);
  await events.click(button);
  expect(write).toHaveBeenCalledOnce();
  if (!finish) throw new Error("Copy request did not start");
  finish();
  await waitFor(() => {
    expect(positive).toHaveBeenCalledOnce();
  });
});

it("supports revealing and hiding through keyboard activation", async () => {
  const { events } = mount();
  await events.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Reveal Client secret" }),
  );
  await events.keyboard("{Enter}");
  expect(screen.getByText(value)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide Client secret" })).toBe(
    document.activeElement,
  );
  await events.keyboard("{Enter}");
  expect(screen.queryByText(value)).toBeNull();
});
