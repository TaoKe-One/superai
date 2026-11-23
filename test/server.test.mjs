import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppServer,
  executeAssistant,
  handleAssistantRoute,
} from "../src/server.ts";
import { IntentRouter } from "../src/assistant/router.ts";
import { JsonStore } from "../src/storage/store.ts";

test("HTTP route validates input and returns the assistant decision", async () => {
  const router = new IntentRouter();
  const result = await handleAssistantRoute(
    "POST",
    { text: "我想听周杰伦的晴天" },
    router,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.action, "play_song");

  const invalid = await handleAssistantRoute("POST", { text: " " }, router);
  assert.equal(invalid.status, 400);

  const wrongMethod = await handleAssistantRoute("GET", {}, router);
  assert.equal(wrongMethod.status, 405);
});

test("assistant searches a playlist and persists an encrypted queue", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-assistant-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "music.example");
    return new Response(
      JSON.stringify({
        playlists: [
          {
            name: "通勤",
            tracks: [
              {
                id: "one",
                title: "晴天",
                artist: "周杰伦",
                playUrl: "https://media.example/one.mp3",
              },
              {
                id: "two",
                title: "稻香",
                artist: "周杰伦",
                playUrl: "https://media.example/two.mp3",
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  await store.update((state) => {
    state.config.musicServices.mode = "legacy";
    state.config.musicSources = [
      {
        id: "test",
        name: "test",
        endpoint: "https://music.example/search",
        playlistEndpoint: "https://music.example/playlists",
        enabled: true,
        apiKey: "",
      },
    ];
    state.config.devices = [
      {
        deviceId: "speaker-1",
        name: "客厅",
        model: "",
        hardware: "",
        presence: "online",
      },
    ];
    state.config.selectedDeviceId = "speaker-1";
  });
  const played = [];
  const miot = {
    execute: async (_deviceId, command, args) => {
      played.push({ command, url: args.url });
      return { success: true };
    },
  };
  const assistant = await executeAssistant(
    "播放通勤歌单",
    store,
    miot,
    fetchImpl,
  );
  assert.equal(assistant.intent.action, "play_playlist");
  assert.equal(assistant.playbackQueue.tracks.length, 2);
  assert.equal(
    JSON.stringify(assistant.playbackQueue).includes("media.example"),
    false,
  );
  assert.equal(played[0].url, "https://media.example/one.mp3");
  const next = await executeAssistant("下一首", store, miot, fetchImpl);
  assert.equal(next.playbackQueue.currentIndex, 1);
  assert.equal(played[1].url, "https://media.example/two.mp3");
  const persisted = await readFile(join(dataDir, "state.json"), "utf8");
  assert.equal(persisted.includes("media.example"), false);
});

test("artist request queues only tracks credited to the requested artist", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-artist-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.musicServices.mode = "legacy";
    state.config.musicSources = [
      {
        id: "test",
        name: "test",
        endpoint: "https://music.example/search",
        enabled: true,
        apiKey: "",
      },
    ];
    state.config.devices = [
      {
        deviceId: "speaker-1",
        name: "客厅",
        model: "",
        hardware: "",
        presence: "online",
      },
    ];
    state.config.selectedDeviceId = "speaker-1";
  });
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        tracks: [
          {
            id: "one",
            title: "晴天",
            artist: "周杰伦",
            playUrl: "https://media.example/one.mp3",
          },
          {
            id: "two",
            title: "稻香",
            artist: "周杰伦",
            playUrl: "https://media.example/two.mp3",
          },
          {
            id: "cover",
            title: "晴天",
            artist: "翻唱歌手",
            playUrl: "https://media.example/cover.mp3",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const played = [];
  const result = await executeAssistant(
    "播放周杰伦的歌",
    store,
    {
      execute: async (_deviceId, _command, args) => {
        played.push(args.url);
      },
    },
    fetchImpl,
  );
  assert.equal(result.intent.action, "play_artist");
  assert.equal(result.playbackQueue.tracks.length, 2);
  assert.deepEqual(played, ["https://media.example/one.mp3"]);
});

test("concurrent next-track requests advance the queue serially", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-queue-race-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.selectedDeviceId = "speaker-1";
    state.config.devices = [
      {
        deviceId: "speaker-1",
        name: "客厅",
        model: "",
        hardware: "",
        presence: "online",
      },
    ];
    state.config.playbackQueue = {
      currentIndex: 0,
      tracks: ["one", "two", "three"].map((id) => ({
        id,
        sourceId: "test",
        title: id,
        artist: "歌手",
        playUrl: store.encrypt("https://media.example/" + id + ".mp3"),
      })),
    };
  });
  const played = [];
  const miot = {
    async execute(_device, command, args) {
      if (command === "play") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        played.push(args.url);
      }
      return { success: true };
    },
  };
  const results = await Promise.all([
    executeAssistant("下一首", store, miot),
    executeAssistant("下一首", store, miot),
  ]);
  assert.deepEqual(played, [
    "https://media.example/two.mp3",
    "https://media.example/three.mp3",
  ]);
  assert.deepEqual(
    results.map((result) => result.playbackQueue.currentIndex),
    [1, 2],
  );
});

test("ordinary AI answers do not call optional web search", async (t) => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "speaker-platform-search-fallback-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.ai.baseUrl = "https://model.example/v1";
    state.config.ai.model = "test-model";
    state.config.ai.apiKey = store.encrypt("model-key");
    state.config.webSearch.apiKey = store.encrypt("search-key");
  });
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.tavily.com") throw new Error("search offline");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "answer",
                question: "介绍一下火星",
                answer: "火星是太阳系的一颗行星。",
                confidence: 0.95,
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await executeAssistant(
    "介绍一下火星",
    store,
    { execute: async () => ({ success: true }) },
    fetchImpl,
  );
  assert.equal(result.message, "火星是太阳系的一颗行星。");
  assert.equal(result.searchError, undefined);
  assert.equal(result.searchUsed, false);
});

test("settings preserve omitted secrets and can explicitly clear them", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-settings-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await createAppServer({ dataDir });
  t.after(() => server.emit("close"));
  const setup = await requestApp(server, "/api/setup", "POST", {
    password: "correct horse battery staple",
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers["set-cookie"].split(";", 1)[0];
  const putSettings = (body) =>
    requestApp(server, "/api/settings", "PUT", body, cookie);
  const source = {
    id: "music-1",
    name: "music",
    endpoint: "https://music.example/search",
    enabled: true,
    apiKey: "music-secret",
  };
  assert.equal(
    (
      await putSettings({
        ai: {
          baseUrl: "https://ai.example/v1",
          model: "model",
          apiKey: "ai-secret",
        },
        webSearch: { apiKey: "search-secret" },
        musicSources: [source],
      })
    ).status,
    200,
  );
  const raw = await readFile(join(dataDir, "state.json"), "utf8");
  for (const secret of ["ai-secret", "search-secret", "music-secret"])
    assert.equal(raw.includes(secret), false);
  assert.equal(
    (
      await putSettings({
        ai: { baseUrl: "https://ai.example/v1", model: "model" },
        webSearch: {},
        musicSources: [{ ...source, apiKey: "" }],
      })
    ).status,
    200,
  );
  const statusRequest = async () =>
    (await requestApp(server, "/api/status", "GET", undefined, cookie)).body;
  let status = await statusRequest();
  assert.equal(status.ai.keySet, true);
  assert.equal(status.webSearch.keySet, true);
  assert.equal(status.musicSources[0].keySet, true);
  assert.equal(
    (
      await putSettings({
        ai: {
          baseUrl: "https://ai.example/v1",
          model: "model",
          clearApiKey: true,
        },
        webSearch: { clearApiKey: true },
        musicSources: [{ ...source, apiKey: "", clearApiKey: true }],
      })
    ).status,
    200,
  );
  status = await statusRequest();
  assert.equal(status.ai.keySet, false);
  assert.equal(status.webSearch.keySet, false);
  assert.equal(status.musicSources[0].keySet, false);
});

test("player APIs persist favorites and queue without exposing stored playback URLs", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-player-api-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await createAppServer({ dataDir });
  t.after(() => server.emit("close"));
  const setup = await requestApp(server, "/api/setup", "POST", {
    password: "correct horse battery staple",
  });
  const cookie = setup.headers["set-cookie"].split(";", 1)[0];
  const track = {
    id: "sunny-day",
    sourceId: "fixture",
    title: "晴天",
    artist: "周杰伦",
    playUrl: "https://media.example/sunny-day.mp3",
  };

  assert.equal(
    (await requestApp(server, "/api/playback/state", "GET")).status,
    401,
  );
  const favorite = await requestApp(
    server,
    "/api/music/favorites",
    "POST",
    { track },
    cookie,
  );
  assert.equal(favorite.status, 200);
  assert.equal(favorite.body.favorited, true);
  assert.equal(JSON.stringify(favorite.body).includes("media.example"), false);

  const queued = await requestApp(
    server,
    "/api/music/queue/add",
    "POST",
    { track },
    cookie,
  );
  assert.equal(queued.status, 200);
  assert.equal(queued.body.added, 1);
  assert.equal(JSON.stringify(queued.body).includes("media.example"), false);

  const state = await requestApp(
    server,
    "/api/playback/state",
    "GET",
    undefined,
    cookie,
  );
  assert.equal(state.status, 200);
  assert.equal(state.body.playbackQueue.tracks[0].title, "晴天");
  assert.equal(state.body.device, null);
  assert.equal(JSON.stringify(state.body).includes("media.example"), false);

  const favorites = await requestApp(
    server,
    "/api/music/favorites",
    "GET",
    undefined,
    cookie,
  );
  assert.equal(favorites.body.tracks.length, 1);
  assert.equal(Object.hasOwn(favorites.body.tracks[0], "playUrl"), false);
  const removed = await requestApp(
    server,
    "/api/music/favorites",
    "POST",
    { id: track.id, sourceId: track.sourceId },
    cookie,
  );
  assert.equal(removed.body.favorited, false);
  const savedOnly = { ...track, id: "saved-only", title: "独立收藏" };
  assert.equal(
    (
      await requestApp(
        server,
        "/api/music/favorites",
        "POST",
        { track: savedOnly },
        cookie,
      )
    ).body.favorited,
    true,
  );
  assert.equal(
    (
      await requestApp(
        server,
        "/api/music/favorites",
        "POST",
        { id: savedOnly.id, sourceId: savedOnly.sourceId },
        cookie,
      )
    ).body.favorited,
    false,
  );

  assert.equal(
    (
      await requestApp(
        server,
        "/api/playback/mode",
        "PUT",
        { mode: "random" },
        cookie,
      )
    ).body.mode,
    "random",
  );
  assert.equal(
    (
      await requestApp(
        server,
        "/api/playback/mode",
        "PUT",
        { mode: "unexpected" },
        cookie,
      )
    ).status,
    400,
  );
  const persisted = await readFile(join(dataDir, "state.json"), "utf8");
  assert.equal(persisted.includes("media.example"), false);
});

test("music search APIs return song candidates and named playlist tracks", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-search-api-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const payload =
      url.pathname === "/playlists"
        ? {
            playlists: [
              {
                name: "通勤歌单",
                tracks: [
                  {
                    id: "track-2",
                    title: "稻香",
                    artist: "周杰伦",
                    playUrl: "https://media.example/rice.mp3",
                  },
                ],
              },
            ],
          }
        : {
            tracks: [
              {
                id: "track-1",
                title: "晴天",
                artist: "周杰伦",
                playUrl: "https://media.example/sunny.mp3",
              },
            ],
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const server = await createAppServer({ dataDir, fetchImpl });
  t.after(() => server.emit("close"));
  const setup = await requestApp(server, "/api/setup", "POST", {
    password: "correct horse battery staple",
  });
  const cookie = setup.headers["set-cookie"].split(";", 1)[0];
  const settings = await requestApp(
    server,
    "/api/settings",
    "PUT",
    {
      musicSources: [
        {
          id: "fixture",
          name: "Fixture",
          endpoint: "https://music.example/search",
          playlistEndpoint: "https://music.example/playlists",
          enabled: true,
          apiKey: "",
        },
      ],
    },
    cookie,
  );
  assert.equal(settings.status, 200);

  const songs = await requestApp(
    server,
    "/api/music/search",
    "POST",
    { query: "周杰伦 晴天" },
    cookie,
  );
  assert.equal(songs.status, 200);
  assert.equal(songs.body.tracks[0].title, "晴天");
  assert.equal(songs.body.selection.status, "selected");
  const playlist = await requestApp(
    server,
    "/api/music/playlist/search",
    "POST",
    { name: "通勤歌单" },
    cookie,
  );
  assert.equal(playlist.status, 200);
  assert.equal(playlist.body.tracks[0].title, "稻香");
  assert.deepEqual(playlist.body.sourceErrors, []);

  const restarted = await createAppServer({ dataDir, fetchImpl });
  t.after(() => restarted.emit("close"));
  const login = await requestApp(restarted, "/api/login", "POST", {
    password: "correct horse battery staple",
  });
  assert.equal(login.status, 200);
  const restartedCookie = login.headers["set-cookie"].split(";", 1)[0];
  const afterRestart = await requestApp(
    restarted,
    "/api/music/search",
    "POST",
    { query: "晴天" },
    restartedCookie,
  );
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.body.tracks[0].title, "晴天");
});

test("L05C playback APIs preserve the queue on rejection and replay saved songs by identity", async (t) => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "speaker-platform-play-rejection-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.selectedDeviceId = "speaker-1";
    state.config.devices = [
      {
        deviceId: "speaker-1",
        name: "客厅",
        model: "L05C",
        hardware: "L05C",
        presence: "online",
      },
    ];
    state.config.xiaomi = {
      userId: "fixture",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  const played = [];
  const server = await createAppServer({
    dataDir,
    async fetchImpl(_url, options) {
      assert.equal(options.body.get("method"), "player_play_music");
      const message = JSON.parse(options.body.get("message"));
      const { url } = JSON.parse(message.music).payload.audio_items[0].stream;
      played.push(url);
      return Response.json(
        url.endsWith("reject.mp3")
          ? { code: 0, data: { code: 12, message: "设备拒绝" } }
          : { code: 0, data: { code: 0 } },
      );
    },
  });
  t.after(() => server.emit("close"));
  const setup = await requestApp(server, "/api/setup", "POST", {
    password: "correct horse battery staple",
  });
  const cookie = setup.headers["set-cookie"].split(";", 1)[0];
  const app = (path, method, body) =>
    requestApp(server, path, method, body, cookie);
  const track = (id) => ({
    id,
    sourceId: "test",
    title: id,
    artist: "歌手",
    playUrl: "https://media.example/" + id + ".mp3",
  });
  const first = track("first");
  const second = track("second");
  const started = await app("/api/music/play", "POST", { track: first });
  assert.equal(started.status, 200);
  await app("/api/music/queue/add", "POST", { track: second });
  const rejected = await app("/api/music/play", "POST", {
    track: track("reject"),
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "设备拒绝");
  const queue = (await app("/api/music/queue", "GET")).body;
  assert.deepEqual(
    queue.tracks.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(queue.currentIndex, 0);
  assert.deepEqual(
    (await app("/api/music/history", "GET")).body.entries.map(
      (entry) => entry.track.id,
    ),
    ["first"],
  );

  const staleClick = await app("/api/music/queue/play", "POST", {
    index: 0,
    id: second.id,
    sourceId: second.sourceId,
  });
  assert.equal(staleClick.status, 400);
  assert.deepEqual(played, [first.playUrl, track("reject").playUrl]);
  assert.equal(
    (
      await app("/api/music/queue/play", "POST", {
        index: 1,
        id: second.id,
        sourceId: second.sourceId,
      })
    ).body.track.id,
    "second",
  );

  await app("/api/music/favorites", "POST", { track: first });
  await app("/api/music/favorites", "POST", { track: second });
  for (const kind of ["history", "favorites"]) {
    const result = await app("/api/music/library/play", "POST", {
      kind,
      id: first.id,
      sourceId: first.sourceId,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.track.id, "first");
  }
  assert.deepEqual(played.slice(-3), [
    second.playUrl,
    first.playUrl,
    first.playUrl,
  ]);
});

test("assistant history is bounded before sending it to the model", async (t) => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "speaker-platform-history-limit-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let modelRequest;
  const fetchImpl = async (_url, options) => {
    modelRequest = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "answer",
                question: "接着呢",
                answer: "收到。",
                confidence: 0.9,
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const server = await createAppServer({ dataDir, fetchImpl });
  t.after(() => server.emit("close"));
  const setup = await requestApp(server, "/api/setup", "POST", {
    password: "correct horse battery staple",
  });
  const cookie = setup.headers["set-cookie"].split(";", 1)[0];
  await requestApp(
    server,
    "/api/settings",
    "PUT",
    {
      ai: {
        baseUrl: "https://ai.example/v1",
        model: "model",
        apiKey: "model-key",
      },
    },
    cookie,
  );
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "歌".repeat(2000),
  }));
  const response = await requestApp(
    server,
    "/api/assistant/route",
    "POST",
    { text: "接着呢", history },
    cookie,
  );
  assert.equal(response.status, 200);
  const turns = modelRequest.messages.slice(1, -1);
  assert.equal(turns.length, 3);
  assert.equal(
    turns.reduce((sum, turn) => sum + turn.content.length, 0),
    6000,
  );
});

test("QR browser module is served with correct MIME and cancellation requires admin authentication", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-qr-api-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await createAppServer({
    dataDir,
    fetchImpl: async () => {
      throw new Error("unexpected network request");
    },
  });
  t.after(() => server.emit("close"));
  const asset = await requestApp(server, "/qr-login.js", "GET");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(asset.body, /export function createQrLogin/u);
  assert.equal(asset.headers["cache-control"], "no-store");
  assert.equal(
    (
      await requestApp(server, "/api/miot/qrcode/cancel", "POST", {
        loginId: "one",
      })
    ).status,
    401,
  );
  const setup = await requestApp(server, "/api/setup", "POST", {
    password: "correct horse battery staple",
  });
  const cookie = setup.headers["set-cookie"].split(";", 1)[0];
  const cancel = await requestApp(
    server,
    "/api/miot/qrcode/cancel",
    "POST",
    { loginId: "one" },
    cookie,
  );
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.body, { cancelled: true });
});

test(
  "the server advances after a firmware repeat without polling the player API",
  { timeout: 14_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-autoplay-"));
    const store = new JsonStore(dataDir);
    await store.init();
    await store.update((state) => {
      state.config.selectedDeviceId = "speaker";
      state.config.devices = [
        {
          deviceId: "speaker",
          name: "Fixture",
          model: "L05C",
          hardware: "L05C",
          presence: "online",
        },
      ];
      state.config.xiaomi = {
        userId: "fixture",
        passToken: store.encrypt("pass"),
        serviceToken: store.encrypt("service"),
        serviceTokenExpiresAt: Date.now() + 600_000,
      };
    });
    const calls = [];
    const samples = [3000, 6100, 1100];
    const secondCast = Promise.withResolvers();
    const server = await createAppServer({
      dataDir,
      async fetchImpl(_url, options) {
        const method = options.body.get("method");
        if (method === "player_get_play_status") {
          return Response.json({
            code: 0,
            data: {
              info: {
                status: 1,
                play_song_detail: {
                  position: samples.shift() ?? 1200,
                  duration: 8000,
                },
              },
            },
          });
        }
        assert.equal(method, "player_play_music");
        const message = JSON.parse(options.body.get("message"));
        calls.push(
          new URL(JSON.parse(message.music).payload.audio_items[0].stream.url)
            .pathname,
        );
        if (calls.length === 2) secondCast.resolve();
        return Response.json({ code: 0, data: { code: 0 } });
      },
    });
    t.after(async () => {
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const create = await fetch(base + "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-only-password" }),
    });
    assert.equal(create.status, 201);
    const cookie = create.headers.get("set-cookie").split(";", 1)[0];
    const app = async (path, method, body) => {
      const response = await fetch(base + path, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const track = (id) => ({
      id,
      sourceId: "fixture",
      title: id,
      artist: "fixture",
      playUrl: "https://media.example/" + id + ".mp3",
    });
    await app("/api/playback/mode", "PUT", { mode: "loop" });
    await app("/api/music/play", "POST", { track: track("first") });
    await app("/api/music/queue/add", "POST", { track: track("second") });
    await Promise.race([
      secondCast.promise,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("speaker received no second song")),
          11_500,
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(calls, ["/first.mp3", "/second.mp3"]);
    // The mock acknowledges the cast before the background task persists it.
    // Wait on disk so teardown cannot remove the temporary state mid-write.
    let savedIndex;
    for (let attempt = 0; attempt < 50; attempt++) {
      const saved = JSON.parse(
        await readFile(join(dataDir, "state.json"), "utf8"),
      );
      savedIndex = saved.config.playbackQueue.currentIndex;
      if (savedIndex === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(savedIndex, 1);
  },
);

async function requestApp(server, url, method, body, cookie = "") {
  return new Promise((resolve) => {
    const headers = {};
    const response = {
      status: 0,
      headers,
      body: undefined,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values = {}) {
        this.status = status;
        Object.assign(
          headers,
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          ),
        );
      },
      end(value = "") {
        this.body = headers["content-type"]?.startsWith("application/json")
          ? JSON.parse(String(value))
          : String(value);
        resolve(this);
      },
    };
    const request = {
      method,
      url,
      headers: { host: "localhost", ...(cookie ? { cookie } : {}) },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
    server.emit("request", request, response);
  });
}
