import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server, stop, request, login, passphrase } from "./helpers.mjs";

test("account editing, role changes, self-deletion, and last-administrator protection", async () => {
  const data = await mkdtemp(join(tmpdir(), "companion-accounts-"));
  const port = 18784;
  let instance;
  try {
    instance = await server(port, data);
    assert.equal(
      (
        await request(port, "/api/setup", {
          setup: true,
          body: {
            name: "Admin",
            email: "admin@example.com",
            password: "a very secure password",
            backup_passphrase_confirmation: passphrase,
          },
        })
      ).status,
      200,
    );
    const cookie = await login(port);
    const actor = await (await request(port, "/api/me", { cookie })).json();
    const path = "/api/users/" + actor.id;
    assert.equal(
      (await request(port, path, { cookie, method: "DELETE" })).status,
      400,
    );
    assert.equal(
      (
        await request(port, path, {
          cookie,
          method: "PUT",
          body: { name: "Admin", email: actor.email, admin: false },
        })
      ).status,
      400,
    );
    const edited = await request(port, path, {
      cookie,
      method: "PUT",
      body: {
        name: "Updated Admin",
        email: " UPDATED@example.test ",
        admin: true,
      },
    });
    assert.equal(edited.status, 200);
    const profile = await edited.json();
    assert.equal(profile.name, "Updated Admin");
    assert.equal(profile.email, "updated@example.test");
    assert.equal(profile.created_at, actor.created_at);
    assert.equal(profile.password_hash, undefined);
    await login(port, profile.email);
    const member = await (
      await request(port, "/api/users", {
        cookie,
        body: {
          name: "Member",
          email: "member@example.test",
          password: "another secure password",
          admin: false,
        },
      })
    ).json();
    const memberCookie = await login(
      port,
      member.email,
      "another secure password",
    );
    assert.equal(
      (
        await request(port, path, {
          cookie: memberCookie,
          method: "PUT",
          body: { name: "No", email: profile.email, admin: false },
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(port, path, { cookie: memberCookie, method: "DELETE" }))
        .status,
      403,
    );
    assert.equal(
      (
        await request(port, path, {
          cookie,
          method: "PUT",
          body: { name: "Admin", email: member.email, admin: true },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(port, path, {
          cookie,
          method: "PUT",
          body: { name: "", email: "bad", admin: true },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(port, path, {
          cookie,
          origin: "https://evil.example",
          method: "PUT",
          body: { name: "No", email: profile.email, admin: true },
        })
      ).status,
      400,
    );
    const memberPath = "/api/users/" + member.id;
    assert.equal(
      (
        await request(port, memberPath, {
          cookie,
          method: "PUT",
          body: { name: member.name, email: member.email, admin: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(port, path, {
          cookie,
          method: "PUT",
          body: { name: profile.name, email: profile.email, admin: false },
        })
      ).status,
      200,
    );
    assert.equal((await request(port, "/api/users", { cookie })).status, 403);
    assert.equal(
      (
        await request(port, path, {
          cookie: memberCookie,
          method: "PUT",
          body: { name: profile.name, email: profile.email, admin: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(port, path, { cookie, method: "DELETE" })).status,
      200,
    );
    assert.equal((await request(port, "/api/me", { cookie })).status, 401);
    assert.equal(
      (
        await request(port, memberPath, {
          cookie: memberCookie,
          method: "DELETE",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(port, memberPath, {
          cookie: memberCookie,
          method: "PUT",
          body: { name: member.name, email: member.email, admin: false },
        })
      ).status,
      400,
    );
  } finally {
    if (instance) await stop(instance.child);
    await rm(data, { recursive: true, force: true });
  }
});
