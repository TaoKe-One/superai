import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(
  new URL("../public/lx/bridge.js", import.meta.url),
  "utf8",
);
const flush = () => new Promise((r) => setImmediate(r));
const track = (id) => ({
  id,
  sourceId: "lx-wy",
  title: id,
  artist: "artist",
  lx: { platform: "wy", songInfo: { songmid: id } },
});
test("player errors close immediately or after five seconds and polling does not reopen them", async () => {
  const elements = new Map();
  const timers = new Map();
  let time = 1000,
    serial = 0,
    playbackError = "自动续播失败";
  class Clock extends Date {
    static now() {
      return time;
    }
  }
  const context = {
    Date: Clock,
    document: {
      addEventListener() {},
      querySelector(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
    setInterval(callback, period) {
      const id = ++serial;
      timers.set(id, { callback, period });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    AbortSignal,
    AbortController,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        device: { deviceId: "speaker" },
        playbackQueue: { tracks: [], currentIndex: -1 },
        autoPlayback: { error: playbackError },
      }),
    }),
  };
  vm.runInNewContext(code, context);
  const player = context.SpeakerLX.player({
    stopCastHeartbeat() {},
    endLoading() {},
  });
  const tick = () => {
    time += 1000;
    for (const { callback, period } of timers.values())
      if (period === 1000) callback();
  };
  await player.bootstrap();
  const notice = elements.get("#sp-lx-error");
  const countdown = elements.get("#sp-lx-error-countdown");
  assert.equal(notice.hidden, false);
  assert.equal(countdown.textContent, "5 秒后自动关闭");
  tick();
  assert.equal(countdown.textContent, "4 秒后自动关闭");
  elements.get("#sp-lx-error-close").onclick();
  assert.equal(notice.hidden, true);
  await player.syncBackendState();
  assert.equal(notice.hidden, true);
  playbackError = "新播放错误";
  await player.syncBackendState();
  assert.equal(notice.hidden, false);
  for (let i = 0; i < 4; i++) tick();
  await player.syncBackendState();
  assert.equal(countdown.textContent, "1 秒后自动关闭");
  assert.equal(notice.hidden, false);
  tick();
  assert.equal(notice.hidden, true);
});

test("bridge sends the complete large playback context and preserves the clicked index", async () => {
  const elements = new Map(),
    calls = [];
  const tracks = Array.from({ length: 620 }, (_, i) => track(String(i)));
  const context = {
    document: {
      addEventListener() {},
      querySelector(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
    location: { origin: "http://fixture.example" },
    setInterval() {},
    clearInterval() {},
    URL,
    AbortSignal,
    AbortController,
    fetch: async (path, options) => {
      if (path === "/api/lx/player/play") calls.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () =>
          path === "/api/playback/state"
            ? {
                playbackQueue: { tracks, currentIndex: 519 },
                playbackMode: "order",
              }
            : {},
      };
    },
  };
  vm.runInNewContext(code, context);
  const player = context.SpeakerLX.player({
    stopCastHeartbeat() {},
    beginLoading() {},
    endLoading() {},
  });
  assert.equal(await player.playContext(tracks, 519), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tracks.length, 620);
  assert.equal(calls[0].index, 519);
  assert.equal(player.playlist.length, 620);
  assert.equal(player.currentIndex, 519);
});
test("paged playback keeps the clicked occurrence and never sends an incomplete queue", async () => {
  const elements = new Map();
  const duplicate = track("same");
  const pages = [
    [duplicate, track("first")],
    [track("second"), duplicate],
  ];
  const casts = [];
  let repeatPage = false;
  const context = {
    document: {
      addEventListener() {},
      querySelector(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
    setInterval() {},
    clearInterval() {},
    AbortSignal,
    AbortController,
    async fetch(path, options) {
      const request = options.body && JSON.parse(options.body);
      let data = {};
      if (path === "/api/lx/catalog")
        data = {
          list: pages[repeatPage ? 0 : request.page - 1],
          has_more: request.page === 1,
        };
      if (path === "/api/lx/player/play") casts.push(request);
      if (path === "/api/playback/state")
        data = {
          playbackQueue: { tracks: [], currentIndex: -1 },
          device: { deviceId: "fixture" },
          playbackMode: "random",
        };
      return { ok: true, json: async () => data };
    },
  };
  vm.runInNewContext(code, context);
  const bridge = context.SpeakerLX;
  const player = bridge.player({
    stopCastHeartbeat() {},
    beginLoading() {},
    endLoading() {},
  });
  const load = bridge.onlineTrackLoader({ operation: "search", page: 2 });
  assert.equal(
    await player.playContext(pages[1], 1, (signal) => load(signal, () => true)),
    true,
  );
  assert.deepEqual(
    casts[0].tracks.map((song) => song.id),
    ["same", "first", "second", "same"],
  );
  assert.equal(casts[0].index, 3);
  assert.equal(player.playMode, "random");
  repeatPage = true;
  assert.equal(
    await player.playContext(pages[1], 1, (signal) => load(signal, () => true)),
    false,
  );
  assert.equal(casts.length, 1);
  assert.match(
    elements.get("#sp-lx-error-message").textContent,
    /分页返回重复/,
  );
});

test("catalog switching preserves the player and blocks online browsing in private mode", async () => {
  const elements = new Map();
  const calls = [];
  const context = {
    document: {
      addEventListener() {},
      querySelector(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
    location: { origin: "http://fixture.example" },
    setInterval() {},
    clearInterval() {},
    URL,
    AbortSignal,
    AbortController,
    fetch: async (path, options) => {
      calls.push({ path, options });
      return { ok: true, json: async () => ({ items: [] }) };
    },
  };
  vm.runInNewContext(code, context);
  const bridge = context.SpeakerLX;
  const config = { mode: "private", libraries: [{ id: "home", name: "Home" }] };
  bridge.configureCatalog(config);
  const app = {
    currentView: "leaderboard",
    setView(view) {
      this.currentView = view;
    },
  };
  bridge.app(app);
  const player = bridge.player({
    playlist: [track("kept")],
    stopCastHeartbeat() {},
  });
  const queue = player.playlist;
  assert.equal(app.currentView, "search");
  assert.equal(app.catalog.kind, "private");
  await assert.rejects(bridge.request("/search?keyword=test"), /不是 LX/);
  assert.equal(calls.length, 0);
  await bridge.browsePrivate({ libraryId: "home", page: 2 });
  assert.equal(calls[0].path, "/api/music/services/browse");
  bridge.configureCatalog({ ...config, mode: "online" });
  await bridge.request("/search?keyword=test");
  assert.equal(calls[1].path, "/api/lx/catalog");
  bridge.configureCatalog({ ...config, mode: "hybrid" });
  assert.equal(app.catalog.kind, "online");
  bridge.configureCatalog(config);
  assert.equal(bridge.player(player), player);
  assert.equal(player.playlist, queue);
  const first = {
    id: "same",
    sourceId: "library:home",
    library: { providerId: "home", trackId: "same" },
  };
  const second = {
    ...first,
    sourceId: "library:other",
    library: { providerId: "other", trackId: "same" },
  };
  assert.notEqual(bridge.songKey(first), bridge.songKey(second));
  assert.deepEqual(bridge.song(first).library, first.library);
});
test("bridge isolates delayed lyric responses, follows sampled device progress and freezes on pause/stale status", async () => {
  const elements = new Map(),
    timers = new Map(),
    lyricRequests = new Map();
  let now = 100000,
    clock = 0;
  let current = track("one"),
    position = 0,
    status = 1;
  const document = {
    visibilityState: "visible",
    addEventListener() {},
    querySelector(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener() {} });
      return elements.get(id);
    },
  };
  class ClockDate extends Date {
    static now() {
      return now;
    }
  }
  const context = {
    document,
    window: { addEventListener() {} },
    Date: ClockDate,
    performance: { now: () => clock },
    AbortSignal,
    AbortController,
    URL,
    setInterval(fn, ms) {
      timers.set(ms, fn);
      return ms;
    },
    clearInterval(ms) {
      timers.delete(ms);
    },
    fetch: async (path, opts) => {
      if (path === "/api/playback/state")
        return {
          ok: true,
          json: async () => ({
            currentTrack: current,
            playbackQueue: { tracks: [current], currentIndex: 0 },
            device: { name: "fixture", deviceId: "fixture" },
            deviceStatus: { status, position, duration: 100, sampledAt: now },
          }),
        };
      assert.equal(path, "/api/lx/lyrics");
      const id = JSON.parse(opts.body).track.id;
      return new Promise((resolve) =>
        lyricRequests.set(id, {
          signal: opts.signal,
          resolve: (value) => resolve({ ok: true, json: async () => value }),
        }),
      );
    },
  };
  vm.runInNewContext(code, context);
  const player = { stopCastHeartbeat() {}, endLoading() {} };
  context.SpeakerLX.player(player);
  await player.bootstrap();
  await flush();
  assert.equal(lyricRequests.size, 1);
  current = track("two");
  await player.syncBackendState();
  await flush();
  assert.equal(lyricRequests.get("one").signal.aborted, true);
  lyricRequests.get("two").resolve({
    available: true,
    timed: true,
    lines: [
      { time: 1, text: "new first" },
      { time: 3, text: "new second" },
    ],
  });
  await flush();
  assert.equal(player.currentLyricIndex, -1);
  assert.equal(player.currentLyricLine, "前奏");
  lyricRequests.get("one").resolve({
    available: true,
    timed: true,
    lines: [{ time: 0, text: "wrong old song" }],
  });
  await flush();
  assert.equal(player.parsedLyrics[0].text, "new first");
  now += 1500;
  clock += 1500;
  timers.get(250)();
  assert.equal(player.currentLyricLine, "new first");
  now += 2000;
  clock += 2000;
  timers.get(250)();
  assert.equal(player.currentLyricLine, "new second");
  status = 2;
  position = 4;
  await player.syncBackendState();
  now += 3000;
  clock += 3000;
  timers.get(250)();
  assert.equal(player.currentTime, 4);
  status = 1;
  position = 5;
  await player.syncBackendState();
  now += 12000;
  clock += 12000;
  timers.get(250)();
  assert.equal(player.currentTime, 5);
  assert.equal(lyricRequests.size, 2);
});

test("temporary detach keeps browser audio until a successful manual or voice cast", async () => {
  const elements = new Map();
  const calls = [];
  let voice,
    failCast = false,
    element;
  const remote = {
    currentTrack: track("one"),
    playbackQueue: {
      tracks: [track("one"), track("two")],
      currentIndex: 0,
      revision: "snapshot",
    },
    playbackMode: "order",
    device: { name: "speaker", deviceId: "fixture" },
    deviceStatus: { status: 1, position: 17, duration: 100 },
  };
  const context = {
    document: {
      addEventListener() {},
      querySelector(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
    setInterval() {},
    clearInterval() {},
    URL,
    AbortSignal,
    AbortController,
    Audio: class {
      paused = true;
      currentTime = 0;
      addEventListener() {}
      removeAttribute() {
        this.src = "";
      }
      getAttribute() {
        return this.src;
      }
      load() {}
      pause() {
        this.paused = true;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      constructor() {
        element = this;
      }
    },
    fetch: async (path, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ path, body });
      let data = {};
      const ok = path !== "/api/lx/player/play" || !failCast;
      if (path === "/api/playback/state")
        data = { ...remote, voicePlayback: voice };
      if (path === "/api/lx/player/browser")
        data = {
          url: "https://fixture.example/" + body.track.id,
          track: body.track,
        };
      if (!ok) data = { error: "speaker offline" };
      return { ok, status: ok ? 200 : 400, json: async () => data };
    },
  };
  vm.runInNewContext(code, context);
  const player = context.SpeakerLX.player({
    stopCastHeartbeat() {},
    beginLoading() {},
    endLoading() {},
  });
  await player.bootstrap();
  await player.disconnectCast();
  assert.equal(player.isCasting, false);
  assert.equal(element.paused, false);
  assert.equal(element.currentTime, 17);
  assert.equal(
    calls.find((c) => c.path === "/api/lx/player/detach").body.revision,
    "snapshot",
  );
  await player.playAt(1);
  assert.match(element.src, /\/two$/);
  failCast = true;
  assert.equal(
    (await player.connectCastDevice({ device_id: "fixture" })).ok,
    false,
  );
  assert.equal(element.paused, false);
  assert.equal(player.isCasting, false);
  failCast = false;
  assert.equal(
    (await player.connectCastDevice({ device_id: "fixture" })).ok,
    true,
  );
  const request = calls.findLast((c) => c.path === "/api/lx/player/play");
  assert.equal(request.body.tracks[request.body.index].id, "two");
  assert.equal(request.body.deviceId, "fixture");
  assert.equal(element.paused, true);
  assert.equal(player.isCasting, true);

  await player.disconnectCast();
  await player.syncBackendState();
  assert.equal(player.isCasting, false);
  voice = { id: "new-voice", deviceId: "fixture" };
  remote.currentTrack = track("voice");
  remote.playbackQueue = {
    tracks: [remote.currentTrack],
    currentIndex: 0,
    revision: "voice",
  };
  await player.syncBackendState();
  assert.equal(player.isCasting, true);
  assert.equal(element.src, "");
  assert.equal(player.playlist[0].id, "voice");
  await player.disconnectCast();
  await player.syncBackendState();
  assert.equal(
    player.isCasting,
    false,
    "an already observed voice command cannot reattach",
  );
});
