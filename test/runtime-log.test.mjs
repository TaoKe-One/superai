import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
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
  const actionId = "fixture-click-1";
  const post = (endpoint, body, headers = {}) =>
    fetch(base + endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const events = [
    {
      page: "platform",
      type: "click",
      actionId,
      target: "button 发送",
      value: "private-field",
    },
    { page: "player", type: "dblclick", target: "tr 示例歌曲" },
    {
      page: "player",
      type: "error",
      message:
        "上游失败 https://music.example/private?token=hidden-url-token API key: hidden-api-value",
    },
  ];
  assert.equal((await post(path + "/ui", { events })).status, 401);
  assert.equal((await post(path + "/ui", { events }, { cookie })).status, 204);
  const command = await post(
    "/api/assistant/command",
    { text: "随机播放", history: [] },
    {
      cookie,
      "x-superai-ui-action": actionId,
    },
  );
  assert.equal(command.status, 200);
  assert.equal((await command.json()).playbackMode, "random");

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
  assert.match(text, /ERROR http\.error .*升级服务暂时不可用/);
  assert.match(text, /INFO ui\.click .*fixture-click-1.*button 发送/);
  assert.match(text, /INFO ui\.dblclick .*示例歌曲/);
  assert.match(text, /ERROR ui\.error .*上游失败/);
  assert.match(
    text,
    /INFO assistant\.turn .*fixture-click-1.*随机播放.*set_playback_mode.*已切换为随机播放/,
  );
  assert.match(text, /INFO playback\.mode_changed {"mode":"random"}/);
  for (const value of [
    password,
    cookie,
    "private-token",
    "private-key",
    "hidden-url-token",
    "hidden-api-value",
    "private-field",
  ])
    assert.ok(!text.includes(value));
});

test("the browser logs real actions and errors without capturing input or file values", async () => {
  const listeners = new Map();
  const requests = [];
  class Control {
    tagName = "INPUT";
    id = "password";
    value = "private-password";
    files = [{ name: "private-file" }];
    closest() {
      return this;
    }
    matches(selector) {
      return selector === "input,textarea";
    }
    getAttribute() {
      return null;
    }
  }
  const context = {
    location: { pathname: "/lx/" },
    Element: Control,
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      querySelector: () => ({ value: "online" }),
    },
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
    },
    fetch: async (path, options) => {
      requests.push({ path, ...options });
    },
    setTimeout,
    clearTimeout,
    AbortSignal,
  };
  vm.runInNewContext(
    await readFile(
      new URL("../public/interaction-log.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  const target = new Control();
  listeners.get("click")({ type: "click", target, isTrusted: false });
  listeners.get("click")({ type: "click", target, isTrusted: true });
  const id = context.SuperAILog.headers()["x-superai-ui-action"];
  listeners.get("change")({ type: "change", target, isTrusted: true });
  listeners.get("unhandledrejection")({ reason: Error("音频加载失败") });
  await context.SuperAILog.flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/system/logs/ui");
  const { events } = JSON.parse(requests[0].body);
  assert.deepEqual(
    events.map(({ type }) => type),
    ["click", "error"],
  );
  assert.equal(events[0].actionId, id);
  assert.equal(events[0].target, "input #password");
  assert.equal(events[1].message, "音频加载失败");
  assert.doesNotMatch(requests[0].body, /private-password|private-file/);
});
