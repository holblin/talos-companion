import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, createPublicKey, verify } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const binary =
  process.env.TEST_BINARY ??
  join(
    root,
    "target",
    "debug",
    `talos-companion${process.platform === "win32" ? ".exe" : ""}`,
  );
const setupToken = "integration-setup-token-not-a-real-secret";
export const passphrase = "integration recovery passphrase";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
export async function server(port, data) {
  await mkdir(join(data, "mounted"), { recursive: true });
  let logs = "";
  const child = spawn(binary, {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: data,
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      LISTEN_ADDR: `127.0.0.1:${port}`,
      S3_LISTEN_ADDR: `127.0.0.1:${port + 1}`,
      SETUP_TOKEN: setupToken,
      BACKUP_PASSPHRASE: passphrase,
      BACKUP_INTERVAL_SECONDS: "86400",
      BACKUP_KEEP_LAST: "2",
      OMNI_SNAPSHOT_KEEP_LAST: "2",
      MOUNTED_BACKUP_DIR: join(data, "mounted"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)
        return { child, logs: () => logs };
    } catch {}
    await delay(100);
  }
  child.kill();
  throw new Error(`Server did not start: ${logs}`);
}
export async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exit;
}
export async function request(
  port,
  path,
  { body, cookie, method, setup, origin } = {},
) {
  const form = body instanceof FormData;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    redirect: "manual",
    headers: {
      "x-requested-with": "talos-companion",
      ...(body && !form ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(setup ? { "x-setup-token": setupToken } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
  });
  return res;
}
export async function login(
  port,
  email = "admin@example.com",
  password = "a very secure password",
) {
  const res = await request(port, "/api/login", { body: { email, password } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.get("set-cookie").split(";")[0];
}
export async function s3(port, settings, method, path, body = "") {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const scope = `${day}/us-east-1/s3/aws4_request`;
  const host = `127.0.0.1:${port}`;
  const url = new URL(`http://${host}${path}`);
  const query = [...url.searchParams]
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonical = `${method}\n${url.pathname}\n${query}\nhost:${host}\nx-amz-content-sha256:${sha(body)}\nx-amz-date:${date}\n\nhost;x-amz-content-sha256;x-amz-date\n${sha(body)}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`;
  const key = hmac(
    hmac(hmac(hmac(`AWS4${settings.s3_secret_key}`, day), "us-east-1"), "s3"),
    "aws4_request",
  );
  return fetch(url, {
    method,
    headers: {
      "x-amz-content-sha256": sha(body),
      "x-amz-date": date,
      authorization: `AWS4-HMAC-SHA256 Credential=${settings.s3_access_key}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${hmac(key, stringToSign).toString("hex")}`,
    },
    ...(method !== "GET" && method !== "HEAD" ? { body } : {}),
  });
}
