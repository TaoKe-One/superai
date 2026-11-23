import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/storage/store.ts";
import { PlaybackService } from "../src/playback/service.ts";
import { LxMusicService } from "../src/music/lx/service.ts";
import { MusicServices } from "../src/music/library/service.ts";
import {
  executeAssistant,
  executeAssistantIntent,
  createAppServer,
} from "../src/server.ts";
import { LxCatalog } from "../src/music/lx/catalog.ts";
import { lxFixtureScript, catalogFixture } from "./helpers/lx-fixture.mjs";
import { HttpJsonMusicSource } from "../src/music/http-source.ts";
import { normalizeMusicServices } from "../src/music/library/config.ts";
import { VoiceCoordinator } from "../src/assistant/coordinator.ts";
import { UnderstandingAgent } from "../src/assistant/planner.ts";
import { IntentRouter } from "../src/assistant/router.ts";
import { ExecutionAgent } from "../src/assistant/execution.ts";
import { completePlaylist } from "../src/music/playlist-query.ts";

const raw = (id) => ({
  source: "wy",
  songmid: String(id),
  name: "晴天",
  singer: "周杰伦",
});
const direct = (id) => ({
  id: String(id),
  sourceId: "fixture",
  title: "晴天",
  artist: "周杰伦",
  playUrl: "https://media.example/" + id + ".mp3",
});

for (const expected of ["alternate", "rejected", "cancelled"]) {
  test(`voice playlist switches before delivery only (${expected})`, async (t) => {
    const { store } = await setup(t);
    const signal = new AbortController();
    const searches = [],
      stages = [],
      commands = [];
    const network = async (input) => {
      const url = new URL(input);
      if (url.hostname === "source.example")
        return Response.json({
          url: "https://media.example/" + url.searchParams.get("id") + ".mp3",
        });
      if (expected === "cancelled") signal.abort(Error("superseded"));
      const blocked = url.pathname === "/tx.mp3" && expected !== "rejected";
      return blocked
        ? new Response("<html>unavailable</html>")
        : new Response(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(180)]));
    };
    await new LxMusicService(store, network).importScript(lxFixtureScript);
    t.mock.method(LxCatalog.prototype, "search", async (platform, keyword) => {
      searches.push([platform, keyword]);
      return {
        list:
          platform === "tx"
            ? [{ id: "tx", name: "周杰伦热门精选", play_count: "2亿" }]
            : platform === "wy"
              ? [{ id: "wy", name: "周杰伦经典精选", play_count: "100万" }]
              : [],
      };
    });
    t.mock.method(LxCatalog.prototype, "request", async (platform) => ({
      list: [
        { ...raw(platform), name: platform === "tx" ? "告白气球" : "屋顶" },
      ],
      has_more: false,
    }));
    const miot = {
      execute: async (_id, command, args) => {
        commands.push([command, args.url]);
        if (command === "play" && expected === "rejected")
          throw Error("delivery failed");
      },
    };
    const playback = executeAssistantIntent(
      {
        action: "play_playlist",
        playlist: "周杰伦的一些热门",
        source: "rules",
        confidence: 0.96,
      },
      "播放周杰伦的一些热门歌单",
      store,
      miot,
      network,
      {
        origin: "voice",
        deviceId: "speaker",
        signal: signal.signal,
        onStage(stage) {
          stages.push(stage);
        },
      },
    );
    if (expected === "alternate") {
      const result = await playback;
      assert.equal(result.playbackQueue.tracks[0].title, "屋顶");
      assert.deepEqual(commands, [
        ["stop", undefined],
        ["play", "https://media.example/wy.mp3"],
      ]);
      assert.ok(
        stages.indexOf("retrying_playlist") < stages.indexOf("sending"),
      );
      assert.equal(searches.filter(([p]) => p === "tx").length, 1);
    } else {
      await assert.rejects(
        playback,
        expected === "rejected" ? /delivery failed/ : /superseded/,
      );
      assert.equal(stages.includes("retrying_playlist"), false);
      assert.deepEqual(
        commands.map(([c]) => c),
        expected === "rejected" ? ["stop", "play"] : ["stop"],
      );
      assert.equal(store.snapshot().config.playbackQueue.tracks.length, 0);
    }
  });
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "speaker-queue-playlist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir);
  await store.init();
  await store.update((s) => {
    s.config.selectedDeviceId = "speaker";
    s.config.devices = [
      {
        deviceId: "speaker",
        name: "test",
        hardware: "",
        model: "",
        presence: "online",
      },
    ];
  });
  return { store, dir };
}

test("large queues keep every track, play beyond 100, append and survive reload per device", async (t) => {
  const { store, dir } = await setup(t);
  const sent = [];
  const playback = new PlaybackService(store, {
    execute: async (...args) => sent.push(args),
  });
  const tracks = Array.from({ length: 620 }, (_, i) => direct(i));
  await playback.replaceAndPlay("speaker", tracks, 519);
  assert.equal(playback.queue().tracks.length, 620);
  assert.equal(playback.queue().currentIndex, 519);
  assert.equal(sent[0][2].url, tracks[519].playUrl);
  await playback.enqueue(
    Array.from({ length: 510 }, (_, i) => direct(620 + i)),
  );
  assert.equal(playback.queue().tracks.length, 1130);
  assert.equal(playback.queue().tracks.at(-1).id, "1129");
  const other = new PlaybackService(
    store,
    { execute: async () => {} },
    undefined,
    "other",
  );
  await other.replaceQueue(tracks);
  const restored = new JsonStore(dir);
  await restored.init();
  assert.equal(restored.snapshot().config.playbackQueue.tracks.length, 1130);
  assert.equal(
    restored.snapshot().config.devicePlaybackQueues.other.tracks.length,
    620,
  );
  assert.notEqual(
    restored.snapshot().config.playbackQueue.tracks[519].playUrl,
    tracks[519].playUrl,
  );
  const before = playback.queue();
  const failing = new PlaybackService(store, {
    execute: async () => {
      throw Error("speaker rejected");
    },
  });
  await assert.rejects(
    failing.replaceAndPlay("speaker", tracks, 619),
    /speaker rejected/,
  );
  assert.deepEqual(playback.queue(), before);
});

test("descriptive artist playlist chooses relevant popular collection and reads all pages", async (t) => {
  const { store } = await setup(t);
  const lx = new LxMusicService(store);
  await lx.importScript(lxFixtureScript);
  const searches = [],
    pages = [];
  lx.catalog.search = async (platform, keyword) => {
    searches.push(keyword);
    return {
      list: [
        { id: "wrong", name: "林俊杰热门精选", play_count: "9亿" },
        { id: "rare", name: "周杰伦精选冷门作品", play_count: "10" },
        { id: "hot", name: "周杰伦热门金曲精选", play_count: "200万" },
      ],
    };
  };
  lx.catalog.request = async (platform, group, method, args) => {
    assert.equal(args[0], "hot");
    const page = args[1] ?? 1;
    pages.push(page);
    return {
      list: Array.from({ length: page < 3 ? 150 : 20 }, (_, i) =>
        raw((page - 1) * 150 + i),
      ),
      has_more: page < 3,
      total: 320,
    };
  };
  const result = await lx.playlist("周杰伦的一些热门");
  assert.ok(searches.every((k) => k === "周杰伦"));
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.length, 320);
  assert.equal(result.at(-1).lx.songInfo.songmid, "319");
});

test("saved playlist exact names take priority and are not truncated", async (t) => {
  const { store } = await setup(t);
  const lx = new LxMusicService(store);
  await lx.savePlaylist(
    "周杰伦的一些热门",
    Array.from({ length: 350 }, (_, i) => direct(i)),
  );
  lx.catalog.search = async () => assert.fail("saved playlist must win");
  const tracks = await lx.playlist("周杰伦的一些热门");
  assert.equal(tracks.length, 350);
  const services = await new MusicServices(store).playlist("周杰伦的一些热门");
  assert.equal(services.tracks.length, 350);
});

test("playlist source failures and repeated pages are reported without partial playback", async (t) => {
  const { store } = await setup(t);
  const lx = new LxMusicService(store);
  await lx.importScript(lxFixtureScript);
  lx.catalog.search = async () => ({ list: [{ id: "loop", name: "通勤" }] });
  let calls = 0;
  lx.catalog.request = async () => {
    calls++;
    return { list: [raw(1)], has_more: true, total: 300 };
  };
  await assert.rejects(lx.playlist("通勤"), /重复|完整/);
  assert.ok(calls <= 10);
  const services = await new MusicServices(store, async () => {
    throw Error("catalog offline");
  }).playlist("通勤");
  assert.equal(services.tracks.length, 0);
  assert.ok(services.sourceErrors.length);
});

test("artist playlist utterance executes using an actual curated playlist", async (t) => {
  const { store } = await setup(t);
  const network = async (input) => {
    const url = new URL(input);
    if (url.hostname === "source.example")
      return Response.json({ url: "https://media.example/one.mp3" });
    if (url.hostname === "media.example")
      return new Response(
        Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200)]),
      );
    const data = catalogFixture(input);
    if (data.result?.playlists)
      data.result.playlists[0].name = "周杰伦热门精选";
    return Response.json(data);
  };
  await new LxMusicService(store, network).importScript(lxFixtureScript);
  const commands = [];
  const result = await executeAssistant(
    "播放周杰伦的一些热门歌单",
    store,
    { execute: async (id, command) => commands.push([id, command]) },
    network,
  );
  assert.equal(result.intent.action, "play_playlist");
  assert.notEqual(result.executionStatus, "no_match");
  assert.equal(result.playbackQueue.tracks.length, 2);
  assert.deepEqual(commands, [["speaker", "play"]]);
});

test("private playlists read every page through the library adapter", async (t) => {
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
            baseUrl: "https://library.example",
            username: "fixture",
            password: "fixture",
            accessCode: "",
            enabled: true,
          },
        ],
      },
      s.config.musicServices,
      store,
    );
  });
  // Use the adapter's actual Subsonic paging rather than replacing the service reader.
  const songs = Array.from({ length: 365 }, (_, i) => ({
    id: String(i),
    title: "歌" + i,
    artist: "周杰伦",
  }));
  const reader = new MusicServices(store, async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("getPlaylists"))
      return Response.json({
        "subsonic-response": {
          status: "ok",
          playlists: { playlist: [{ id: "list", name: "通勤" }] },
        },
      });
    assert.ok(url.pathname.endsWith("getPlaylist"));
    return Response.json({
      "subsonic-response": { status: "ok", playlist: { entry: songs } },
    });
  });
  const result = await reader.playlist("通勤");
  assert.equal(result.tracks.length, 365);
  assert.equal(result.tracks.at(-1).library.trackId, "364");
  assert.equal(result.sourceErrors.length, 0);
});

test("legacy HTTP playlists retain every returned song", async () => {
  const source = new HttpJsonMusicSource(
    {
      id: "legacy",
      endpoint: "https://music.example/search",
      playlistEndpoint: "https://music.example/lists",
      enabled: true,
    },
    async () =>
      Response.json({
        tracks: Array.from({ length: 420 }, (_, i) => direct(i)),
      }),
  );
  assert.equal((await source.searchPlaylist("通勤")).length, 420);
});

test("playlist cancellation never publishes a partial page or a successful voice event", async (t) => {
  const controller = new AbortController();
  await assert.rejects(
    completePlaylist(
      async () => {
        controller.abort(Error("superseded"));
        return { items: [direct(1)], hasMore: true };
      },
      (x) => x.id,
      controller.signal,
    ),
    /superseded/,
  );
  const coordinator = new VoiceCoordinator(
    () => new UnderstandingAgent(new IntentRouter()),
    new ExecutionAgent(async () => ({
      executionStatus: "failed",
      message: "歌单目录读取失败",
    })),
  );
  t.after(() => coordinator.stop());
  coordinator.submit(
    { deviceId: "speaker", name: "test" },
    "播放周杰伦的一些热门歌单",
    Date.now(),
  );
  for (let i = 0; i < 100; i++) {
    const event = coordinator.snapshot()[0];
    if (event?.status === "failed") {
      assert.equal(event.tasks[0].status, "failed");
      return;
    }
    await new Promise((r) => setImmediate(r));
  }
  assert.fail("source failure must not be reported as completed");
});

test("HTTP playback routes accept a large playlist and append beyond 100", async (t) => {
  const { store, dir } = await setup(t);
  await store.update((s) => {
    s.config.xiaomi = {
      userId: "fixture",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
  });
  const sent = [];
  const server = await createAppServer({
    dataDir: dir,
    fetchImpl: async (input, options) => {
      if (options?.body?.get("method") === "player_play_url")
        sent.push(JSON.parse(options.body.get("message")).url);
      return Response.json({ code: 0, data: { code: 0 } });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const adminResponse = await fetch(origin + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "large-queue-test-only" }),
  });
  const cookie = adminResponse.headers.get("set-cookie").split(";")[0];
  const call = async (path, body) => {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const tracks = Array.from({ length: 450 }, (_, i) => direct(i));
  const queue = async () =>
    (await fetch(origin + "/api/music/queue", { headers: { cookie } })).json();
  const result = await call("/api/lx/player/play", { tracks, index: 350 });
  assert.equal(result.success, true);
  assert.equal((await queue()).tracks.length, 450);
  assert.equal((await queue()).currentIndex, 350);
  assert.equal(sent[0], tracks[350].playUrl);
  const added = await call("/api/lx/player/queue", {
    operation: "append",
    tracks,
  });
  assert.equal(added.playbackQueue.tracks.length, 900);
  const privateResult = await call("/api/music/services/play", {
    tracks,
    index: 449,
  });
  assert.equal(privateResult.success, true);
  assert.equal((await queue()).tracks.length, 450);
  assert.equal((await queue()).currentIndex, 449);
  assert.equal(sent.at(-1), tracks[449].playUrl);
});
