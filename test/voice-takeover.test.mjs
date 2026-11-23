import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tickIO } from "node:timers/promises";
import { UnderstandingAgent, splitCommands } from "../src/assistant/planner.ts";
import { IntentRouter } from "../src/assistant/router.ts";
import {
  normalizeModelIntent,
  OpenAICompatibleIntentClassifier,
} from "../src/assistant/llm.ts";
import {
  ExecutionAgent,
  estimatedSpeechMs,
} from "../src/assistant/execution.ts";
import { VoiceCoordinator } from "../src/assistant/coordinator.ts";
import { VoiceConversationMonitor } from "../src/assistant/voice-monitor.ts";
import { PlaybackService } from "../src/playback/service.ts";
import { JsonStore } from "../src/storage/store.ts";
import { MiotClient } from "../src/miot/client.ts";
import { createAppServer, executeAssistantIntent } from "../src/server.ts";
import { voiceMonitorSummary } from "../public/voice.js";

const device = (id) => ({
  deviceId: id,
  name: id,
  model: "L05C",
  hardware: "L05C",
  presence: "online",
});
const control = {
  action: "control",
  command: "pause",
  confidence: 0.99,
  source: "rules",
};
const song = (name) => ({
  action: "play_song",
  title: name,
  artist: "周杰伦",
  confidence: 0.99,
  source: "rules",
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "voice-takeover-"));
  const store = new JsonStore(dir);
  await store.init();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await store.update((s) => {
    s.config.devices = [device("a"), device("b")];
    s.config.selectedDeviceId = "a";
  });
  return { store, dir };
}

for (const text of [
  "打开空调，调到26度",
  "把客厅灯关掉",
  "执行回家场景",
  "明天七点叫醒我",
  "设置十分钟倒计时",
  "打开客厅未知设备",
]) {
  test("native command is silent and bypasses the model: " + text, async () => {
    const planner = new UnderstandingAgent(
      new IntentRouter({
        classify() {
          assert.fail("native commands must bypass model");
        },
      }),
    );
    const plan = await planner.plan(text);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].owner, "native");
    const executor = new ExecutionAgent(() =>
      assert.fail("native tools must never be reissued"),
    );
    assert.equal(
      (await executor.run(plan.tasks[0].intent, text, {})).native,
      true,
    );
  });
}

test("appliance knowledge is answered while quoted appliance song titles stay music", async () => {
  const router = new IntentRouter();
  assert.equal((await router.route("为什么空调不制冷")).action, "answer");
  assert.equal((await router.route("闹钟是什么")).action, "answer");
  assert.equal((await router.route("播放《打开空调》")).action, "play_song");
  assert.deepEqual(splitCommands("播放《后来，然后再见》，然后打开空调"), [
    "播放《后来，然后再见》",
    "打开空调",
  ]);
});

test("mixed commands retain native modifiers and split only platform work", async () => {
  const plan = await new UnderstandingAgent(new IntentRouter()).plan(
    "打开空调，调到26度，再播放周杰伦的晴天",
  );
  assert.deepEqual(
    plan.tasks.map((task) => [task.owner, task.intent.action]),
    [
      ["native", "native"],
      ["platform", "play_song"],
    ],
  );
  assert.equal(plan.tasks[0].text, "打开空调，调到26度");
  assert.equal(plan.tasks[1].intent.title, "晴天");
  assert.equal(
    (
      await new UnderstandingAgent(new IntentRouter()).plan(
        "如果下雨就播放晴天",
      )
    ).tasks[0].intent.action,
    "clarify",
  );
  assert.equal(
    (await new UnderstandingAgent(new IntentRouter()).plan("播放《如果》"))
      .tasks[0].intent.action,
    "play_song",
  );
});

function classifier(payload) {
  return new OpenAICompatibleIntentClassifier(
    { baseUrl: "https://model.example/v1", apiKey: "test", model: "test" },
    async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.match(request.messages[0].content, /只可省略/);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      });
    },
  );
}

test("model plans must quote all current instructions and cannot add, omit or reorder commands", async () => {
  const text = "把空调打开，顺便找些轻音乐";
  const model = classifier({
    tasks: [
      {
        text: "把空调打开",
        intent: { action: "answer", answer: "已打开", confidence: 1 },
      },
      {
        text: "找些轻音乐",
        intent: {
          action: "play_playlist",
          playlist: "轻音乐",
          confidence: 0.95,
        },
      },
    ],
  });
  const plan = await new UnderstandingAgent(new IntentRouter(model)).plan(text);
  assert.equal(plan.tasks[0].owner, "native");
  assert.equal(plan.tasks[1].intent.action, "play_playlist");
  for (const tasks of [
    [{ text: "找些轻音乐", intent: song("轻音乐") }],
    [
      { text: "把空调打开", intent: control },
      { text: "关闭门锁", intent: control },
    ],
    [
      { text: "找些轻音乐", intent: song("轻音乐") },
      { text: "把空调打开", intent: control },
    ],
    [{ text, intent: { action: "shell", command: "anything" } }],
  ]) {
    await assert.rejects(classifier({ tasks }).plan(text));
  }
  const low = await new UnderstandingAgent(
    new IntentRouter(
      classifier({
        tasks: [
          {
            text,
            intent: { action: "set_volume", volume: 100, confidence: 0.1 },
          },
        ],
      }),
    ),
  ).plan(text);
  // Native ownership is enforced for a whole appliance-shaped utterance too.
  assert.equal(low.tasks[0].owner, "native");
});

test("coordinator records native work without a device call and suppresses duplicate events", async (t) => {
  let calls = 0;
  const coordinator = new VoiceCoordinator(
    () => new UnderstandingAgent(new IntentRouter()),
    new ExecutionAgent(async () => {
      calls++;
      return {};
    }),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(device("a"), "打开空调", 100);
  coordinator.submit(device("a"), "打开空调", 100);
  await until(() => coordinator.snapshot()[0]?.status === "native");
  assert.equal(coordinator.snapshot().length, 1);
  assert.equal(calls, 0);
  assert.match(coordinator.snapshot()[0].message, /未确认/);
});

test("uncertain delivery is recorded once and never retried", async (t) => {
  let calls = 0;
  const coordinator = new VoiceCoordinator(
    () => new UnderstandingAgent(new IntentRouter()),
    new ExecutionAgent(async (_intent, _text, ctx) => {
      calls++;
      ctx.onStage("sending");
      throw new Error("timeout after submission");
    }),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(device("b"), "暂停", 100);
  await until(() => coordinator.snapshot()[0]?.status === "unconfirmed");
  coordinator.submit(device("b"), "暂停", 100);
  assert.equal(calls, 1);
  assert.match(coordinator.snapshot()[0].message, /不会自动重发/);
});

test("new speech cancels old understanding and histories remain isolated by device", async (t) => {
  const started = deferred();
  const sent = [];
  const histories = [];
  const coordinator = new VoiceCoordinator(
    () =>
      new UnderstandingAgent(
        new IntentRouter({
          async classify(text, history, signal) {
            histories.push({ text, history: [...history] });
            if (text === "旧的模糊指令") {
              started.resolve();
              await new Promise((_r, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                }),
              );
            }
            return {
              action: "answer",
              question: text,
              answer: "回答",
              confidence: 1,
              source: "llm",
            };
          },
        }),
      ),
    new ExecutionAgent(async (_intent, text, ctx) => {
      sent.push([ctx.deviceId, text]);
      return { message: "回答" };
    }),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(device("a"), "旧的模糊指令", 100);
  await started.promise;
  coordinator.submit(device("a"), "新的模糊指令", 200);
  coordinator.submit(device("b"), "另一个问题", 200);
  await until(
    () =>
      coordinator.snapshot().filter((event) => event.status === "completed")
        .length === 2,
  );
  assert.equal(
    coordinator.snapshot().find((event) => event.timestamp === 100).status,
    "cancelled",
  );
  assert.deepEqual(
    sent.sort(),
    [
      ["a", "新的模糊指令"],
      ["b", "另一个问题"],
    ].sort(),
  );
  assert.equal(
    histories.find((h) => h.text === "另一个问题").history.length,
    0,
  );
});

test("cancelling during audio resolution prevents the obsolete play command", async (t) => {
  const { store } = await setup(t);
  const started = deferred(),
    finish = deferred();
  const sent = [];
  const playback = new PlaybackService(
    store,
    { execute: async (...args) => sent.push(args) },
    async () => {
      started.resolve();
      return finish.promise;
    },
    "b",
  );
  const abort = new AbortController();
  const pending = playback.replaceAndPlay(
    "b",
    [
      {
        id: "x",
        sourceId: "s",
        title: "晴天",
        artist: "周杰伦",
        playUrl: "https://media.example/a.mp3",
      },
    ],
    0,
    { signal: abort.signal },
  );
  await started.promise;
  abort.abort();
  finish.resolve("https://media.example/a.mp3");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(sent.length, 0);
  assert.equal(store.snapshot().config.playbackHistory.length, 0);
});

test("speech uses the source speaker, persists separate encrypted queues, and selection restores them", async (t) => {
  const { store, dir } = await setup(t);
  await store.update((s) => {
    s.config.musicServices.mode = "legacy";
    s.config.musicSources = [
      {
        id: "test",
        name: "test",
        endpoint: "https://music.example/search",
        enabled: true,
        apiKey: "",
      },
    ];
  });
  const sent = [];
  const miot = {
    execute: async (id, command, args) => {
      sent.push([id, command, args]);
      return { success: true };
    },
  };
  const fetchImpl = async (url) => {
    const name = new URL(url).searchParams.get("title");
    return Response.json({
      tracks: [
        {
          id: name,
          title: name,
          artist: "周杰伦",
          playUrl: "https://media.example/" + encodeURIComponent(name) + ".mp3",
        },
      ],
    });
  };
  await executeAssistantIntent(
    song("晴天"),
    "播放晴天",
    store,
    miot,
    fetchImpl,
    { deviceId: "a" },
  );
  await executeAssistantIntent(
    song("稻香"),
    "播放稻香",
    store,
    miot,
    fetchImpl,
    { deviceId: "b" },
  );
  await executeAssistantIntent(control, "暂停", store, miot, fetchImpl, {
    deviceId: "b",
  });
  assert.deepEqual(
    sent.map(([id, command]) => [id, command]),
    [
      ["a", "play"],
      ["b", "play"],
      ["b", "pause"],
    ],
  );
  assert.equal(store.snapshot().config.selectedDeviceId, "a");
  assert.equal(store.snapshot().config.playbackQueue.tracks[0].title, "晴天");
  assert.equal(
    store.snapshot().config.devicePlaybackQueues.b.tracks[0].title,
    "稻香",
  );
  const disk = await readFile(join(dir, "state.json"), "utf8");
  assert.equal(disk.includes("https://media.example/"), false);
  const reloaded = new JsonStore(dir);
  await reloaded.init();
  const client = new MiotClient(reloaded, () =>
    assert.fail("selecting a device must be local"),
  );
  await client.selectDevice("b");
  assert.equal(
    reloaded.snapshot().config.playbackQueue.tracks[0].title,
    "稻香",
  );
  await client.selectDevice("a");
  assert.equal(
    reloaded.snapshot().config.playbackQueue.tracks[0].title,
    "晴天",
  );
});

test("all discovered speakers have independent cursors and a failed speaker does not block others", async (t) => {
  const { store } = await setup(t);
  await store.update((s) => {
    s.config.voiceMonitorEnabled = true;
    s.config.devices.push(device("broken"));
    s.config.xiaomi = {
      userId: "u",
      passToken: store.encrypt("p"),
      serviceToken: store.encrypt("s"),
      serviceTokenExpiresAt: Date.now() + 100000,
    };
  });
  const calls = new Map();
  const received = [];
  const monitor = new VoiceConversationMonitor(
    store,
    {
      async getLatestQuestions(id) {
        const count = (calls.get(id) ?? 0) + 1;
        calls.set(id, count);
        if (id === "broken") throw new Error("test failure");
        return {
          serverTime: 900,
          messages: [
            { timestamp: 100, text: "历史" },
            ...(count > 1 ? [{ timestamp: 200, text: "新语音" }] : []),
          ],
        };
      },
    },
    async (d, text, timestamp) => received.push([d.deviceId, text, timestamp]),
    250,
  );
  t.after(() => monitor.stop());
  monitor.sync();
  await until(() => received.length === 2);
  assert.deepEqual(received.sort(), [
    ["a", "新语音", 200],
    ["b", "新语音", 200],
  ]);
  await store.update((s) => {
    s.config.selectedDeviceId = "b";
  });
  monitor.sync();
  assert.equal(monitor.status.devices.length, 3);
  assert.equal(
    monitor.status.devices.find((d) => d.deviceId === "a").receivedCount,
    1,
  );
  assert.match(monitor.status.lastError, /broken/);
  assert.equal(
    voiceMonitorSummary(true, monitor.status.devices).includes(
      "2 台最近读取正常",
    ),
    true,
  );
});

test("authenticated diagnostics and preview expose ownership without executing device commands", async (t) => {
  const { dir } = await setup(t);
  const server = await createAppServer({
    dataDir: dir,
    fetchImpl: () =>
      assert.fail("preview must not contact devices or music sources"),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/voice/diagnostics")).status, 401);
  const auth = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ password: "test-only-password" }),
  });
  assert.equal(auth.status, 201);
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const preview = await fetch(base + "/api/voice/preview", {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({ text: "打开空调，再暂停" }),
  });
  assert.equal(preview.status, 200);
  const plan = await preview.json();
  assert.equal(plan.dryRun, true);
  assert.deepEqual(
    plan.tasks.map((task) => task.owner),
    ["native", "platform"],
  );
  const diagnostics = await (
    await fetch(base + "/api/voice/diagnostics", { headers: { cookie } })
  ).json();
  assert.equal(diagnostics.nativeVoiceInterception, false);
  assert.equal(diagnostics.enabled, false);
  assert.deepEqual(diagnostics.events, []);
});

test("cloud business rejection and malformed empty payload are not reported as healthy listening", async (t) => {
  const { store } = await setup(t);
  await store.update((s) => {
    s.config.xiaomi = {
      userId: "u",
      passToken: store.encrypt("p"),
      serviceToken: store.encrypt("s"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
  });
  for (const payload of [
    { code: 401, data: { records: [] } },
    { code: 0, data: null },
    { code: 0, data: "invalid" },
  ]) {
    const client = new MiotClient(store, async () => Response.json(payload));
    await assert.rejects(client.getLatestQuestions("a", "L05C"), /对话/);
  }
});

test("HTTP voice monitoring runs the real planner and executor for the source device only", async (t) => {
  const { store, dir } = await setup(t);
  await store.update((s) => {
    s.config.voiceMonitorEnabled = true;
    s.config.xiaomi = {
      userId: "u",
      passToken: store.encrypt("p"),
      serviceToken: store.encrypt("s"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
  });
  const counts = new Map(),
    sent = [];
  const server = await createAppServer({
    dataDir: dir,
    voiceIntervalMs: 250,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "userprofile.mina.mi.com") {
        const id = /deviceId=([^;]+)/.exec(init.headers.cookie)[1];
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        return Response.json({
          code: 0,
          data: {
            records:
              count === 1
                ? []
                : [{ time: 100, query: id === "a" ? "打开空调" : "暂停" }],
          },
        });
      }
      assert.equal(url.pathname, "/remote/ubus");
      const form = new URLSearchParams(init.body);
      sent.push({ deviceId: form.get("deviceId"), method: form.get("method") });
      return Response.json({ code: 0, data: { code: 0 } });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-only-password" }),
  });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  let diagnostics;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    diagnostics = await (
      await fetch(base + "/api/voice/diagnostics", { headers: { cookie } })
    ).json();
    if (
      diagnostics.events.some(
        (e) => e.deviceId === "a" && e.status === "native",
      ) &&
      diagnostics.events.some(
        (e) => e.deviceId === "b" && e.status === "accepted",
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(
    diagnostics.events.find((e) => e.deviceId === "a").status,
    "native",
  );
  assert.equal(
    diagnostics.events.find((e) => e.deviceId === "b").status,
    "accepted",
  );
  assert.deepEqual(sent, [{ deviceId: "b", method: "player_play_operation" }]);
  assert.equal(diagnostics.monitor.devices.length, 2);
  await fetch(base + "/api/voice/monitor", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
});

test("explicit device rejection is distinct from an uncertain delivery", async (t) => {
  const { DeviceCommandError } = await import("../src/miot/client.ts");
  const coordinator = new VoiceCoordinator(
    () => new UnderstandingAgent(new IntentRouter()),
    new ExecutionAgent(async (_intent, _text, ctx) => {
      ctx.onStage("sending");
      throw new DeviceCommandError("rejected", "rejected");
    }),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(device("a"), "暂停", 1);
  await until(() => coordinator.snapshot()[0]?.status === "failed");
  assert.match(coordinator.snapshot()[0].message, /明确拒绝/);
});

test("voice TTS asks for details, then a short reply uses the originating speaker's context", async (t) => {
  const { store, dir } = await setup(t);
  await store.update((s) => {
    s.config.voiceMonitorEnabled = true;
    s.config.ai = {
      baseUrl: "https://model.example/v1",
      model: "test",
      apiKey: store.encrypt("test"),
    };
    s.config.xiaomi = {
      userId: "u",
      passToken: store.encrypt("p"),
      serviceToken: store.encrypt("s"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
  });
  const records = { a: [], b: [] };
  const sent = [],
    requests = [];
  const question = "你想了解哪个天体？";
  const first = "给我介绍一下";
  const reply = "月球";
  const answer = "月球是地球的天然卫星。";
  const server = await createAppServer({
    dataDir: dir,
    voiceIntervalMs: 250,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "userprofile.mina.mi.com") {
        const id = /deviceId=([^;]+)/.exec(init.headers.cookie)[1];
        return Response.json({ code: 0, data: { records: records[id] } });
      }
      if (url.hostname === "model.example") {
        const messages = JSON.parse(init.body).messages;
        const text = messages.at(-1).content;
        const previousPrompt = messages
          .slice(1, -1)
          .some((m) => m.role === "assistant" && m.content === question);
        requests.push({ text, previousPrompt });
        const result =
          text === first
            ? { action: "clarify", question, confidence: 1 }
            : previousPrompt
              ? {
                  action: "answer",
                  question: "介绍月球",
                  answer,
                  confidence: 1,
                }
              : {
                  action: "answer",
                  question: text,
                  answer: "请告诉我你想了解什么。",
                  confidence: 1,
                };
        return Response.json({
          choices: [{ message: { content: JSON.stringify(result) } }],
        });
      }
      assert.equal(url.pathname, "/remote/ubus");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("method"), "text_to_speech");
      sent.push([form.get("deviceId"), JSON.parse(form.get("message")).text]);
      return Response.json({ code: 0, data: { code: 0 } });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-only-password" }),
  });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const diagnostics = async () =>
    (
      await fetch(base + "/api/voice/diagnostics", { headers: { cookie } })
    ).json();
  const waitFor = async (match) => {
    let latest;
    const deadline = Date.now() + 4000;
    do {
      latest = await diagnostics();
      if (match(latest)) return latest;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);
    assert.fail("voice diagnostics did not reach expected state");
  };
  await waitFor((d) => d.monitor.devices.every((device) => device.primed));
  records.a.push({ time: 100, query: first });
  const prompt = await waitFor((d) => d.events[0]?.status === "needs_input");
  assert.deepEqual(
    prompt.followUps.map((x) => x.deviceId),
    ["a"],
  );
  assert.ok(
    prompt.followUps[0].expiresAt - prompt.followUps[0].replyFrom === 60_000,
  );
  assert.deepEqual(sent, [["a", question]]);
  records.b.push({ time: 200, query: reply });
  await waitFor((d) =>
    d.events.some((e) => e.deviceId === "b" && e.status === "accepted"),
  );
  assert.equal(requests.at(-1).previousPrompt, false);
  assert.equal((await diagnostics()).followUps[0].deviceId, "a");
  records.a.push({ time: 300, query: reply });
  const completed = await waitFor((d) =>
    d.events.some((e) => e.timestamp === 300 && e.status === "accepted"),
  );
  assert.equal(requests.at(-1).previousPrompt, true);
  assert.deepEqual(sent.at(-1), ["a", answer]);
  assert.equal(completed.followUps.length, 0);
});

test("follow-up context expires and an unconfirmed TTS never opens a reply window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const histories = [];
  const coordinator = new VoiceCoordinator(
    () =>
      new UnderstandingAgent(
        new IntentRouter({
          async classify(text, history) {
            histories.push({ text, history });
            return {
              action: "clarify",
              question: "请补充一下。",
              source: "llm",
              confidence: 1,
            };
          },
        }),
      ),
    new ExecutionAgent(async (intent, text, context) => {
      context.onStage("sending");
      if (text === "播报失败")
        return { message: intent.question, speechError: "timeout" };
      context.onStage("accepted");
      return { message: intent.question, spokenPrompt: intent.question };
    }),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(device("a"), "先问一下", 100);
  await until(() => coordinator.isWaitingForReply("a"));
  const expiresAt = coordinator.waitingForReplies()[0].expiresAt;
  t.mock.timers.setTime(expiresAt + 1);
  assert.equal(coordinator.isWaitingForReply("a"), false);
  coordinator.submit(device("a"), "播报失败", 200);
  await until(() => coordinator.snapshot()[0]?.status === "unconfirmed");
  assert.deepEqual(histories.at(-1).history, []);
  assert.deepEqual(coordinator.waitingForReplies(), []);
});

test("voice clarification wakes the same speaker after each prompt and stops when answered", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const events = [];
  const wakeCalls = [];
  const seenHistory = [];
  const firstPrompt = "你想听哪位歌手？";
  const secondPrompt = "你想听哪一首歌？";
  const coordinator = new VoiceCoordinator(
    () =>
      new UnderstandingAgent(
        new IntentRouter({
          async classify(text, history) {
            seenHistory.push(history.map((turn) => turn.content));
            if (text === "晴天")
              return {
                action: "play_song",
                title: text,
                artist: "周杰伦",
                confidence: 1,
                source: "llm",
              };
            return {
              action: "clarify",
              question: text === "周杰伦" ? secondPrompt : firstPrompt,
              confidence: 1,
              source: "llm",
            };
          },
        }),
      ),
    new ExecutionAgent(async (intent, _text, context) => {
      context.onStage("sending");
      context.onStage("accepted");
      events.push(intent.action);
      return intent.action === "clarify"
        ? { message: intent.question, spokenPrompt: intent.question }
        : { message: "已播放晴天" };
    }),
    undefined,
    async (id) => {
      wakeCalls.push(id);
      return wakeCalls.length === 1 ? "accepted" : "unconfirmed";
    },
  );
  t.after(() => coordinator.stop());

  coordinator.submit(device("a"), "想听一首歌", 1);
  await tickIO();
  assert.equal(coordinator.waitingForReplies()[0].listenStatus, "pending");
  t.mock.timers.tick(estimatedSpeechMs(firstPrompt) - 1);
  await tickIO();
  assert.deepEqual(wakeCalls, []);
  t.mock.timers.tick(1);
  await tickIO();
  assert.deepEqual(wakeCalls, ["a"]);
  assert.equal(coordinator.waitingForReplies()[0].listenStatus, "accepted");
  assert.ok(
    coordinator
      .snapshot()[0]
      .stages.some(({ name }) => name === "reply_wake_accepted"),
  );

  coordinator.submit(device("a"), "周杰伦", 2);
  await tickIO();
  t.mock.timers.tick(estimatedSpeechMs(secondPrompt));
  await tickIO();
  assert.deepEqual(wakeCalls, ["a", "a"]);
  assert.equal(coordinator.waitingForReplies()[0].listenStatus, "unconfirmed");
  assert.ok(
    coordinator
      .snapshot()[0]
      .stages.some(({ name }) => name === "reply_manual_wake"),
  );

  coordinator.submit(device("a"), "晴天", 3);
  await tickIO();
  assert.deepEqual(seenHistory.at(-1), [
    "想听一首歌",
    firstPrompt,
    "周杰伦",
    secondPrompt,
  ]);
  assert.deepEqual(events, ["clarify", "clarify", "play_song"]);
  assert.deepEqual(coordinator.waitingForReplies(), []);
  t.mock.timers.tick(60_000);
  await tickIO();
  assert.deepEqual(wakeCalls, ["a", "a"]);
});

test("a reply during the prompt or removing its speaker cancels scheduled wake", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const wakeCalls = [];
  const coordinator = new VoiceCoordinator(
    () =>
      new UnderstandingAgent(
        new IntentRouter({
          async classify(text) {
            return text === "补充完了"
              ? {
                  action: "answer",
                  question: text,
                  answer: "收到",
                  confidence: 1,
                  source: "llm",
                }
              : {
                  action: "clarify",
                  question: "请补充一下",
                  confidence: 1,
                  source: "llm",
                };
          },
        }),
      ),
    new ExecutionAgent(async (intent, _text, context) => {
      context.onStage("accepted");
      return intent.action === "clarify"
        ? { message: intent.question, spokenPrompt: intent.question }
        : { message: intent.answer };
    }),
    undefined,
    async (id) => {
      wakeCalls.push(id);
      return "accepted";
    },
  );
  t.after(() => coordinator.stop());
  coordinator.submit(device("a"), "先问一下", 1);
  coordinator.submit(device("b"), "也问一下", 2);
  await tickIO();
  assert.equal(coordinator.waitingForReplies().length, 2);
  coordinator.submit(device("a"), "补充完了", 3);
  coordinator.retainDevices(new Set(["a"]));
  await tickIO();
  t.mock.timers.tick(8000);
  await tickIO();
  assert.deepEqual(wakeCalls, []);
  assert.deepEqual(coordinator.waitingForReplies(), []);
});

test("voice playback modes update shared state without restarting the queue", async (t) => {
  const { store } = await setup(t);
  await store.update((state) => {
    state.config.playbackQueue = {
      tracks: [
        {
          id: "song",
          sourceId: "fixture",
          artist: "测试歌手",
          title: "测试歌曲",
          playUrl: store.encrypt("https://media.example/song.mp3"),
        },
      ],
      currentIndex: 0,
    };
  });
  const oldQueue = store.snapshot().config.playbackQueue;
  const miot = {
    execute: async () => assert.fail("mode change sent a playback command"),
  };
  const router = new IntentRouter({
    async classify() {
      assert.fail("an explicit mode command reached the model");
    },
  });
  for (const [phrase, mode] of [
    ["小爱同学，切换到随机播放", "random"],
    ["把播放模式改成列表循环", "loop"],
    ["开启单曲循环", "single"],
    ["关闭单曲循环", "order"],
    ["按顺序播放", "order"],
  ]) {
    const intent = await router.route(phrase);
    assert.equal(intent.action, "set_playback_mode", phrase);
    const result = await executeAssistantIntent(
      intent,
      phrase,
      store,
      miot,
      fetch,
      {
        origin: "voice",
        deviceId: "a",
      },
    );
    assert.equal(result.playbackMode, mode);
    assert.equal(store.snapshot().config.playbackMode, mode);
    assert.deepEqual(store.snapshot().config.playbackQueue, oldQueue);
  }
  const llmMode = normalizeModelIntent(
    {
      action: "set_playback_mode",
      mode: "random",
      confidence: 0.95,
    },
    "这几首不用按原来的谁先谁后",
  );
  assert.equal(llmMode.mode, "random");
  assert.throws(
    () =>
      normalizeModelIntent(
        {
          action: "set_playback_mode",
          mode: "something",
        },
        "播放模式",
      ),
    /未知播放模式/,
  );
  assert.equal(
    (await new IntentRouter().route("播放《单曲循环》")).action,
    "play_song",
  );
  assert.equal(
    (await new IntentRouter().route("切换空调模式")).action,
    "native",
  );
});

test("a cancelled private-library request cannot poison the next request through the adapter cache", async (t) => {
  const { MusicServices } = await import("../src/music/library/service.ts");
  const { normalizeMusicServices } =
    await import("../src/music/library/config.ts");
  const { withExecutionSignal } = await import("../src/assistant/execution.ts");
  const { store } = await setup(t);
  await store.update((s) => {
    s.config.musicServices = normalizeMusicServices(
      {
        mode: "private",
        gatewayBaseUrl: "http://192.168.1.20:8787",
        libraries: [
          {
            id: "home",
            name: "home",
            type: "subsonic",
            baseUrl: "http://library.example",
            username: "test",
            password: "test",
            accessCode: "",
            enabled: true,
          },
        ],
      },
      s.config.musicServices,
      store,
    );
  });
  let calls = 0;
  const transport = async (_input, init) => {
    init.signal?.throwIfAborted();
    calls++;
    return Response.json({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        searchResult3: {
          song: [{ id: "one", title: "晴天", artist: "周杰伦" }],
        },
      },
    });
  };
  const abort = new AbortController();
  const first = await new MusicServices(
    store,
    withExecutionSignal(transport, abort.signal),
  ).search({ title: "晴天" });
  assert.equal(first.tracks.length, 1);
  abort.abort();
  const second = await new MusicServices(
    store,
    withExecutionSignal(transport, new AbortController().signal),
  ).search({ title: "晴天" });
  assert.equal(second.tracks.length, 1);
  assert.equal(calls, 2);
});

test("browser detach and reconnect share device queues while only completed voice music publishes a takeover", async (t) => {
  const { store, dir } = await setup(t);
  const song = {
    id: "sun",
    sourceId: "fixture",
    title: "晴天",
    artist: "周杰伦",
    playUrl: "https://media.example/one.mp3",
  };
  await store.update((state) => {
    state.config.voiceMonitorEnabled = true;
    state.config.musicServices.mode = "legacy";
    state.config.musicSources = [
      {
        id: "fixture",
        name: "fixture",
        endpoint: "https://music.example/search",
        enabled: true,
        apiKey: "",
      },
    ];
    state.config.xiaomi = {
      userId: "u",
      passToken: store.encrypt("p"),
      serviceToken: store.encrypt("s"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
    state.config.playbackQueue = {
      currentIndex: 0,
      tracks: [{ ...song, playUrl: store.encrypt(song.playUrl) }],
    };
  });
  const voiceTimestamp = Date.now();
  let spoken = false,
    rejected = false;
  const writes = [];
  const server = await createAppServer({
    dataDir: dir,
    voiceIntervalMs: 250,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.hostname === "music.example")
        return Response.json({ tracks: [song] });
      if (url.hostname === "userprofile.mina.mi.com")
        return Response.json({
          code: 0,
          data: {
            records:
              spoken && /deviceId=a(?:;|$)/.test(options.headers.cookie)
                ? [
                    {
                      time: voiceTimestamp,
                      query: "播放周杰伦的晴天",
                    },
                  ]
                : [],
          },
        });
      assert.equal(url.pathname, "/remote/ubus");
      const form = new URLSearchParams(options.body);
      const method = form.get("method"),
        id = form.get("deviceId");
      if (method === "player_get_play_status")
        return Response.json({
          code: 0,
          data: { info: JSON.stringify({ status: 2 }) },
        });
      writes.push([id, method, JSON.parse(form.get("message")).action]);
      return Response.json({ code: 0, data: { code: rejected ? 12 : 0 } });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-only-password" }),
  });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const call = (path, body) =>
    fetch(base + path, {
      headers: { cookie, "content-type": "application/json" },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
  const getState = async () => (await call("/api/playback/state")).json();
  const getDiagnostics = async () =>
    (await call("/api/voice/diagnostics")).json();
  const initial = await getState();
  assert.equal(initial.voicePlayback, undefined);
  const browserTrack = initial.playbackQueue.tracks[0];
  const media = await (
    await call("/api/lx/player/browser", { track: browserTrack })
  ).json();
  assert.equal(media.url, song.playUrl);
  assert.equal(media.track.playUrl, undefined);
  assert.deepEqual(writes, []);
  const detach = {
    deviceId: "a",
    revision: initial.playbackQueue.revision,
    voiceId: "",
  };
  assert.equal(
    (await call("/api/lx/player/detach", { ...detach, revision: "stale" }))
      .status,
    400,
  );
  assert.deepEqual(writes, []);
  assert.equal((await call("/api/lx/player/detach", detach)).status, 200);
  assert.deepEqual(writes[0], ["a", "player_play_operation", "stop"]);
  const cast = { deviceId: "b", tracks: [browserTrack], index: 0 };
  rejected = true;
  assert.equal((await call("/api/lx/player/play", cast)).status, 400);
  assert.equal((await getState()).device.deviceId, "a");
  rejected = false;
  assert.equal((await call("/api/lx/player/play", cast)).status, 200);
  assert.equal((await getState()).device.deviceId, "b");
  assert.equal((await getState()).voicePlayback, undefined);
  const waitUntil = async (read, predicate) => {
    for (let i = 0; i < 80; i++) {
      const data = await read();
      if (predicate(data)) return data;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail("speaker state timed out");
  };
  await waitUntil(getDiagnostics, (d) =>
    d.monitor.devices.every((x) => x.primed),
  );
  spoken = true;
  const afterVoice = await waitUntil(
    getState,
    (s) => s.voicePlayback?.deviceId === "a",
  );
  assert.equal(afterVoice.device.deviceId, "b");
  assert.ok(afterVoice.voicePlayback.id);
  assert.equal(writes.at(-1)[0], "a");
});
