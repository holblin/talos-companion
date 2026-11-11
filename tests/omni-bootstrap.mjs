import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server, stop, request, login, passphrase } from "./helpers.mjs";

const config = {
  omni_url: "https://omni.invalid:9443",
  companion_url: "https://companion.example.test",
  account_name: "my-omni",
  admin_email: "admin@example.com",
  wireguard_ip: "192.0.2.20",
  api_port: 8443,
  kubernetes_port: 8100,
  machine_port: 8090,
  wireguard_port: 50180,
  event_sink_port: 8091,
  log_server_port: 8092,
  metrics_port: 2122,
  tls_cert: "/config/tls/fullchain.pem",
  tls_key: "/config/tls/privkey.pem",
  private_key_file: "/config/omni.asc",
  etcd_path: "/data/etcd",
  sqlite_path: "/data/secondary-storage/sqlite.db",
};
test("offline Omni bootstrap preserves identity, authorizes downloads and reviews existing configs", async () => {
  const data = await mkdtemp(join(tmpdir(), "companion-omni-bootstrap-"));
  const port = 18790;
  let instance;
  const start = () => server(port, data, { PUBLIC_URL: config.companion_url });
  try {
    instance = await start();
    assert.equal(
      (
        await request(port, "/api/setup", {
          setup: true,
          body: {
            name: "Admin",
            email: config.admin_email,
            password: "a very secure password",
            backup_passphrase_confirmation: passphrase,
          },
        })
      ).status,
      200,
    );
    let cookie = await login(port);
    const settings = await (
      await request(port, "/api/overview", { cookie })
    ).json();
    assert.ok(settings.client_secret);
    for (const path of ["/api/omni/bootstrap", "/api/omni/bootstrap/config"]) {
      assert.equal((await request(port, path)).status, 401);
    }
    assert.equal(
      (await request(port, "/api/omni/bootstrap/config", { cookie })).status,
      400,
    );
    const generated = await request(port, "/api/omni/bootstrap", {
      cookie,
      body: config,
    });
    assert.equal(generated.status, 200, await generated.clone().text());
    const first = await generated.json();
    assert.match(
      first.account_id,
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
    assert.equal(first.connected_at, null);
    assert.equal(first.callback, config.omni_url + "/oidc/consume");
    assert.equal(first.client_secret, undefined);
    const download = async () => {
      const res = await request(port, "/api/omni/bootstrap/config", { cookie });
      assert.equal(res.status, 200, await res.clone().text());
      assert.match(res.headers.get("cache-control"), /no-store/);
      assert.match(res.headers.get("cache-control"), /private/);
      assert.match(
        res.headers.get("content-disposition"),
        /attachment; filename=omni.yaml/,
      );
      assert.match(res.headers.get("content-type"), /application\/yaml/);
      return res.text();
    };
    const yaml = await download();
    assert.equal(await download(), yaml);
    assert.ok(yaml.includes(settings.client_secret));
    assert.ok(yaml.includes(settings.client_id));
    assert.ok(yaml.includes(first.account_id));
    assert.ok(yaml.includes("/data/etcd"));
    assert.ok(yaml.includes("file:///config/omni.asc"));
    assert.doesNotMatch(yaml, /^eulaAccept:/m);
    assert.equal(
      (await (await request(port, "/api/overview", { cookie })).json())
        .redirect_uri,
      first.callback,
    );
    const edited = {
      ...config,
      account_name: "renamed Omni",
      omni_url: "https://omni-renamed.invalid",
    };
    const second = await (
      await request(port, "/api/omni/bootstrap", { cookie, body: edited })
    ).json();
    assert.equal(second.account_id, first.account_id);
    assert.ok((await download()).includes(settings.client_secret));
    for (const changed of [
      { companion_url: "https://wrong.test" },
      { etcd_path: "/config/etcd" },
      { api_port: 0 },
      { tls_key: "/config/../key" },
      { wireguard_ip: "127.0.0.1" },
    ]) {
      assert.equal(
        (
          await request(port, "/api/omni/bootstrap", {
            cookie,
            body: { ...edited, ...changed },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await request(port, "/api/omni/bootstrap", {
          cookie,
          origin: "https://evil.test",
          body: edited,
        })
      ).status,
      400,
    );
    await request(port, "/api/users", {
      cookie,
      body: {
        name: "Member",
        email: "member@example.test",
        password: "another secure password",
        admin: false,
      },
    });
    const member = await login(
      port,
      "member@example.test",
      "another secure password",
    );
    for (const path of ["/api/omni/bootstrap", "/api/omni/bootstrap/config"])
      assert.equal((await request(port, path, { cookie: member })).status, 403);
    for (const [path, body] of [
      ["/api/omni/bootstrap", edited],
      ["/api/omni/bootstrap/check", {}],
      [
        "/api/omni/existing/config",
        {
          integration: {
            profile: "lan",
            companion_url: config.companion_url,
            omni_url: config.omni_url,
            s3_endpoint: config.companion_url,
          },
          primary_config: "{}",
        },
      ],
    ])
      assert.equal(
        (await request(port, path, { cookie: member, body })).status,
        403,
      );
    // Restart proves the UUID and credentials survive process lifetime, not just component state.
    assert.ok(!instance.logs().includes(settings.client_secret));
    await stop(instance.child);
    instance = await start();
    cookie = await login(port);
    const persisted = await (
      await request(port, "/api/omni/bootstrap", { cookie })
    ).json();
    assert.equal(persisted.bootstrap.account_id, first.account_id);
    assert.ok((await download()).includes(settings.client_secret));
    const checked = await (
      await request(port, "/api/omni/bootstrap/check", { cookie, body: {} })
    ).json();
    assert.equal(checked.connected, false);
    assert.equal(checked.bootstrap.account_id, first.account_id);
    assert.ok(await download());
    // Existing installation updates touch only OIDC/auth modes and S3 mode.
    const original = {
      account: { id: "keep-permanent-uuid", name: "Existing" },
      storage: {
        default: {
          kind: "etcd",
          etcd: {
            privateKeySource: "vault://preserve",
            embeddedDBPath: "/existing/etcd",
          },
        },
        sqlite: { path: "/existing/sqlite.db" },
      },
      auth: { initialUsers: ["owner@example.test"] },
      custom: { untouched: "preserve" },
    };
    const integration = {
      profile: "lan",
      companion_url: config.companion_url,
      omni_url: "https://existing.invalid",
      s3_endpoint: "https://companion-s3.example.test",
    };
    const req = { integration, primary_config: JSON.stringify(original) };
    const preview = await request(port, "/api/omni/plan", {
      cookie,
      body: req,
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const plan = await preview.json();
    assert.equal(
      (
        await request(port, "/api/omni/existing/config", {
          cookie,
          body: { ...req, revision: "stale" },
        })
      ).status,
      400,
    );
    const reviewed = await request(port, "/api/omni/existing/config", {
      cookie,
      body: { ...req, revision: plan.revision },
    });
    assert.equal(reviewed.status, 200, await reviewed.clone().text());
    const updated = await reviewed.text();
    for (const preserved of [
      "keep-permanent-uuid",
      "vault://preserve",
      "/existing/etcd",
      "/existing/sqlite.db",
      "owner@example.test",
      "untouched: preserve",
    ])
      assert.ok(updated.includes(preserved), preserved);
    assert.ok(updated.includes(settings.client_secret));
    assert.match(reviewed.headers.get("cache-control"), /no-store.*private/);
    const after = await (
      await request(port, "/api/overview", { cookie })
    ).json();
    assert.equal(after.client_secret, settings.client_secret);
    assert.equal(after.redirect_uri, integration.omni_url + "/oidc/consume");
    // A different existing callback invalidates bootstrap downloads until explicitly regenerated.
    assert.equal(
      (await request(port, "/api/omni/bootstrap/config", { cookie })).status,
      400,
    );
    assert.ok(!instance.logs().includes(settings.client_secret));
  } finally {
    if (instance) await stop(instance.child);
    await rm(data, { recursive: true, force: true });
  }
});
