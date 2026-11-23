import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.ts";
import { RuntimeLog } from "../src/storage/runtime-log.ts";

test("runtime log persists the latest 500 records in order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superai-runtime-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = new RuntimeLog(directory);
  await log.init();
  for (let index = 0; index < 502; index++) {
    log.record(
      index === 501 ? "ERROR" : "INFO",
      "test.event",
      `index=${index}`,
    );
  }
  await log.flush();
  const persisted = await readFile(join(directory, "runtime.log"), "utf8");
  const reopened = new RuntimeLog(directory);
  await reopened.init();
  assert.equal(reopened.download(), persisted);
  const lines = persisted.trimEnd().split("\n");
  assert.equal(lines.length, 500);
  assert.match(lines[0], / INFO test\.event index=2$/);
  assert.match(lines.at(-1), / ERROR test\.event index=501$/);
});

test("log export requires a session and includes activity without request data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superai-runtime-api-"));
  const server = await createAppServer({
    dataDir: directory,
    updateSocket: join(directory, "missing.sock"),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await server.flushLogs();
    await rm(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const path = "/api/system/logs";
  assert.equal((await fetch(base + path)).status, 401);
  const password = "log-fixture-password";
  const setup = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  await setup.text();
  assert.equal(
    (
      await fetch(base + "/api/system/update?token=private-token", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ version: "99.0.0", key: "private-key" }),
      })
    ).status,
    503,
  );
  const exported = await fetch(base + path, { headers: { cookie } });
  assert.equal(exported.status, 200);
  assert.match(
    exported.headers.get("content-disposition"),
    /attachment.*superai-runtime\.log/,
  );
  assert.equal(exported.headers.get("cache-control"), "no-store");
  const text = await exported.text();
  assert.match(
    text,
    /INFO http\.request method=POST route=\/api\/setup status=201/,
  );
  assert.match(
    text,
    /WARN http\.request method=GET route=\/api\/system\/logs status=401/,
  );
  assert.match(
    text,
    /ERROR http\.request method=POST route=\/api\/system\/update status=503/,
  );
  for (const value of [password, cookie, "private-token", "private-key"])
    assert.ok(!text.includes(value));
});
