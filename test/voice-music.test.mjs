import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/storage/store.ts";
import { IntentRouter } from "../src/assistant/router.ts";
import { UnderstandingAgent } from "../src/assistant/planner.ts";
import { ExecutionAgent } from "../src/assistant/execution.ts";
import { VoiceCoordinator } from "../src/assistant/coordinator.ts";
import { assistantSongQueue } from "../src/music/assistant-selection.ts";
import {
  createAppServer,
  executeAssistantIntent,
  executeAssistant,
} from "../src/server.ts";

const track = (id, title = "多余的解释", artist = "许嵩") => ({
  id,
  title,
  artist,
  playUrl: "https://media.example/" + id + ".mp3",
  sourceId: "fixture",
});
const song = {
  action: "play_song",
  title: "解释",
  artist: "多余",
  confidence: 0.96,
  source: "rules",
};
const testDirs = new WeakMap();
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "voice-music-"));
  const store = new JsonStore(dir);
  await store.init();
  testDirs.set(store, dir);
  await store.update((s) => {
    s.config.devices = [
      {
        deviceId: "speaker",
        name: "test",
        hardware: "L05C",
        model: "L05C",
        presence: "online",
      },
    ];
    s.config.selectedDeviceId = "speaker";
    s.config.musicServices.mode = "legacy";
    s.config.musicSources = [
      {
        id: "fixture",
        name: "fixture",
        endpoint: "https://music.example/search",
        enabled: true,
        apiKey: "",
      },
    ];
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return store;
}
async function done(coordinator) {
  for (let i = 0; i < 100; i++) {
    const event = coordinator.snapshot()[0];
    if (
      event &&
      !["queued", "understanding", "executing"].includes(event.status)
    )
      return event;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("voice job did not finish");
}

test("configured model interprets a natural artist request before legacy music rules", async (t) => {
  const store = await setup(t);
  await store.update((s) => {
    s.config.ai = {
      baseUrl: "https://model.example/v1",
      model: "fixture",
      apiKey: store.encrypt("fixture-key"),
    };
  });
  const requests = [],
    sent = [];
  const phrase = "我想听周董那些大家都能跟着唱的歌";
  const candidates = [
    track("one", "晴天", "周杰伦"),
    track("duplicate", "晴天", "周杰伦"),
    track("cover", "晴天", "其他歌手"),
    track("two", "稻香", "周杰伦"),
    track("three", "七里香", "周杰伦"),
  ];
  const result = await executeAssistant(
    phrase,
    store,
    {
      execute: async (_id, command, args) => sent.push([command, args.url]),
    },
    async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "model.example") {
        assert.equal(JSON.parse(init.body).messages.at(-1).content, phrase);
        requests.push("model");
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "play_artist",
                  artist: "周杰伦",
                  preference: "popular",
                  confidence: 0.98,
                }),
              },
            },
          ],
        });
      }
      requests.push(url.searchParams.get("title"));
      return Response.json({ tracks: candidates });
    },
  );
  assert.equal(result.intent.source, "llm");
  assert.equal(result.intent.preference, "popular");
  assert.deepEqual(requests, ["model", "周杰伦"]);
  assert.deepEqual(
    result.playbackQueue.tracks.map((t) => t.id),
    ["one", "two", "three"],
  );
  assert.deepEqual(sent, [["play", "https://media.example/one.mp3"]]);
});

test("the reported phrase falls back to artist playback if the configured model is unavailable", async () => {
  const phrase = "播放周杰伦的一些热门歌曲";
  let called = false;
  const router = new IntentRouter({
    async classify(text) {
      assert.equal(text, phrase);
      called = true;
      throw Error("model unavailable");
    },
  });
  const intent = await router.route(phrase);
  assert.ok(called);
  assert.equal(intent.action, "play_artist");
  assert.equal(intent.artist, "周杰伦");
  assert.equal(intent.source, "rules");
});

test("a title containing 的 is searched intact and exact versions form the queue", async (t) => {
  const store = await setup(t),
    requests = [],
    sent = [],
    stages = [];
  const result = await executeAssistantIntent(
    song,
    "我要听多余的解释",
    store,
    {
      execute: async (id, command, args) => {
        sent.push([id, command, args]);
      },
    },
    async (url) => {
      requests.push(new URL(url).searchParams.get("title"));
      return Response.json({
        tracks: [
          track("near", "多余解释", "焦小飞"),
          track("original"),
          track("cover", "多余的解释", "放任"),
          track("duplicate"),
          track("third", "多余的解释", "琉森"),
          track("fourth", "多余的解释", "其他"),
        ],
      });
    },
    {
      deviceId: "speaker",
      origin: "voice",
      onStage: (stage) => stages.push(stage),
    },
  );
  assert.deepEqual(requests, ["多余的解释"]);
  assert.deepEqual(
    sent.map((x) => x[1]),
    ["stop", "play"],
  );
  assert.equal(sent[1][2].url, "https://media.example/original.mp3");
  assert.deepEqual(
    result.playbackQueue.tracks.map((x) => x.id),
    ["original", "cover", "third"],
  );
  assert.equal(result.intent.title, "多余的解释");
  assert.equal(result.intent.artist, undefined);
  assert.ok(stages.indexOf("interrupted") < stages.indexOf("searching"));
  assert.ok(stages.indexOf("selected") < stages.indexOf("sending"));
  assert.equal(JSON.stringify(result).includes("https://media.example"), false);
});

test("artist plus a title containing 的 falls back to artist-aware search", async (t) => {
  const store = await setup(t),
    requests = [],
    sent = [];
  const intent = await new IntentRouter().route("播放许嵩的多余的解释");
  const result = await executeAssistantIntent(
    intent,
    "播放许嵩的多余的解释",
    store,
    { execute: async (id, command, args) => sent.push(command) },
    async (url) => {
      const query = new URL(url).searchParams;
      requests.push([query.get("title"), query.get("artist")]);
      return Response.json({
        tracks: [
          track("cover", "多余的解释", "放任"),
          track("original"),
          track("live", "多余的解释 (Live)"),
          track("same"),
          track("wrong", "别的歌"),
        ],
      });
    },
    { deviceId: "speaker" },
  );
  assert.deepEqual(requests, [
    ["许嵩的多余的解释", null],
    ["多余的解释", "许嵩"],
  ]);
  assert.deepEqual(
    result.playbackQueue.tracks.map((x) => x.id),
    ["original", "live"],
  );
  assert.deepEqual(sent, ["play"]);
});

test("ambiguous band spellings auto-select matching recordings without unrelated covers", () => {
  const queue = assistantSongQueue({ title: "茶底世界", artist: "丢火车" }, [
    track("one", "茶底世界", "丢火车乐队"),
    track("two", "茶底世界", "丢火车"),
    track("cover", "茶底世界", "翻唱者"),
    track("other", "不同的歌", "丢火车"),
  ]);
  assert.deepEqual(
    queue.map((x) => x.id),
    ["two"],
  );
  assert.deepEqual(
    assistantSongQueue({ title: "晴天", artist: "周杰伦" }, [
      track("wrong", "晴天", "翻唱者"),
    ]),
    [],
  );
});

test("quoted titles and the full wake phrase preserve title text", async () => {
  const intent = await new IntentRouter().route("小爱同学，播放《多余的解释》");
  assert.equal(intent.title, "多余的解释");
  assert.equal(intent.artist, undefined);
});

test("no match after stop is reported as no_match, not successful playback", async (t) => {
  const store = await setup(t),
    sent = [];
  const coordinator = new VoiceCoordinator(
    () => new UnderstandingAgent(new IntentRouter()),
    new ExecutionAgent((intent, text, context) =>
      executeAssistantIntent(
        intent,
        text,
        store,
        { execute: async (_id, command) => sent.push(command) },
        async () => Response.json({ tracks: [] }),
        context,
      ),
    ),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(
    { deviceId: "speaker", name: "test" },
    "我要听多余的解释",
    100,
  );
  const event = await done(coordinator);
  assert.equal(event.status, "no_match");
  assert.equal(event.tasks[0].status, "no_match");
  assert.deepEqual(sent, ["stop"]);
  assert.equal(
    event.stages.some((x) => x.name === "accepted"),
    false,
  );
  assert.equal(store.snapshot().config.playbackHistory.length, 0);
});

test("a failed interruption is not retried and does not block music selection", async (t) => {
  const store = await setup(t),
    sent = [],
    stages = [];
  await executeAssistantIntent(
    song,
    "我要听多余的解释",
    store,
    {
      execute: async (_id, command) => {
        sent.push(command);
        if (command === "stop") throw new Error("unknown stop receipt");
      },
    },
    async () => Response.json({ tracks: [track("original")] }),
    {
      origin: "voice",
      deviceId: "speaker",
      onStage: (stage) => stages.push(stage),
    },
  );
  assert.deepEqual(sent, ["stop", "play"]);
  assert.ok(stages.includes("interrupt_unconfirmed"));
});

test("cancellation while interrupting prevents subsequent search and casting", async (t) => {
  const store = await setup(t),
    controller = new AbortController(),
    sent = [];
  await assert.rejects(
    executeAssistantIntent(
      song,
      "我要听多余的解释",
      store,
      {
        execute: async (_id, command) => {
          sent.push(command);
          controller.abort();
        },
      },
      () => assert.fail("cancelled work searched"),
      { origin: "voice", deviceId: "speaker", signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(sent, ["stop"]);
});

test("native appliance commands never invoke music interruption or search", async (t) => {
  const store = await setup(t),
    intent = await new IntentRouter().route("打开空调");
  const result = await executeAssistantIntent(
    intent,
    "打开空调",
    store,
    { execute: () => assert.fail("native command interrupted") },
    () => assert.fail("native command searched"),
    { origin: "voice", deviceId: "speaker" },
  );
  assert.equal(result.native, true);
});

test("HTTP cloud speech stops native music once, queues ranked songs and casts the first", async (t) => {
  const store = await setup(t);
  await store.update((s) => {
    s.config.voiceMonitorEnabled = true;
    s.config.xiaomi = {
      userId: "fixture",
      passToken: store.encrypt("p"),
      serviceToken: store.encrypt("s"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
  });
  let polls = 0;
  const calls = [];
  const server = await createAppServer({
    dataDir: testDirs.get(store),
    voiceIntervalMs: 250,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "userprofile.mina.mi.com") {
        polls++;
        return Response.json({
          code: 0,
          data: {
            records:
              polls === 1 ? [] : [{ time: 100, query: "我要听多余的解释" }],
          },
        });
      }
      if (url.hostname === "music.example") {
        calls.push("search:" + url.searchParams.get("title"));
        return Response.json({
          tracks: [
            track("original"),
            track("cover", "多余的解释", "放任"),
            track("duplicate"),
          ],
        });
      }
      assert.equal(url.pathname, "/remote/ubus");
      const form = new URLSearchParams(init.body),
        method = form.get("method");
      if (method === "player_play_music") {
        const wire = JSON.parse(form.get("message"));
        calls.push(
          "play:" + JSON.parse(wire.music).payload.audio_items[0].stream.url,
        );
      } else {
        assert.equal(method, "player_play_operation");
        calls.push(JSON.parse(form.get("message")).action);
      }
      assert.equal(form.get("deviceId"), "speaker");
      return Response.json({ code: 0, data: { code: 0 } });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const setupResponse = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-only-password" }),
  });
  assert.equal(setupResponse.status, 201);
  const cookie = setupResponse.headers.get("set-cookie").split(";", 1)[0];
  let event;
  for (let i = 0; i < 100; i++) {
    const data = await (
      await fetch(base + "/api/voice/diagnostics", { headers: { cookie } })
    ).json();
    event = data.events[0];
    if (event?.status === "accepted") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(event?.status, "accepted");
  assert.deepEqual(calls, [
    "stop",
    "search:多余的解释",
    "play:https://media.example/original.mp3",
  ]);
  const queue = await (
    await fetch(base + "/api/music/queue", { headers: { cookie } })
  ).json();
  assert.deepEqual(
    queue.tracks.map((x) => x.id),
    ["original", "cover"],
  );
  // Repeat the cloud record in another real poll; no second stop or cast.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.filter((x) => x === "stop").length, 1);
  assert.equal(calls.filter((x) => x.startsWith("play:")).length, 1);
});
