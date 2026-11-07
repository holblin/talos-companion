import { afterEach, expect, it, vi } from "vitest";
import { waitForCompanion } from "../src/verifyCompanion";

const endpoints = {
  profile: "cloudflare" as const,
  companion_url: "https://companion2.example.test",
  omni_url: "",
  s3_endpoint: "",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("accepts verified Cloudflare access immediately and reports pending local DNS", async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, local_dns_pending: true })),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const onVerified = vi.fn();
  expect(
    await waitForCompanion(endpoints, new AbortController().signal, onVerified),
  ).toBe(true);
  expect(onVerified).toHaveBeenCalledWith({
    ok: true,
    local_dns_pending: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("waits out a five-minute cached DNS answer before saving a new hostname", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const fetch = vi.fn((path: string) => {
    expect(path).toBe("/api/companion/check");
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: "Could not verify this Companion over HTTPS" }),
        {
          status: Date.now() - started < 300_000 ? 400 : 200,
        },
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const result = waitForCompanion(endpoints, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await result).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(61);
});

it("explains a persistent failure after ten minutes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("DNS failed"))),
  );
  const result = expect(
    waitForCompanion(endpoints, new AbortController().signal),
  ).rejects.toThrow("after 10 minutes");
  await vi.advanceTimersByTimeAsync(600_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels the DNS wait without sending more checks", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => Promise.reject(new Error("DNS failed")));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const result = waitForCompanion(endpoints, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await result).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports an expired session without waiting for DNS", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Sign in again" }), {
          status: 401,
        }),
      ),
    ),
  );
  await expect(
    waitForCompanion(endpoints, new AbortController().signal),
  ).rejects.toThrow("Sign in again");
});
