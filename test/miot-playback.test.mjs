import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "../src/storage/store.ts";
import { MiotClient } from "../src/miot/client.ts";
import { PlaybackService } from "../src/playback/service.ts";
import { LxMusicService } from "../src/music/lx/service.ts";
import { handleLxApi } from "../src/music/lx/api.ts";

async function setup(t, hardware, model = hardware) {
  const directory = await mkdtemp(join(tmpdir(), "speaker-music-protocol-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.init();
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "fixture",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
    state.config.selectedDeviceId = "speaker";
    state.config.devices = [
      {
        deviceId: "speaker",
        name: "test",
        hardware,
        model,
        presence: "online",
      },
    ];
  });
  return store;
}

function musicStream(options) {
  const form = new URLSearchParams(options.body);
  assert.equal(form.get("method"), "player_play_music");
  assert.equal(form.get("path"), "mediaplayer");
  const message = JSON.parse(form.get("message"));
  const music = JSON.parse(message.music);
  assert.equal(typeof message.music, "string");
  assert.equal(music.play_behavior, "REPLACE_ALL");
  const item = music.payload.audio_items[0];
  assert.equal(music.payload.audio_items.length, 1);
  assert.equal(message.startaudioid, item.item_id.audio_id);
  assert.ok(message.startaudioid);
  assert.equal(item.item_id.cp.name, "xiaowei");
  assert.deepEqual(music.payload.list_params, {
    listId: "-1",
    loadmore_offset: 0,
    origin: "xiaowei",
    type: "MUSIC",
  });
  return item.stream.url;
}

test("L05C and known Music API models send a nested REPLACE_ALL music payload", async (t) => {
  for (const hardware of [
    "L05C",
    "L05B",
    "LX06",
    "X08A",
    "X08C",
    "X08E",
    "X8S",
    "X8F",
    "X4B",
    "LX05",
    "OH11",
    "OH2",
    "OH2P",
    "X6A",
    "LX04",
    "L06A",
    "X10A",
    "L15A",
    "L16A",
    "L17A",
  ]) {
    const store = await setup(t, hardware);
    let calls = 0;
    const url =
      "https://media.example/song.mp3?key=a%2Bb&name=%E6%99%B4%E5%A4%A9";
    const client = new MiotClient(store, async (_input, options) => {
      calls++;
      assert.equal(musicStream(options), url, hardware);
      return Response.json({
        code: 0,
        data: { device_data: JSON.stringify({ code: 0 }) },
      });
    });
    assert.equal(
      (await client.execute("speaker", "play", { url })).success,
      true,
    );
    assert.equal(calls, 1);
  }
});

test("direct URL models clear the previous media and missing hardware uses the model", async (t) => {
  for (const [hardware, model, useMusic] of [
    ["unknown", "L05C", false],
    ["", "", false],
    ["", "l05c", true],
  ]) {
    const store = await setup(t, hardware, model);
    const url = "https://media.example/song.mp3";
    const calls = [];
    const client = new MiotClient(store, async (_input, options) => {
      const method = options.body.get("method");
      const message = JSON.parse(options.body.get("message"));
      calls.push(message.action ?? method);
      if (useMusic) assert.equal(musicStream(options), url);
      else if (method === "player_play_url") {
        assert.deepEqual(message, {
          url,
          type: 2,
          media: "app_ios",
        });
      }
      return Response.json({ code: 0, data: { code: 0 } });
    });
    await client.execute("speaker", "play", { url });
    assert.deepEqual(
      calls,
      useMusic ? ["player_play_music"] : ["pause", "stop", "player_play_url"],
    );
  }
});

test("a superseded direct playback sends no further commands after pre-pause", async (t) => {
  const store = await setup(t, "M01");
  let current = true;
  const calls = [];
  const client = new MiotClient(store, async (_input, options) => {
    calls.push(JSON.parse(options.body.get("message")).action);
    current = false;
    return Response.json({ code: 0 });
  });
  await assert.rejects(
    client.execute(
      "speaker",
      "play",
      { url: "https://media.example/song.mp3" },
      undefined,
      () => current,
    ),
    /播放已变更/,
  );
  assert.deepEqual(calls, ["pause"]);
});

test("M01 reads spoken requests from its device-specific NLP endpoint", async (t) => {
  const store = await setup(t, "M01");
  const client = new MiotClient(store, async (input, options) => {
    assert.equal(new URL(input).pathname, "/remote/ubus");
    assert.equal(options.body.get("deviceId"), "speaker");
    assert.equal(options.body.get("path"), "mibrain");
    assert.equal(options.body.get("method"), "nlp_result_get");
    return Response.json({
      code: 0,
      data: {
        code: 0,
        info: JSON.stringify({
          result: [
            {
              nlp: JSON.stringify({
                meta: { timestamp: "1700000000000" },
                response: {
                  answer: [{ intention: { query: "播放本地音乐" } }],
                },
              }),
            },
          ],
        }),
      },
    });
  });
  const { messages } = await client.getLatestQuestions("speaker", "m01");
  assert.deepEqual(messages, [
    { timestamp: 1700000000000, text: "播放本地音乐" },
  ]);
});

test("L05C rejection or uncertain delivery never retries another playback method", async (t) => {
  for (const response of [
    "timeout",
    { code: 0, data: { device_data: JSON.stringify({ code: 3012 }) } },
    { code: 0, data: { code: 12 } },
  ]) {
    const store = await setup(t, "L05C");
    const calls = [];
    const client = new MiotClient(store, async (_input, options) => {
      calls.push(options);
      if (response === "timeout") throw new Error("network timeout");
      return Response.json(response);
    });
    await assert.rejects(
      client.execute("speaker", "play", {
        url: "https://media.example/song.mp3",
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(musicStream(calls[0]), "https://media.example/song.mp3");
  }
});

test("TTS handles nested rejection and avoids repeating an uncertain delivery", async (t) => {
  for (const code of [12, 3012]) {
    const store = await setup(t, "L05C");
    const methods = [];
    const client = new MiotClient(store, async (_input, options) => {
      methods.push(options.body.get("method"));
      return Response.json({
        code: 0,
        data:
          methods.length === 1
            ? { code: 0, device_data: JSON.stringify({ code }) }
            : { code: 0 },
      });
    });
    const speak = client.execute("speaker", "tts", { text: "问答播报测试" });
    if (code === 3012) {
      await assert.rejects(speak, { delivery: "unconfirmed" });
      assert.deepEqual(methods, ["text_to_speech"]);
    } else {
      assert.equal((await speak).success, true);
      assert.deepEqual(methods, ["text_to_speech", "player_play_tts"]);
    }
  }
});

test("L05C uses the discovered MIoT target and does not resend after a cloud speech timeout", async (t) => {
  const store = await setup(t, "L05C");
  const calls = [];
  const deviceList = Promise.withResolvers();
  const ticketStarted = Promise.withResolvers();
  const client = new MiotClient(
    store,
    async (input, options) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === "/admin/v2/device_list") {
        await deviceList.promise;
        return Response.json({
          code: 0,
          data: [
            { deviceID: "other", miotDID: "11" },
            { deviceID: "speaker", miotDID: "22" },
          ],
        });
      }
      if (url.pathname === "/pass/serviceLogin") {
        assert.equal(url.searchParams.get("sid"), "xiaomiio");
        ticketStarted.resolve();
        return Response.json({
          code: 0,
          userId: "fixture",
          ssecurity: "c2VjdXJpdHk=",
          nonce: "6",
          location: "https://account.xiaomi.com/sts",
        });
      }
      if (url.pathname === "/sts")
        return new Response("", {
          headers: { "set-cookie": "serviceToken=fixture-service; Path=/" },
        });
      assert.equal(url.pathname, "/app/miotspec/action");
      assert.equal(options.redirect, "error");
      assert.ok(options.body.get("signature"));
      assert.ok(!options.body.get("data").includes("问答播报测试"));
      throw Error("timeout");
    },
    undefined,
    true,
  );
  const warming = [client.warmSpeech("speaker"), client.warmSpeech("speaker")];
  // A pending device list must not hold up the separate xiaomiio login.
  let timeout;
  try {
    await Promise.race([
      ticketStarted.promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("MIoT login did not start")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    deviceList.resolve();
  }
  await Promise.all(warming);
  assert.deepEqual(calls, [
    "/admin/v2/device_list",
    "/pass/serviceLogin",
    "/sts",
  ]);
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      client.execute("speaker", "tts", { text: "问答播报测试" }),
      { delivery: "unconfirmed" },
    );
  assert.deepEqual(calls, [
    "/admin/v2/device_list",
    "/pass/serviceLogin",
    "/sts",
    "/app/miotspec/action",
    "/app/miotspec/action",
  ]);
});

function cloudSpeechFixture(input, form) {
  const key = createHash("sha256")
    .update(Buffer.from("security"))
    .update(Buffer.from(form.get("_nonce"), "base64"))
    .digest();
  const permutation = Array.from({ length: 256 }, (_, n) => n);
  let j = 0;
  const swap = (i, j) => {
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  };
  permutation.forEach((value, i) => {
    j = (j + value + key[i % key.length]) % 256;
    swap(i, j);
  });
  j = 0;
  const result = Buffer.alloc(input.length);
  for (let n = 0; n < 1024 + input.length; n++) {
    const i = (n + 1) % 256;
    j = (j + permutation[i]) % 256;
    swap(i, j);
    if (n >= 1024)
      result[n - 1024] =
        input[n - 1024] ^ permutation[(permutation[i] + permutation[j]) % 256];
  }
  return result;
}

test("model-specific MIoT actions target the correct DID and retry only rejected speech", async (t) => {
  for (const [hardware, model, action, reply, expected] of [
    ["L05C", "", [5, 3], { code: 0 }, "miot"],
    ["lx06", "", [5, 1], { code: 0 }, "miot"],
    ["", "L16A", [7, 3], { code: 0 }, "miot"],
    ["X08C", "", [3, 1], { code: 0 }, "miot"],
    ["ASX4B", "", [5, 3], { code: -1 }, "mibrain"],
    ["OH2P", "", [7, 3], { code: 3012 }, "unconfirmed"],
    ["L05B", "", [5, 3], {}, "unconfirmed"],
    ["S12", "", [5, 1], null, "mibrain"], // Device ID unavailable.
    ["constructor", "", null, null, "mibrain"],
  ]) {
    const store = await setup(t, hardware, model);
    const calls = [];
    const text = "请用同一台音箱回复";
    const client = new MiotClient(
      store,
      async (input, options) => {
        const url = new URL(input);
        calls.push(url.pathname);
        switch (url.pathname) {
          case "/admin/v2/device_list":
            return Response.json({
              code: 0,
              data: [
                { deviceID: "other", miotDID: "111" },
                { deviceID: "speaker", miotDID: reply ? "222" : null },
              ],
            });
          case "/pass/serviceLogin":
            return Response.json({
              code: 0,
              userId: "fixture",
              ssecurity: "c2VjdXJpdHk=",
              nonce: "6",
              location: "https://account.xiaomi.com/sts",
            });
          case "/sts":
            return new Response("", {
              headers: { "set-cookie": "serviceToken=fixture-service; Path=/" },
            });
          case "/app/miotspec/action": {
            const data = cloudSpeechFixture(
              Buffer.from(options.body.get("data"), "base64"),
              options.body,
            );
            assert.deepEqual(JSON.parse(data.toString()).params, {
              did: "222",
              siid: action[0],
              aiid: action[1],
              in: [text],
            });
            return new Response(
              cloudSpeechFixture(
                Buffer.from(JSON.stringify({ code: 0, result: reply })),
                options.body,
              ).toString("base64"),
            );
          }
          case "/remote/ubus":
            assert.equal(options.body.get("deviceId"), "speaker");
            assert.equal(options.body.get("path"), "mibrain");
            assert.equal(options.body.get("method"), "text_to_speech");
            return Response.json({ code: 0 });
          default:
            assert.fail(url.pathname);
        }
      },
      undefined,
      true,
    );
    const speaking = client.execute("speaker", "tts", { text });
    if (expected === "unconfirmed")
      await assert.rejects(speaking, { delivery: "unconfirmed" });
    else {
      const result = await speaking;
      assert.equal(result.success, true, hardware);
      assert.equal(result.transport, expected === "miot" ? "miot" : undefined);
    }
    assert.equal(
      calls.filter((path) => path === "/pass/serviceLogin").length,
      action ? 1 : 0,
      hardware,
    );
    assert.equal(
      calls.filter((path) => path === "/app/miotspec/action").length,
      reply ? 1 : 0,
      hardware,
    );
    assert.equal(
      calls.filter((path) => path === "/remote/ubus").length,
      expected === "mibrain" ? 1 : 0,
      hardware,
    );
  }
});

test("LX player resolves fresh URLs into L05C music requests and preserves queue on rejection", async (t) => {
  const store = await setup(t, "L05C");
  const lx = new LxMusicService(store);
  await lx.importScript(
    'lx.send("inited",{sources:{wy:{actions:["musicUrl"],qualitys:["320k"]}}});lx.on("request",async ({info})=>"https://media.example/"+info.musicInfo.songmid+".mp3");',
  );
  let reject = false;
  const urls = [];
  const client = new MiotClient(store, async (_input, options) => {
    urls.push(musicStream(options));
    return Response.json({ code: 0, data: { code: reject ? 12 : 0 } });
  });
  const playback = new PlaybackService(store, client, (track) =>
    lx.resolveTrack(track),
  );
  const play = (id) =>
    handleLxApi(
      "POST",
      "/player/play",
      new URL("http://localhost/api/lx/player/play"),
      { tracks: [{ source: "wy", songmid: id, name: id, singer: "artist" }] },
      lx,
      store,
      playback,
    );
  await play("first");
  const before = store.snapshot().config;
  reject = true;
  await assert.rejects(play("second"));
  const after = store.snapshot().config;
  assert.deepEqual(after.playbackQueue, before.playbackQueue);
  assert.deepEqual(after.playbackHistory, before.playbackHistory);
  assert.deepEqual(urls, [
    "https://media.example/first.mp3",
    "https://media.example/second.mp3",
  ]);
  assert.equal(
    JSON.stringify(after.playbackQueue).includes("media.example"),
    false,
  );
});
