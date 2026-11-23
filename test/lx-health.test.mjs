import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { JsonStore } from "../src/storage/store.ts";
import { LxMusicService, fromLxSong } from "../src/music/lx/service.ts";
import { LxCatalog } from "../src/music/lx/catalog.ts";
import { parseLrc, trackLyrics } from "../src/music/lx/lyrics.ts";
import {
  healthSample,
  rankSources,
  LxResolutionError,
} from "../src/music/lx/health.ts";
import { audioFormat, probeAudio } from "../src/music/lx/probe.ts";
import {
  startSourceCheck,
  sourceCheckStatus,
  stopSourceCheck,
} from "../src/music/lx/checks.ts";
import { PlaybackService } from "../src/playback/service.ts";
import { handleLxApi } from "../src/music/lx/api.ts";
import { catalogFixture, json } from "./helpers/lx-fixture.mjs";

const track = fromLxSong({
  source: "wy",
  songmid: "one",
  name: "歌曲",
  singer: "歌手",
});
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20000)]);
const script = (name, code, platforms = ["wy", "tx"]) =>
  "/** @name " +
  name +
  " */\n" +
  'lx.send("inited",{sources:' +
  JSON.stringify(
    Object.fromEntries(
      platforms.map((p) => [
        p,
        { actions: ["musicUrl"], qualitys: ["128k", "320k"] },
      ]),
    ),
  ) +
  "});" +
  'lx.on("request",({source,info})=>{' +
  code +
  "});";
async function setup(t, network) {
  const dir = await mkdtemp(join(tmpdir(), "speaker-lx-health-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir);
  await store.init();
  return { store, dir, lx: new LxMusicService(store, network) };
}

test("audio probes bound ignored Range responses, cancel streams, and reject HTML/errors/empty data", async () => {
  let cancelled = false,
    range;
  const result = await probeAudio(
    "https://audio.example/track",
    AbortSignal.timeout(1000),
    async (_url, opts) => {
      range = opts.headers.range;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(mp3);
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  );
  assert.equal(result.bytes, 16384);
  assert.equal(range, "bytes=0-16383");
  assert.equal(cancelled, true);
  for (const [body, status] of [
    ["<html>not an audio file</html>", 200],
    [mp3, 403],
    ["", 200],
    [JSON.stringify({ error: "expired" }), 200],
  ])
    await assert.rejects(
      probeAudio(
        "https://audio.example/bad",
        AbortSignal.timeout(1000),
        async () => new Response(body, { status }),
      ),
    );
  const controller = new AbortController();
  const hung = probeAudio(
    "https://audio.example/hung",
    controller.signal,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  controller.abort();
  await assert.rejects(hung);
  assert.equal(audioFormat(Buffer.from("fLaC" + " ".repeat(30))), "flac");
  assert.equal(audioFormat(Buffer.from("OggS" + " ".repeat(30))), "ogg");
  await assert.rejects(
    probeAudio(
      "http://127.0.0.1/x",
      AbortSignal.timeout(1000),
      async () => new Response(mp3),
    ),
    /私有网络/,
  );
});

test("health ranking scopes failures by platform and respects priority, cooldown and expiry", () => {
  const now = 1_000_000;
  let h = healthSample(undefined, false, 100, "audio", "320k", now);
  h = healthSample(h, false, 200, "audio", "320k", now + 1);
  assert.equal(h.failures, 2);
  assert.ok(h.cooldownUntil > now);
  const a = {
    id: "a",
    health: { wy: h },
    routing: { wy: { enabled: true, priority: 100 } },
  };
  const b = {
    id: "b",
    health: { wy: healthSample(undefined, true, 500, "ok", "320k", now) },
  };
  assert.deepEqual(
    rankSources([a, b], "wy", now).map((s) => s.id),
    ["b", "a"],
  );
  assert.deepEqual(
    rankSources([a, b], "tx", now).map((s) => s.id),
    ["a", "b"],
  );
  const recovered = healthSample(h, true, 100, "ok", "128k", now + 2);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.cooldownUntil, 0);
  assert.deepEqual(
    rankSources(
      [{ ...a, routing: { wy: { enabled: false, priority: 100 } } }, b],
      "wy",
      now,
    ).map((s) => s.id),
    ["b"],
  );
  assert.deepEqual(
    rankSources(
      [
        {
          id: "old",
          health: { wy: { ...h, checkedAt: now - 86400001, cooldownUntil: 0 } },
        },
        { id: "new" },
      ],
      "wy",
      now,
    ).map((s) => s.id),
    ["old", "new"],
  );
});

test("production resolution falls through fake audio, persists health, and exposes safe attempts", async (t) => {
  const { store, lx, dir } = await setup(t, async (url) =>
    new URL(url).hostname === "bad.example"
      ? new Response("<html>expired token=SECRET</html>")
      : new Response(mp3, { status: 206 }),
  );
  const bad = await lx.importScript(
    script("bad", 'return "https://bad.example/fake?token=SECRET";'),
  );
  const good = await lx.importScript(
    script("good", 'return "https://good.example/music";'),
  );
  const calls = [];
  const playback = new PlaybackService(
    store,
    { execute: async (...args) => calls.push(args) },
    (t) => lx.resolvePlayback(t),
  );
  const result = await playback.replaceAndPlay("speaker", [track]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].url, "https://good.example/music");
  assert.equal(result.resolution.sourceId, good.id);
  assert.deepEqual(
    result.resolution.attempts.map((a) => [a.sourceId, a.stage]),
    [
      [bad.id, "audio"],
      [bad.id, "audio"],
      [good.id, "ready"],
    ],
  );
  assert.equal(store.snapshot().config.lxSources[0].health.wy.failures, 1);
  assert.equal(store.snapshot().config.lxSources[0].health.tx, undefined);
  assert.equal(JSON.stringify(playback.resolution()).includes("SECRET"), false);
  assert.equal(
    (await readFile(join(dir, "state.json"), "utf8")).includes("token=SECRET"),
    false,
  );
  // A healthy alternative should be tried first on the next request.
  assert.equal((await lx.resolvePlayback(track)).attempts.length, 1);
  const reopened = new JsonStore(dir);
  await reopened.init();
  assert.equal(reopened.snapshot().config.lxSources[0].health.wy.failures, 1);
});

test("quality downgrade and per-platform rules change the actual resolver, including assistant catalogs", async (t) => {
  const { store, lx } = await setup(t, async () => new Response(mp3));
  const a = await lx.importScript(
    script(
      "lower",
      'if(info.type==="320k")throw Error("no quality");return "https://lower.example/music";',
    ),
  );
  const b = await lx.importScript(
    script("other", 'return "https://other.example/music";'),
  );
  await lx.updateRouting(a.id, "wy", true, 90);
  assert.equal((await lx.resolvePlayback(track)).quality, "128k");
  await store.update((s) => (s.config.lxQualityFallback = false));
  assert.equal((await lx.resolvePlayback(track)).sourceId, b.id);
  await lx.updateRouting(b.id, "wy", false, 100);
  await assert.rejects(lx.resolvePlayback(track), LxResolutionError);
  await lx.updateRouting(a.id, "wy", false, 50);
  assert.deepEqual(
    lx.assistantSources().map((s) => s.id),
    ["lx-tx"],
  );
  await assert.rejects(lx.updateRouting(a.id, "kg", true, 10), /不支持/);
  await assert.rejects(lx.updateRouting(a.id, "tx", true, 101), /优先级/);
});

test("all failed sources leave queue/history intact, and speaker uncertainty never re-resolves or re-casts", async (t) => {
  const { store, lx } = await setup(t, async () => new Response(mp3));
  await lx.importScript(script("bad", 'throw Error("secret response");'));
  let sent = 0;
  const playback = new PlaybackService(
    store,
    { execute: async () => sent++ },
    (t) => lx.resolvePlayback(t),
  );
  const before = store.snapshot().config;
  await assert.rejects(
    playback.replaceAndPlay("speaker", [track]),
    (error) =>
      error instanceof LxResolutionError && !error.message.includes("secret"),
  );
  assert.equal(sent, 0);
  assert.deepEqual(store.snapshot().config.playbackQueue, before.playbackQueue);
  assert.deepEqual(
    store.snapshot().config.playbackHistory,
    before.playbackHistory,
  );
  await lx.importScript(script("good", 'return "https://good.example/x";'));
  let resolved = 0;
  const uncertain = new PlaybackService(
    store,
    {
      execute: async () => {
        sent++;
        throw Error("speaker timeout");
      },
    },
    async (t) => {
      resolved++;
      return lx.resolvePlayback(t);
    },
  );
  await assert.rejects(
    uncertain.replaceAndPlay("speaker", [track]),
    /speaker timeout/,
  );
  assert.equal(resolved, 1);
  assert.equal(sent, 1);
  assert.deepEqual(store.snapshot().config.playbackQueue, before.playbackQueue);
});

test("source removal during resolution cannot send a stale URL", async (t) => {
  let release, started;
  const waiting = new Promise((r) => (started = r));
  const { store, lx } = await setup(t, async () => {
    started();
    await new Promise((r) => (release = r));
    return new Response(mp3);
  });
  const source = await lx.importScript(
    script("removed", 'return "https://good.example/x";'),
  );
  const resolving = lx.resolvePlayback(track);
  await waiting;
  await lx.changeSource(source.id);
  release();
  await assert.rejects(resolving, LxResolutionError);
  assert.equal(store.snapshot().config.lxSources.length, 0);
});

test("LRC parsing handles multiple tags, sorting, duplicate tags, fractions, offset and translation", async (t) => {
  const { store } = await setup(t);
  assert.deepEqual(
    parseLrc(
      "[offset:500]\n[00:02.00][00:01.250]重复\n[00:01.250]重复\n[00:04]a<0,12>b",
    ),
    [
      { time: 0.75, text: "重复" },
      { time: 1.5, text: "重复" },
      { time: 3.5, text: "ab" },
    ],
  );
  assert.deepEqual(parseLrc("x".repeat(262145)), []);
  let count = 0;
  const catalog = {
    lyrics: async (platform, info) => {
      count++;
      assert.equal(platform, "wy");
      assert.equal(info.songmid, "one");
      await new Promise((r) => setTimeout(r, 5));
      return { lyric: "[00:01]原文", tlyric: "[00:01.05]译文" };
    },
  };
  const result = await Promise.all([
    trackLyrics(store, catalog, track),
    trackLyrics(store, catalog, track),
  ]);
  assert.equal(count, 1);
  assert.equal(result[0].lines[0].translation, "译文");
  await trackLyrics(store, catalog, track);
  assert.equal(count, 1);
  let failed = 0;
  const missing = fromLxSong({
    source: "wy",
    songmid: "missing",
    name: "other",
    singer: "artist",
  });
  const failing = {
    lyrics: async () => {
      failed++;
      throw Error("private detail");
    },
  };
  assert.equal(
    (await trackLyrics(store, failing, missing)).reason,
    "unavailable",
  );
  await trackLyrics(store, failing, missing);
  assert.equal(failed, 1);
  assert.equal(
    (await trackLyrics(store, catalog, { id: "direct" })).reason,
    "no_metadata",
  );
});

test("official WY, KG, KW and MG lyric adapters return timed lyrics; TX errors retry with the original song ID", async () => {
  const lyric = "[00:01.00]fixture lyric";
  const xor = Buffer.from(lyric);
  const key = Buffer.from("yeelion");
  for (let i = 0; i < xor.length; i++) xor[i] ^= key[i % key.length];
  const kw = Buffer.concat([
    Buffer.from("tp=content\r\n\r\n"),
    deflateSync(xor.toString("base64")),
  ]);
  let txCalls = 0;
  const catalog = new LxCatalog(async (url, opts) => {
    const u = new URL(url);
    if (u.hostname.includes("163")) return json({ code: 200, lrc: { lyric } });
    if (u.hostname.includes("kuwo")) return new Response(kw);
    if (u.hostname.includes("kugou"))
      return u.pathname.includes("search")
        ? json({
            candidates: [{ id: "exact", accesskey: "test", contenttype: 1 }],
          })
        : json({ fmt: "lrc", content: Buffer.from(lyric).toString("base64") });
    if (u.hostname === "lyrics.example") return new Response(lyric);
    if (u.hostname.includes("qq.com")) {
      txCalls++;
      assert.equal(JSON.parse(opts.body).req.param.songID, 123);
      return json({ code: 1, req: { code: 1 } });
    }
    throw Error("unexpected lyric request");
  });
  for (const p of ["wy", "kg", "kw", "mg"]) {
    const raw = await catalog.lyrics(p, {
      songmid: "one",
      hash: "hash",
      name: "fixture",
      mrcUrl: "",
      lrcUrl: "https://lyrics.example/a",
    });
    assert.ok(parseLrc(raw.lyric).length, p);
  }
  await assert.rejects(catalog.lyrics("tx", { songmid: "one", songId: 123 }));
  assert.equal(txCalls, 4);
});

async function finished(store) {
  for (let i = 0; i < 500; i++) {
    const job = sourceCheckStatus(store);
    if (job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("check did not finish");
}
test("checks measure every source/platform with at most two probes and never send speaker commands", async (t) => {
  let active = 0,
    max = 0;
  const { store, lx } = await setup(t, async (input) => {
    if (new URL(input).hostname === "good.example") {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return new Response(mp3);
    }
    return json(catalogFixture(input));
  });
  await lx.importScript(script("source1", 'return "https://good.example/x";'));
  await lx.importScript(script("source2", 'return "https://good.example/y";'));
  const first = startSourceCheck(store, lx);
  assert.equal(first.total, 4);
  assert.equal(startSourceCheck(store, lx).id, first.id);
  const result = await finished(store);
  assert.equal(result.completed, 4);
  assert.ok(result.results.every((r) => r.state === "ok"));
  assert.ok(max <= 2);
  assert.equal(store.snapshot().config.playbackHistory.length, 0);
});

test("cancelled checks release requests without penalizing sources; catalog outages are not source failures", async (t) => {
  let started;
  const waiting = new Promise((r) => (started = r));
  const { store, lx } = await setup(t, async () => {
    started();
    return new Response(new ReadableStream({}));
  });
  const source = await lx.importScript(
    script("slow", 'return "https://good.example/x";', ["wy"]),
  );
  await store.update(
    (s) => (s.config.playbackQueue.tracks = [{ ...track, playUrl: "" }]),
  );
  startSourceCheck(store, lx);
  await waiting;
  assert.equal(stopSourceCheck(store).state, "cancelled");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lx.sources()[0].health?.wy, undefined);
  const fresh = await setup(t, async () => {
    throw Error("catalog down");
  });
  await fresh.lx.importScript(
    script("catalog", 'return "https://good.example/x";', ["wy"]),
  );
  startSourceCheck(fresh.store, fresh.lx);
  const job = await finished(fresh.store);
  assert.equal(job.results[0].state, "catalog_error");
  assert.equal(fresh.lx.sources()[0].health?.wy, undefined);
});

test("native lyric, routing, and settings API validate changes and preserve partial settings", async (t) => {
  const { store, lx } = await setup(t, async () => new Response(mp3));
  const source = await lx.importScript(
    script("api", 'return "https://good.example/x";'),
  );
  const call = (method, path, body = {}) =>
    handleLxApi(
      method,
      path,
      new URL("http://platform" + path),
      body,
      lx,
      store,
      {},
    );
  assert.equal((await call("GET", "/settings")).qualityFallback, true);
  await call("PUT", "/settings", { qualityFallback: false });
  assert.equal(store.snapshot().config.lxQuality, "320k");
  await assert.rejects(call("PUT", "/settings", { qualityFallback: "yes" }));
  await call("PUT", "/sources/routing", {
    id: source.id,
    platform: "wy",
    enabled: false,
    priority: 80,
  });
  assert.equal(lx.sources()[0].routing.wy.enabled, false);
  assert.equal((await call("POST", "/lyrics")).reason, "no_metadata");
  assert.equal((await call("GET", "/sources/check-status")).state, "idle");
  await assert.rejects(call("POST", "/sources/check", { id: "missing" }));
});
