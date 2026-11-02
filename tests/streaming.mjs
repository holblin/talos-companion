import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, stat, readFile } from "node:fs/promises";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { server, stop, request, login, passphrase } from "./helpers.mjs";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function peakRss(child) {
  if (process.platform !== "linux") return null;
  const status = await readFile(`/proc/${child.pid}/status`, "utf8");
  return Number(status.match(/^VmHWM:\s+(\d+) kB/m)[1]) * 1024;
}
test(
  "320 MiB snapshot streams through export, mounted copy, download and restore with bounded server memory",
  { timeout: 600000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "talos-streaming-"));
    const children = [];
    try {
      const source = await server(18500, join(dir, "source"));
      children.push(source.child);
      const account = {
        name: "Large backup admin",
        email: "admin@example.com",
        password: "a very secure password",
        backup_passphrase_confirmation: passphrase,
      };
      assert.equal(
        (await request(18500, "/api/setup", { setup: true, body: account }))
          .status,
        200,
      );
      const cookie = await login(18500);
      const cluster = "11111111-1111-4111-8111-111111111111";
      const dataDir = join(dir, "source", "receiver", "omni", cluster);
      await mkdir(dataDir, { recursive: true });
      const name = "FFFFFFFFFFFFFF9C.snapshot";
      const original = join(dataDir, name);
      const length = 320 * 1024 * 1024 + 17;
      const file = await open(original, "w");
      await file.truncate(length);
      // Mark beginning and end so a size-only or zero-filled restore cannot pass.
      await file.write(Buffer.from("snapshot beginning"), 0, 18, 0);
      await file.write(Buffer.from("snapshot ending"), 0, 15, length - 15);
      await file.close();
      const saved = await request(18500, "/api/backups", {
        cookie,
        body: { destination: "mounted" },
      });
      assert.equal(saved.status, 200, await saved.clone().text());
      const result = await saved.json();
      assert.equal(result.warning, null);
      const local = join(dir, "source", "backups", result.name);
      assert.ok(
        (await stat(local)).size > 256 * 1024 * 1024,
        "new recovery file must exceed the old size cap",
      );
      const downloaded = await request(18500, `/api/backups/${result.name}`, {
        cookie,
      });
      assert.equal(downloaded.status, 200);
      assert.equal(
        Number(downloaded.headers.get("content-length")),
        (await stat(local)).size,
      );
      const downloadedPath = join(dir, "download.tcb");
      await pipeline(
        Readable.fromWeb(downloaded.body),
        createWriteStream(downloadedPath),
      );
      const encryptedHash = await digest(local);
      assert.equal(await digest(downloadedPath), encryptedHash);
      assert.equal(
        await digest(join(dir, "source", "mounted", result.name)),
        encryptedHash,
      );
      const destination = await server(18510, join(dir, "destination"));
      children.push(destination.child);
      const upload = new FormData();
      upload.append("file", await openAsBlob(downloadedPath), result.name);
      upload.append("passphrase", passphrase);
      const restored = await request(18510, "/api/restore", {
        setup: true,
        body: upload,
      });
      assert.equal(restored.status, 200, await restored.text());
      await login(18510);
      const restoredPath = join(
        dir,
        "destination",
        "receiver",
        "omni",
        cluster,
        name,
      );
      assert.equal((await stat(restoredPath)).size, length);
      assert.equal(await digest(restoredPath), await digest(original));
      for (const instance of [source, destination]) {
        const peak = await peakRss(instance.child);
        if (peak !== null) {
          t.diagnostic(
            `Server peak RSS: ${(peak / 1024 / 1024).toFixed(1)} MiB for a 320 MiB snapshot`,
          );
          assert.ok(
            peak < 220 * 1024 * 1024,
            "server memory must stay below one full snapshot, including fixed KDF cost",
          );
        }
      }
    } finally {
      await Promise.all(children.map(stop));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
