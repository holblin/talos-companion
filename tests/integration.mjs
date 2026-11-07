import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  createPublicKey,
  verify,
  generateKeyPairSync,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { server, stop, request, login, s3, passphrase } from "./helpers.mjs";

test("authentication throttling uses socket peers rather than forwarded headers", { timeout: 30000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), "companion-auth-throttle-"));
  let child;
  try {
    ({ child } = await server(18450, data));
    for (let attempt = 0; attempt < 31; attempt++) {
      const response = await fetch("http://127.0.0.1:18450/api/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-requested-with": "talos-companion",
          "x-forwarded-for": `192.0.2.${attempt}`,
          forwarded: `for=192.0.2.${attempt}`,
        },
        body: "invalid JSON",
      });
      assert.equal(response.status, attempt < 30 ? 400 : 429);
      if (attempt === 30) assert.equal(response.headers.get("retry-after"), "900");
      await response.text();
    }
    // Throttling credentials must not prevent probes or expose protected APIs.
    assert.equal((await request(18450, "/healthz")).status, 200);
    assert.equal((await request(18450, "/api/settings", { body: {} })).status, 401);
    assert.equal((await request(18450, "/api/vault")).status, 401);
    assert.equal((await request(18450, "/api/omni/apply", { body: {} })).status, 401);
  } finally {
    if (child) await stop(child);
    await rm(data, { recursive: true, force: true });
  }
});

test(
  "accounts, OIDC, signed S3 multipart, encrypted export, restart, and credential override restore",
  { timeout: 300000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "talos-companion-"));
    const children = [];
    try {
      const a = 18380,
        b = 18390;
      const source = await server(a, join(dir, "source"));
      children.push(source.child);
      const account = {
        name: "Homelab Admin",
        email: "admin@example.com",
        password: "a very secure password",
        backup_passphrase_confirmation: passphrase,
      };
      assert.equal(
        (await request(a, "/api/setup", { body: account })).status,
        403,
      );
      assert.equal(
        (
          await request(a, "/api/setup", {
            body: account,
            setup: true,
            origin: "https://evil.example",
          })
        ).status,
        400,
      );
      assert.equal(
        (await request(a, "/api/setup/check", { body: {} })).status,
        403,
      );
      const deployment = await (
        await request(a, "/api/setup/check", { body: {}, setup: true })
      ).json();
      assert.equal(deployment.public_url, `http://127.0.0.1:${a}`);
      assert.equal(deployment.settings.retention.recovery_keep_last, 7);
      assert.equal(deployment.backup_passphrase, passphrase);
      assert.equal(
        (
          await request(a, "/api/setup", {
            setup: true,
            body: {
              ...account,
              backup_passphrase_confirmation: "wrong saved value",
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/setup", {
            setup: true,
            body: { ...account, backup_passphrase_confirmation: undefined },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/setup/recovery-key", {
            body: { recipients: "AGE-SECRET-KEY-do-not-upload" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(a, "/api/setup/recovery-key", {
            setup: true,
            body: { recipients: "AGE-SECRET-KEY-do-not-upload" },
          })
        ).status,
        400,
      );
      const generatedKey = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "der" })
        .subarray(-32);
      const keyType = Buffer.from("ssh-ed25519");
      const wireLength = (value) => {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(value);
        return bytes;
      };
      const publicRecipient = `ssh-ed25519 ${Buffer.concat([wireLength(keyType.length), keyType, wireLength(generatedKey.length), generatedKey]).toString("base64")}`;
      const protectedNote = await request(a, "/api/setup/recovery-key", {
        setup: true,
        body: { recipients: publicRecipient },
      });
      assert.equal(protectedNote.status, 200);
      const note = await protectedNote.json();
      assert.ok(
        note.encrypted_file.startsWith("-----BEGIN AGE ENCRYPTED FILE-----"),
      );
      assert.ok(!note.encrypted_file.includes(passphrase));
      assert.equal(
        (
          await request(a, "/api/setup/github-keys", {
            setup: true,
            body: { username: "https://evil.example/keys" },
          })
        ).status,
        400,
      );
      const initialSettings = {
        retention: { recovery_keep_last: 9, snapshot_keep_last: 12 },
        schedule: {
          enabled: false,
          interval_seconds: 3600,
          destination: "local",
        },
      };
      assert.equal(
        (
          await request(a, "/api/setup", {
            body: {
              ...account,
              settings: {
                ...initialSettings,
                schedule: { ...initialSettings.schedule, interval_seconds: 0 },
              },
            },
            setup: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/setup", {
            body: { ...account, settings: initialSettings },
            setup: true,
          })
        ).status,
        200,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(dir, "source", "config.json"), "utf8")),
        initialSettings,
      );
      assert.equal(
        (await request(a, "/api/setup", { body: account, setup: true })).status,
        400,
      );
      let cookie = await login(a);
      const integration = {
        profile: "lan",
        companion_url: "https://192.0.2.10:18443",
        omni_url: "https://192.0.2.10:19443",
        s3_endpoint: "https://192.0.2.10:19444",
      };
      assert.equal(
        (await request(a, "/api/omni/plan", { body: { integration } })).status,
        401,
      );
      const omniPlanResponse = await request(a, "/api/omni/plan", {
        cookie,
        body: {
          integration,
          primary_config:
            "account:\n  id: preserve-me\nauth:\n  auth0:\n    enabled: true\netcdBackup:\n  localPath: /keep/original\n",
        },
      });
      assert.equal(
        omniPlanResponse.status,
        200,
        await omniPlanResponse.clone().text(),
      );
      const omniPlan = await omniPlanResponse.json();
      assert.equal(omniPlan.callback, "https://192.0.2.10:19443/oidc/consume");
      assert.ok(omniPlan.changes.includes("auth.auth0.enabled"));
      assert.ok(omniPlan.changes.includes("etcdBackup.localPath"));
      assert.ok(!omniPlan.overlay.includes("preserve-me"));
      assert.equal(
        (
          await request(a, "/api/omni/plan", {
            cookie,
            body: {
              integration: {
                ...integration,
                companion_url: "http://insecure.test",
              },
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/omni/plan", {
            cookie,
            body: { integration, primary_config: "auth: {}\nauth: {}\n" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/omni/apply", {
            cookie,
            body: { integration, revision: "stale" },
          })
        ).status,
        400,
      );
      assert.equal(
        (await request(a, "/api/setup/check", { body: {}, setup: true }))
          .status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/setup/recovery-key", {
            setup: true,
            body: { recipients: publicRecipient },
          })
        ).status,
        400,
      );
      const initial = await (await request(a, "/api/me", { cookie })).json();
      assert.equal(
        (
          await request(a, "/api/users", {
            cookie,
            body: {
              name: "Member",
              email: "member@example.com",
              password: "member secure password",
              admin: false,
            },
          })
        ).status,
        200,
      );
      const memberCookie = await login(
        a,
        "member@example.com",
        "member secure password",
      );
      const shareCheck = "/api/backups/mounted/check";
      assert.equal((await request(a, shareCheck, { body: {} })).status, 401);
      assert.equal(
        (await request(a, shareCheck, { cookie: memberCookie, body: {} }))
          .status,
        403,
      );
      assert.equal(
        (
          await request(a, shareCheck, {
            cookie,
            body: {},
            origin: "https://evil.example",
          })
        ).status,
        400,
      );
      const checked = await request(a, shareCheck, { cookie, body: {} });
      assert.equal(checked.status, 200);
      const mountedDirectory = join(dir, "source", "mounted");
      assert.equal((await checked.json()).path, mountedDirectory);
      assert.deepEqual(await readdir(mountedDirectory), []);
      await rename(mountedDirectory, mountedDirectory + "-offline");
      try {
        const unavailable = await request(a, shareCheck, { cookie, body: {} });
        assert.equal(unavailable.status, 400);
        assert.match(
          (await unavailable.json()).error,
          /Cannot write to the share/,
        );
      } finally {
        await rename(mountedDirectory + "-offline", mountedDirectory);
      }
      assert.equal(
        (await request(a, "/api/backups", { cookie: memberCookie })).status,
        403,
      );
      assert.equal((await request(a, "/api/backups")).status, 401);
      assert.equal((await request(a, "/api/settings")).status, 401);
      assert.equal(
        (await request(a, "/api/settings", { cookie: memberCookie })).status,
        403,
      );
      const backupSettings = {
        retention: { recovery_keep_last: 2, snapshot_keep_last: 2 },
        schedule: {
          enabled: false,
          interval_seconds: 7200,
          destination: "mounted",
        },
      };
      assert.equal(
        (
          await request(a, "/api/settings", {
            cookie: memberCookie,
            body: backupSettings,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(a, "/api/settings", {
            cookie,
            body: backupSettings,
            origin: "https://evil.example",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/settings", {
            cookie,
            body: {
              ...backupSettings,
              schedule: { ...backupSettings.schedule, interval_seconds: 0 },
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(a, "/api/settings", {
            cookie,
            body: {
              ...backupSettings,
              schedule: {
                ...backupSettings.schedule,
                enabled: true,
                destination: "drive",
              },
            },
          })
        ).status,
        400,
      );
      assert.equal(
        (await request(a, "/api/settings", { cookie, body: backupSettings }))
          .status,
        200,
      );
      assert.deepEqual(
        await (await request(a, "/api/settings", { cookie })).json(),
        backupSettings,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(dir, "source", "config.json"), "utf8")),
        backupSettings,
      );
      const callback = "https://omni.example.com/oidc/consume";
      assert.equal(
        (
          await request(a, "/api/oidc", {
            cookie,
            body: { redirect_uri: callback },
          })
        ).status,
        200,
      );
      const settings = await (
        await request(a, "/api/overview", { cookie })
      ).json();
      const discovery = await (
        await request(a, "/.well-known/openid-configuration")
      ).json();
      assert.equal(discovery.issuer, `http://127.0.0.1:${a}`);
      const verifier = "x".repeat(64);
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const authQuery = new URLSearchParams({
        client_id: "omni",
        redirect_uri: callback,
        response_type: "code",
        scope: "openid email profile",
        state: "caller-state",
        nonce: "caller-nonce",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      assert.equal(
        (await request(a, `/oauth/authorize?${authQuery}`)).status,
        303,
      );
      const badQuery = new URLSearchParams(authQuery);
      badQuery.set("redirect_uri", `${callback}/evil`);
      assert.equal(
        (await request(a, `/oauth/authorize?${badQuery}`, { cookie })).status,
        400,
      );
      const auth = await request(a, `/oauth/authorize?${authQuery}`, {
        cookie,
      });
      assert.equal(auth.status, 303);
      const target = new URL(auth.headers.get("location"));
      assert.equal(target.searchParams.get("state"), "caller-state");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: target.searchParams.get("code"),
        client_id: "omni",
        client_secret: settings.client_secret,
        redirect_uri: callback,
        code_verifier: verifier,
      });
      const exchange = () =>
        fetch(`http://127.0.0.1:${a}/oauth/token`, {
          method: "POST",
          body: tokenForm,
        });
      const tokensResponse = await exchange();
      assert.equal(tokensResponse.status, 200);
      const tokens = await tokensResponse.json();
      assert.equal(
        (await exchange()).status,
        400,
        "authorization code must be single use",
      );
      const badPkce = await request(a, `/oauth/authorize?${authQuery}`, {
        cookie,
      });
      const badCode = new URL(badPkce.headers.get("location")).searchParams.get(
        "code",
      );
      const badForm = new URLSearchParams(tokenForm);
      badForm.set("code", badCode);
      badForm.set("code_verifier", "z".repeat(64));
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${a}/oauth/token`, {
            method: "POST",
            body: badForm,
          })
        ).status,
        400,
        "incorrect PKCE verifier must fail",
      );
      const jwks = await (await request(a, "/oauth/jwks")).json();
      const [header, payload, sig] = tokens.id_token.split(".");
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          createPublicKey({ key: jwks.keys[0], format: "jwk" }),
          Buffer.from(sig, "base64url"),
        ),
      );
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      assert.equal(claims.sub, initial.id);
      assert.equal(claims.nonce, "caller-nonce");
      const info = await fetch(`http://127.0.0.1:${a}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      assert.equal(info.status, 200);
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${a}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${tokens.id_token}` },
          })
        ).status,
        401,
      );
      for (let i = 0; i < 30; i++) {
        try {
          if ((await s3(a + 1, settings, "GET", "/omni?list-type=2")).ok) break;
        } catch {}
        await delay(100);
      }
      assert.equal(
        (await fetch(`http://127.0.0.1:${a + 1}/omni?list-type=2`)).status,
        403,
        "anonymous S3 access must be denied",
      );
      assert.equal(
        (
          await s3(
            a + 1,
            { ...settings, s3_secret_key: "invalid-secret" },
            "GET",
            "/omni?list-type=2",
          )
        ).status,
        403,
        "incorrect S3 signature must fail",
      );
      const snapshot = "test Omni encrypted etcd snapshot";
      const put = await s3(
        a + 1,
        settings,
        "PUT",
        "/omni/cluster/snapshot",
        snapshot,
      );
      assert.equal(put.status, 200, await put.text());
      assert.equal(
        await (
          await s3(a + 1, settings, "GET", "/omni/cluster/snapshot")
        ).text(),
        snapshot,
      );
      const initiate = await s3(
        a + 1,
        settings,
        "POST",
        "/omni/cluster/multipart?uploads=",
      );
      assert.equal(initiate.status, 200);
      const uploadId = (await initiate.text()).match(
        /<UploadId>([^<]+)<\/UploadId>/,
      )[1];
      const upload = await s3(
        a + 1,
        settings,
        "PUT",
        `/omni/cluster/multipart?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`,
        snapshot,
      );
      assert.equal(upload.status, 200);
      const etag = upload.headers.get("etag");
      const complete = await s3(
        a + 1,
        settings,
        "POST",
        `/omni/cluster/multipart?uploadId=${encodeURIComponent(uploadId)}`,
        `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
      );
      assert.equal(complete.status, 200, await complete.text());
      assert.equal(
        await (
          await s3(a + 1, settings, "GET", "/omni/cluster/multipart")
        ).text(),
        snapshot,
      );
      const vault = new FormData();
      vault.append(
        "file",
        new Blob(["test Omni encryption key material"]),
        "omni-key.txt",
      );
      assert.equal(
        (await request(a, "/api/vault", { cookie, body: vault })).status,
        200,
      );
      const retainedCluster = "22222222-2222-4222-8222-222222222222";
      const snapshotKey = (seconds) =>
        `/omni/${retainedCluster}/${(2n ** 64n - BigInt(seconds)).toString(16).toUpperCase()}.snapshot`;
      for (const seconds of [100, 200, 300]) {
        assert.equal(
          (
            await s3(
              a + 1,
              settings,
              "PUT",
              snapshotKey(seconds),
              `snapshot-${seconds}`,
            )
          ).status,
          200,
        );
      }
      const backup = await request(a, "/api/backups", {
        cookie,
        body: { destination: "local" },
      });
      assert.equal(backup.status, 200);
      const { name } = await backup.json();
      assert.equal(
        (await s3(a + 1, settings, "GET", snapshotKey(100))).status,
        404,
        "source retention must remove the oldest recognized Omni snapshot",
      );
      assert.equal(
        await (await s3(a + 1, settings, "GET", snapshotKey(300))).text(),
        "snapshot-300",
      );
      const exported = await request(a, `/api/backups/${name}`, { cookie });
      const bytes = Buffer.from(await exported.arrayBuffer());
      assert.ok(bytes.subarray(0, 9).equals(Buffer.from("TCBACKUP\x02")));
      assert.ok(!bytes.includes(Buffer.from(account.email)));
      const mounted = await (
        await request(a, "/api/backups", {
          cookie,
          body: { destination: "mounted" },
        })
      ).json();
      assert.equal(mounted.warning, null);
      assert.deepEqual(
        await readFile(join(dir, "source", "mounted", mounted.name)),
        await readFile(join(dir, "source", "backups", mounted.name)),
      );
      const unconnectedDrive = await (
        await request(a, "/api/backups", {
          cookie,
          body: { destination: "drive" },
        })
      ).json();
      assert.ok(
        unconnectedDrive.warning,
        "failed remote upload must be reported",
      );
      assert.ok(
        (await readFile(join(dir, "source", "backups", unconnectedDrive.name)))
          .length > 0,
        "failed remote upload must retain local recovery file",
      );
      assert.equal(
        (await (await request(a, "/api/backups", { cookie })).json()).length,
        2,
        "local recovery retention must keep the configured number",
      );
      assert.equal(
        (
          await request(a, "/api/restore", {
            setup: true,
            body: new FormData(),
          })
        ).status,
        400,
      );
      await stop(source.child);
      const restarted = await server(a, join(dir, "source"));
      children.push(restarted.child);
      const diskSettings = JSON.parse(
        await readFile(join(dir, "source", "config.json"), "utf8"),
      );
      assert.deepEqual(
        diskSettings,
        backupSettings,
        "configuration survives restart",
      );
      cookie = await login(a);
      assert.equal(
        (await (await request(a, "/api/me", { cookie })).json()).id,
        initial.id,
      );
      assert.equal(
        (await request(a, "/api/me", { cookie: memberCookie })).status,
        401,
        "sessions must not survive restart",
      );
      const dest = await server(b, join(dir, "destination"));
      children.push(dest.child);
      const restore = async (password) => {
        const form = new FormData();
        form.append("file", new Blob([bytes]), name);
        form.append("passphrase", password);
        form.append(
          "account",
          JSON.stringify({
            name: "Recovered Admin",
            email: "recovered@example.com",
            password: "new secure recovered password",
          }),
        );
        return request(b, "/api/restore", { setup: true, body: form });
      };
      assert.equal((await restore("wrong passphrase")).status, 400);
      const wrongConfirmation = new FormData();
      wrongConfirmation.append("file", new Blob([bytes]), name);
      wrongConfirmation.append("passphrase", passphrase);
      wrongConfirmation.append(
        "backup_passphrase_confirmation",
        "not-the-saved-passphrase",
      );
      assert.equal(
        (
          await request(b, "/api/restore", {
            setup: true,
            body: wrongConfirmation,
          })
        ).status,
        400,
      );
      assert.equal(
        (await (await request(b, "/api/status")).json()).initialized,
        false,
      );
      const truncated = new FormData();
      truncated.append(
        "file",
        new Blob([bytes.subarray(0, bytes.length - 16)]),
        name,
      );
      truncated.append("passphrase", passphrase);
      assert.equal(
        (await request(b, "/api/restore", { setup: true, body: truncated }))
          .status,
        400,
        "truncated final authentication tag must reject the entire restore",
      );
      assert.equal(
        (await (await request(b, "/api/status")).json()).initialized,
        false,
      );
      const oldFormat = new FormData();
      oldFormat.append(
        "file",
        new Blob([Buffer.from("TCBACKUP\x01obsolete")]),
        "old.tcb",
      );
      oldFormat.append("passphrase", passphrase);
      assert.equal(
        (await request(b, "/api/restore", { setup: true, body: oldFormat }))
          .status,
        400,
        "obsolete format is not supported",
      );
      const restored = await restore(passphrase);
      assert.equal(restored.status, 200, await restored.text());
      const recoveredCookie = await login(
        b,
        "recovered@example.com",
        "new secure recovered password",
      );
      assert.equal(
        await (
          await request(b, "/api/vault/omni-key.txt", {
            cookie: recoveredCookie,
          })
        ).text(),
        "test Omni encryption key material",
      );
      assert.equal(
        (
          await (
            await request(b, "/api/me", { cookie: recoveredCookie })
          ).json()
        ).id,
        initial.id,
        "override must preserve OIDC subject",
      );
      assert.equal(
        (await request(b, "/api/login", { body: account })).status,
        401,
      );
      assert.equal(
        (
          await (
            await request(b, "/api/users", { cookie: recoveredCookie })
          ).json()
        ).length,
        2,
      );
      const restoredSettings = await (
        await request(b, "/api/overview", { cookie: recoveredCookie })
      ).json();
      assert.equal(restoredSettings.client_secret, settings.client_secret);
      assert.equal(restoredSettings.s3_secret_key, settings.s3_secret_key);
      assert.deepEqual(
        restoredSettings.settings,
        backupSettings,
        "recovery restores saved backup configuration",
      );
      for (let i = 0; i < 30; i++) {
        try {
          if ((await s3(b + 1, settings, "GET", "/omni?list-type=2")).ok) break;
        } catch {}
        await delay(100);
      }
      assert.equal(
        await (
          await s3(b + 1, settings, "GET", "/omni/cluster/snapshot")
        ).text(),
        snapshot,
      );
      assert.equal(
        (await s3(b + 1, settings, "GET", snapshotKey(100))).status,
        404,
        "expired snapshots must not be included in the recovery archive",
      );
      assert.equal(
        await (await s3(b + 1, settings, "GET", snapshotKey(300))).text(),
        "snapshot-300",
      );
      assert.equal(
        await (
          await s3(b + 1, settings, "GET", "/omni/cluster/multipart")
        ).text(),
        snapshot,
      );
      assert.equal(
        (
          await request(b, "/api/password", {
            cookie: recoveredCookie,
            body: {
              current: "new secure recovered password",
              password: "another secure new password",
            },
          })
        ).status,
        200,
      );
      assert.equal(
        (await request(b, "/api/me", { cookie: recoveredCookie })).status,
        401,
      );
      await login(b, "recovered@example.com", "another secure new password");
      const original = await server(18410, join(dir, "unchanged"));
      children.push(original.child);
      const unchanged = new FormData();
      unchanged.append("file", new Blob([bytes]), name);
      unchanged.append("passphrase", passphrase);
      assert.equal(
        (await request(18410, "/api/restore", { setup: true, body: unchanged }))
          .status,
        200,
      );
      const originalCookie = await login(18410);
      assert.equal(
        (
          await (
            await request(18410, "/api/me", { cookie: originalCookie })
          ).json()
        ).id,
        initial.id,
        "restore without override must preserve original credentials",
      );
    } finally {
      await Promise.all(children.map(stop));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
