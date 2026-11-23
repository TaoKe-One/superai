import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeakerUrlRelay } from "../src/playback/url-relay.ts";
import { createAppServer } from "../src/server.ts";
import { JsonStore } from "../src/storage/store.ts";

const signed =
  "http://stream.example/song.mp3?guid=123&vkey=a%2Bb%2Fc&uin=0&fromtag=93";
async function relayFor(t, options = {}) {
  const relay = await new SpeakerUrlRelay({
    host: "127.0.0.1",
    port: 0,
    ...options,
  }).listen();
  t.after(() => relay.close());
  return relay;
}

test("song-only redirects preserve signed bytes, Range retries and HEAD without placing query parameters in Mina", async (t) => {
  const relay = await relayFor(t);
  const short = relay.issue(signed);
  assert.match(short, /\/audio\/[A-Za-z0-9_-]{43}\.mp3$/);
  assert.equal(new URL(short).search, "");
  // Model the firmware's destructive ampersand handling; the delivered URL survives.
  assert.equal(short.replaceAll("&", " "), short);
  assert.notEqual(signed.replaceAll("&", " "), signed);
  for (const options of [
    {},
    { headers: { range: "bytes=100-200" } },
    { method: "HEAD" },
  ]) {
    const response = await fetch(short, { ...options, redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), signed);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  assert.equal((await fetch(short, { method: "POST" })).status, 405);
  for (const path of [
    "/",
    "/api/status",
    "/api/setup",
    "/audio/guessed.mp3",
    new URL(short).pathname + "?url=https://other.example",
  ])
    assert.equal((await fetch(new URL(path, short))).status, 404);
});

test("tickets expire, cannot be reused after shutdown, and capacity never evicts active playback", async (t) => {
  let now = 1000;
  const relay = await relayFor(t, { now: () => now, ttlMs: 100, capacity: 1 });
  const first = relay.issue(signed);
  assert.throws(() => relay.issue(signed), /上限/);
  assert.equal((await fetch(first, { redirect: "manual" })).status, 302);
  now += 100;
  assert.equal((await fetch(first, { redirect: "manual" })).status, 404);
  const second = relay.issue(signed);
  assert.notEqual(first, second);
  await relay.close();
  assert.throws(() => relay.issue(signed), /未启动/);
  await relay.close();
});

test("relay rejects unsafe targets and unusable advertised bases", async (t) => {
  for (const options of [
    { host: "", port: 0 },
    { host: "127.0.0.1", port: -1 },
    { host: "0.0.0.0", port: 0 },
    { host: "127.0.0.1", port: 0, baseUrl: "http://0.0.0.0:8788" },
    {
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://media.example/path?secret=1",
    },
  ])
    assert.throws(() => new SpeakerUrlRelay(options));
  const relay = await relayFor(t);
  for (const target of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@media.example/song",
    "invalid",
    signed + "\r\nx-header: bad",
    signed + "\u0000",
    "https://media.example/" + "a".repeat(4096),
  ])
    assert.throws(() => relay.issue(target));
});

test("the HTTP playback route delivers an opaque URL to L05C while retaining encrypted original metadata", async (t) => {
  const relay = await relayFor(t);
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-relay-http-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.selectedDeviceId = "fixture";
    state.config.devices = [
      {
        deviceId: "fixture",
        name: "test",
        hardware: "L05C",
        model: "L05C",
        presence: "online",
      },
    ];
    state.config.xiaomi = {
      userId: "fixture",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600000,
    };
  });
  const deliveries = [];
  const server = await createAppServer({
    dataDir,
    playbackUrl: (url) => relay.issue(url),
    fetchImpl: async (_input, options) => {
      const method = options.body.get("method");
      if (method === "player_get_play_status")
        return Response.json({
          code: 0,
          data: { info: JSON.stringify({ status: 2 }) },
        });
      assert.equal(method, "player_play_music");
      const music = JSON.parse(JSON.parse(options.body.get("message")).music);
      const delivered = music.payload.audio_items[0].stream.url;
      assert.equal(new URL(delivered).search, "");
      const response = await fetch(delivered.replaceAll("&", " "), {
        redirect: "manual",
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), signed);
      deliveries.push(delivered);
      return Response.json({ code: 0, data: { code: 0 } });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = "http://127.0.0.1:" + server.address().port;
  const setup = await fetch(base + "/api/setup", {
    method: "POST",
    body: JSON.stringify({ password: "correct horse battery staple" }),
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get("set-cookie").split(";", 1)[0];
  const response = await fetch(base + "/api/music/play", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      track: {
        id: "qingtian",
        sourceId: "test",
        title: "晴天",
        artist: "周杰伦",
        playUrl: signed,
      },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(body.includes("vkey"), false);
  assert.equal(body.includes("/audio/"), false);
  assert.equal(deliveries.length, 1);
  const saved = await readFile(join(dataDir, "state.json"), "utf8");
  assert.equal(saved.includes("vkey"), false);
  assert.equal(saved.includes(deliveries[0]), false);
});
