import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/storage/store.ts";
import { AdminAuth } from "../src/security/auth.ts";
import {
  startAdminControl,
  resetAdminPassword,
} from "../src/security/admin-control.ts";

test("local reset persists credentials, preserves config and revokes sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "admin-reset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir);
  await store.init();
  const auth = new AdminAuth(store);
  const session = await auth.setup("previous-password");
  await store.update((s) => {
    s.config.ai.apiKey = store.encrypt("private-key");
  });
  const before = store.snapshot().config;
  const control = await startAdminControl(auth, dir);
  t.after(() => new Promise((resolve) => control.close(resolve)));
  assert.equal(
    (await stat(join(dir, "admin-control.sock"))).mode & 0o777,
    0o600,
  );
  await assert.rejects(startAdminControl(auth, dir), /已有/);
  const password = await resetAdminPassword(dir);
  assert.equal(password.length, 32);
  const cli = await promisify(execFile)(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/reset-admin-password.ts", import.meta.url)),
    ],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const cliPassword = cli.stdout.match(/新密码：(\S+)/)?.[1];
  assert.ok(cliPassword);
  assert.ok(auth.login(cliPassword));
  assert.equal(auth.login("previous-password"), null);
  assert.equal(
    auth.isAuthenticated({ headers: { cookie: `speaker_session=${session}` } }),
    false,
  );
  assert.equal(auth.login(password), null);
  assert.deepEqual(store.snapshot().config, before);
  const reopened = new JsonStore(dir);
  await reopened.init();
  assert.ok(new AdminAuth(reopened).login(cliPassword));
  assert.equal(
    reopened.decrypt(reopened.snapshot().config.ai.apiKey),
    "private-key",
  );
});
