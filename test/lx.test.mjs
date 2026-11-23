import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLxScript } from "../src/music/lx/runtime.ts";
import {
  abortable,
  publicUrl,
  publicRequest,
  responseBytes,
  isPublicAddress,
  parseDnsAnswers,
} from "../src/music/lx/http.ts";
import { LxCatalog } from "../src/music/lx/catalog.ts";
import {
  fromLxSong,
  toLxSong,
  LxMusicService,
} from "../src/music/lx/service.ts";
import { JsonStore } from "../src/storage/store.ts";
import { PlaybackService } from "../src/playback/service.ts";
import { createAppServer, executeAssistant } from "../src/server.ts";
import { catalogFixture, lxFixtureScript } from "./helpers/lx-fixture.mjs";

const init =
  'lx.send("inited",{sources:{wy:{actions:["musicUrl"],qualitys:["128k","320k"]}}});';
const info = {
  source: "wy",
  action: "musicUrl",
  info: { type: "320k", musicInfo: { songmid: "one" } },
};
const rawSong = {
  source: "wy",
  songmid: "one",
  name: "晴天",
  singer: "周杰伦",
  interval: "04:29",
  types: [{ type: "320k" }],
};
const source =
  "/** @name Test Source */\n" +
  init +
  'lx.on("request",async ({info})=>"https://media.example/"+info.musicInfo.songmid+".mp3?quality="+info.type);';
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "speaker-lx-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(dir);
  await store.init();
  return { store, dir };
}

test("LX script metadata and isolation do not expose Node or credentials", async () => {
  const metadata = await runLxScript(source);
  assert.equal(metadata.name, "Test Source");
  assert.deepEqual(metadata.sources.wy.qualitys, ["128k", "320k"]);
  assert.equal(
    await runLxScript(
      init +
        'lx.on("request",()=>[typeof process,typeof require,typeof fetch].join(","));',
      info,
    ),
    "undefined,undefined,undefined",
  );
  assert.equal(
    await runLxScript(source, info),
    "https://media.example/one.mp3?quality=320k",
  );
});

test("LX async request callback, timers, buffer, crypto and zlib work across the VM boundary", async () => {
  const script =
    init +
    'lx.on("request", async ()=>{' +
    'const b=lx.utils.buffer.from("hello","utf8");' +
    "const compressed=await lx.utils.zlib.deflate(b);" +
    'if(lx.utils.buffer.bufToString(await lx.utils.zlib.inflate(compressed),"utf8")!=="hello")throw Error();' +
    'if(lx.utils.crypto.md5("hello")!=="5d41402abc4b2a76b9719d911017c592")throw Error();' +
    'if(lx.utils.crypto.md5(b)!=="5d41402abc4b2a76b9719d911017c592")throw Error();' +
    "await new Promise(r=>setTimeout(r,1));" +
    'return new Promise((resolve,reject)=>lx.request("https://source.example/url",{method:"POST",form:{id:"one"}},(err,res,body)=>{if(err)return reject(err);if(!(res.raw instanceof Uint8Array)||res.bytes!==res.raw.length||JSON.parse(lx.utils.buffer.bufToString(res.raw,"utf8")).url!==body.url)return reject(Error("raw response"));resolve(body.url)}));});';
  const calls = [];
  const result = await runLxScript(script, info, async (url, options) => {
    calls.push(url);
    assert.equal(options.body.toString(), "id=one");
    return json({ url: "https://media.example/fresh.mp3" });
  });
  assert.equal(result, "https://media.example/fresh.mp3");
  assert.equal(calls.length, 1);
});

test("LX resource failures and cancellation release concurrency slots", async () => {
  await assert.rejects(runLxScript("while(true){}"), /资源限制/);
  await assert.rejects(runLxScript('throw Error("bad");'), /执行失败/);
  await assert.rejects(
    runLxScript(
      init + 'lx.on("request",()=>new Promise(()=>{}));',
      info,
      undefined,
      40,
    ),
    /超时/,
  );
  const hung =
    init +
    'lx.on("request",()=>new Promise((resolve,reject)=>lx.request("https://source.example/hung",{},(e,r,b)=>e?reject(e):resolve(b))));';
  await assert.rejects(
    runLxScript(hung, info, () => new Promise(() => {}), 40),
    /超时/,
  );
  await assert.rejects(
    runLxScript(
      init + 'lx.on("request",()=>new Promise(r=>setTimeout(r,15000)));',
      info,
      undefined,
      40,
    ),
    /超时/,
  );
  await assert.rejects(
    runLxScript('const x=[];while(true)x.push("x".repeat(100000));'),
    /资源限制/,
  );
  assert.equal(
    await runLxScript(
      init +
        'lx.on("request",async()=>{for(let i=0;i<30;i++){clearTimeout(setTimeout(()=>{throw Error("cancel failed")},15000));await new Promise(r=>setTimeout(r,1));}return "cancelled"});',
      info,
    ),
    "cancelled",
  );
  for (let i = 0; i < 6; i++)
    assert.equal((await runLxScript(source)).name, "Test Source");
});

test("encrypted DNS accepts public A records and rejects empty, failed or private answers", () => {
  assert.deepEqual(
    parseDnsAnswers({
      Status: 0,
      Answer: [
        { type: 5, data: "cdn.example" },
        { type: 1, data: "8.8.8.8" },
      ],
    }),
    [{ address: "8.8.8.8", family: 4 }],
  );
  for (const value of [
    { Status: 3, Answer: [] },
    { Status: 0, Answer: [] },
    { Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] },
    {
      Status: 0,
      Answer: [
        { type: 1, data: "8.8.8.8" },
        { type: 1, data: "192.168.1.1" },
      ],
    },
    { Status: 0, Answer: [{ type: 1, data: "198.18.1.1" }] },
    { Status: 0, Answer: [{ type: 1, data: "not-an-ip" }] },
  ])
    assert.throws(() => parseDnsAnswers(value));
});

test("adapted player patches preserve default functions and expose native controls", async () => {
  const code = await readFile(
    new URL("../public/lx/static/js/app.bundle.7abaa0ce.js", import.meta.url),
    "utf8",
  );
  assert.equal(
    code.includes("defauglobalThis"),
    false,
    "Store patch must not corrupt default functions",
  );
  assert.ok(code.includes("default()"));
  assert.ok(code.includes("globalThis.SpeakerLX.player(Vt())"));
  assert.ok(code.includes("globalThis.SpeakerLX.app(lt())"));
  assert.ok(code.includes('aria-label":"展开播放器'));
});

test("repeated remote playlist pages stop early without saving an incomplete list", async (t) => {
  const { store } = await setup(t);
  const lx = new LxMusicService(store);
  let calls = 0;
  lx.catalog.request = async () => {
    calls++;
    return { list: [rawSong], has_more: true, total: 100 };
  };
  await assert.rejects(
    lx.importRemotePlaylist("wy", "repeating", "重复歌单"),
    /重复返回/,
  );
  assert.equal(calls, 2);
  assert.equal(store.snapshot().config.lxPlaylists.length, 0);
});

test("LX network boundary blocks private, credentialed and non-HTTP requests", async () => {
  for (const value of [
    "http://localhost/",
    "http://127.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://user:secret@example.com/",
    "file:///etc/passwd",
  ])
    assert.throws(() => publicUrl(value));
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  await assert.rejects(publicRequest("http://127.0.0.1/"), /私有网络/);
  const timeout = new AbortController();
  const pending = abortable(new Promise(() => {}), timeout.signal);
  timeout.abort(new DOMException("Test timeout", "TimeoutError"));
  await assert.rejects(pending, /超时/);
  const tooLarge = new Response(new Uint8Array(2 * 1024 * 1024 + 1));
  await assert.rejects(
    responseBytes(tooLarge, AbortSignal.timeout(100)),
    /2 MB/,
  );
});

test("LX imported scripts are encrypted; lazy URLs refresh on queue and favorite replay after restart", async (t) => {
  const { store, dir } = await setup(t);
  let resolutions = 0;
  const script =
    "/** @name Resolving source */\n" +
    init +
    'lx.on("request",()=>new Promise((resolve,reject)=>lx.request("https://source.example/url",{},(e,r,b)=>e?reject(e):resolve(b.url))));';
  const network = async () =>
    json({ url: "https://media.example/fresh-" + ++resolutions + ".mp3" });
  const lx = new LxMusicService(store, network);
  await lx.importScript(script);
  await lx.importScript(script);
  assert.equal(lx.sources().length, 1);
  assert.equal("script" in lx.sources()[0], false);
  const played = [];
  const miot = {
    execute: async (_d, _c, args) => {
      played.push(args.url);
    },
  };
  const playback = new PlaybackService(store, miot, (track) =>
    lx.resolveTrack(track),
  );
  const track = fromLxSong(rawSong);
  assert.equal(track.durationSeconds, 269);
  await playback.replaceAndPlay("speaker", [track]);
  await playback.toggleFavorite(track);
  const disk = await readFile(join(dir, "state.json"), "utf8");
  assert.equal(disk.includes("source.example"), false);
  assert.equal(disk.includes("fresh-"), false);
  const reopened = new JsonStore(dir);
  await reopened.init();
  const restored = new LxMusicService(reopened, network);
  await new PlaybackService(reopened, miot, (t) =>
    restored.resolveTrack(t),
  ).playSavedTrack("favorites", track, "speaker");
  assert.deepEqual(played, [
    "https://media.example/fresh-1.mp3",
    "https://media.example/fresh-2.mp3",
  ]);
  assert.equal(toLxSong(track).source_data.songInfo.songmid, "one");
});

test("LX disabled/invalid sources fail honestly and preserve the previous queue", async (t) => {
  const { store } = await setup(t);
  const lx = new LxMusicService(store);
  const imported = await lx.importScript(source);
  const playback = new PlaybackService(
    store,
    { execute: async () => {} },
    (t) => lx.resolveTrack(t),
  );
  const first = fromLxSong(rawSong);
  await playback.replaceAndPlay("speaker", [first]);
  const before = playback.queue();
  await lx.changeSource(imported.id, false);
  await assert.rejects(
    playback.replaceAndPlay("speaker", [
      fromLxSong({ ...rawSong, songmid: "two" }),
    ]),
    /导入支持/,
  );
  assert.deepEqual(playback.queue(), before);
  await lx.changeSource(imported.id, true);
  const failing = new PlaybackService(
    store,
    {
      execute: async () => {
        throw Error("speaker rejected");
      },
    },
    (t) => lx.resolveTrack(t),
  );
  await assert.rejects(
    failing.replaceAndPlay("speaker", [
      fromLxSong({ ...rawSong, songmid: "two" }),
    ]),
    /speaker rejected/,
  );
  assert.deepEqual(playback.queue(), before);
});

test("LX rejects private playback URLs and falls through to the next enabled source", async (t) => {
  const { store } = await setup(t);
  const lx = new LxMusicService(store);
  await lx.importScript(
    "/** @name Private URL source */\n" +
      init +
      'lx.on("request",()=>"http://127.0.0.1/private.mp3");',
  );
  const track = fromLxSong(rawSong);
  await assert.rejects(lx.resolveTrack(track), /均未返回可播放音频/);
  await lx.importScript(source);
  assert.equal(
    await lx.resolveTrack(track),
    "https://media.example/one.mp3?quality=320k",
  );
});

test("LX queue edits allow large inserts and reject stale revisions and removal of the playing track", async (t) => {
  const { store } = await setup(t);
  const playback = new PlaybackService(
    store,
    { execute: async () => {} },
    async () => "https://media.example/song.mp3",
  );
  const tracks = Array.from({ length: 100 }, (_, i) =>
    fromLxSong({ ...rawSong, songmid: String(i) }),
  );
  await playback.replaceAndPlay("speaker", tracks);
  await playback.enqueue([tracks[0]]);
  const q = playback.queue();
  assert.equal(q.tracks.length, 101);
  await assert.rejects(
    playback.editQueue("remove", 0, 0, q.revision),
    /当前正在播放/,
  );
  const moved = await playback.editQueue("move", 0, 5, q.revision);
  assert.equal(moved.currentIndex, 5);
  await assert.rejects(
    playback.editQueue("remove", 1, 0, q.revision),
    /队列已更新/,
  );
});

test("LX playlists deduplicate, import favorites and safely restore direct-URL tracks", async (t) => {
  const { store, dir } = await setup(t);
  const lx = new LxMusicService(store);
  const track = fromLxSong(rawSong);
  const saved = await lx.savePlaylist("Test", [track, track]);
  assert.equal(saved.count, 1);
  assert.equal((await lx.savePlaylist("Test", [track], saved.id)).count, 0);
  await lx.savePlaylist("收藏", [track], "favorites");
  assert.equal(store.snapshot().config.favorites.length, 1);
  await assert.rejects(lx.savePlaylist("Gone", [track], "missing"), /不存在/);
  const direct = {
    id: "direct",
    sourceId: "http",
    title: "Direct",
    artist: "Test",
    playUrl: "https://media.example/private.mp3",
  };
  const list = await lx.savePlaylist("Direct", [direct]);
  const publicTrack = lx.playlistTracks(list.id).tracks[0];
  assert.equal(publicTrack.playUrl, undefined);
  assert.equal(
    lx.requestedTrack(toLxSong(publicTrack)).playUrl,
    direct.playUrl,
  );
  assert.equal(
    (await readFile(join(dir, "state.json"), "utf8")).includes("private.mp3"),
    false,
  );
});

test("official Kuwo catalog normalizes pages without sharing concurrent search state", async () => {
  const fetcher = async (input) => {
    const u = new URL(input);
    const page = Number(u.searchParams.get("pn")) + 1;
    await new Promise((r) => setTimeout(r, page === 1 ? 15 : 1));
    return json({
      TOTAL: 100,
      SHOW: "1",
      abslist: [
        {
          MUSICRID: "MUSIC_" + page,
          SONGNAME: "Song " + page,
          ARTIST: "Artist",
          DURATION: "200",
          N_MINFO: "level:exhigh,bitrate:320,format:mp3,size:8.2Mb",
        },
      ],
    });
  };
  const catalog = new LxCatalog(fetcher);
  const [one, two] = await Promise.all([
    catalog.search("kw", "Song", 1),
    catalog.search("kw", "Song", 2),
  ]);
  assert.equal(one.list[0].songmid, "1");
  assert.equal(two.list[0].songmid, "2");
  assert.equal(two.page, 2);
  assert.equal(one.has_more, true);
  await assert.rejects(catalog.search("kw", "Song", 1, "album"), /专辑/);
});

test("the login, admin and player pages share the public SuperAI icon", async (t) => {
  const { dir } = await setup(t);
  const server = await createAppServer({ dataDir: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const home = await (await fetch(base + "/")).text();
  const player = await (await fetch(base + "/lx/")).text();
  for (const page of [home, player])
    assert.match(page, /rel="icon"[^>]*href="\/superai-icon\.png"/);
  assert.equal(
    home.match(/class="mark"[^>]*src="\/superai-icon\.png"/g)?.length,
    2,
  );
  const icon = await fetch(base + "/superai-icon.png");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  const content = Buffer.from(await icon.arrayBuffer());
  assert.equal(content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(
    (await fetch(base + "/lx/static/icon.27a432e2.svg")).status,
    404,
  );
});

test("native LX routes require authentication and do not expose source scripts", async (t) => {
  const { dir } = await setup(t);
  const server = await createAppServer({ dataDir: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/api/lx/sources")).status, 401);
  for (const [path, method] of [
    ["/sources/check", "POST"],
    ["/sources/check-stop", "POST"],
    ["/sources/check-status", "GET"],
    ["/sources/routing", "PUT"],
    ["/lyrics", "POST"],
    ["/player/browser", "POST"],
    ["/player/detach", "POST"],
  ])
    assert.equal(
      (await fetch(base + "/api/lx" + path, { method })).status,
      401,
      path,
    );
  const admin = await fetch(base + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "lx-test-password-1234" }),
  });
  const cookie = admin.headers.get("set-cookie").split(";")[0];
  const lyrics = await fetch(base + "/api/lx/lyrics", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(lyrics.status, 200);
  assert.equal((await lyrics.json()).reason, "no_metadata");
  const imported = await fetch(base + "/api/lx/sources/import", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ script: source }),
  });
  assert.equal(imported.status, 200);
  const result = await (
    await fetch(base + "/api/status", { headers: { cookie } })
  ).json();
  assert.equal(result.lxSources.length, 1);
  assert.equal(JSON.stringify(result).includes("media.example"), false);
  const frame = await fetch(base + "/lx/");
  assert.match(
    frame.headers.get("content-security-policy"),
    /media-src 'self' https: http:/,
  );
  assert.equal((await fetch(base + "/lx/main.jsc")).status, 404);
});

test("all five official catalog adapters retain source metadata for URL resolution", async () => {
  const catalog = new LxCatalog(async (input) => json(catalogFixture(input)));
  for (const platform of ["wy", "tx", "kg", "kw", "mg"]) {
    const result = await catalog.search(platform, "周杰伦 晴天");
    assert.ok(result.list.length, platform);
    const normalized = fromLxSong(result.list[0], platform);
    assert.equal(normalized.lx.platform, platform);
    assert.equal(normalized.title, "晴天");
    assert.equal(normalized.playUrl, undefined);
  }
});

test("native playlist import and assistant share the LX catalog and lazy playback pipeline", async (t) => {
  const { store } = await setup(t);
  let resolved = 0;
  const network = async (input) =>
    new URL(input).hostname === "source.example"
      ? json({ url: "https://media.example/assistant-" + ++resolved + ".mp3" })
      : new URL(input).hostname === "media.example"
        ? new Response(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100)]))
        : json(catalogFixture(input));
  const lx = new LxMusicService(store, network);
  await lx.importScript(lxFixtureScript);
  const saved = await lx.importRemotePlaylist("wy", "123", "通勤");
  assert.equal(saved.count, 2);
  await store.update((state) => {
    state.config.selectedDeviceId = "speaker";
    state.config.devices = [
      {
        deviceId: "speaker",
        name: "test",
        model: "",
        hardware: "",
        presence: "online",
      },
    ];
  });
  const urls = [];
  const miot = { execute: async (_id, _cmd, args) => urls.push(args.url) };
  const result = await executeAssistant("播放通勤歌单", store, miot, network);
  assert.equal(result.playbackQueue.tracks.length, 2);
  await executeAssistant("下一首", store, miot, network);
  assert.deepEqual(urls, [
    "https://media.example/assistant-1.mp3",
    "https://media.example/assistant-2.mp3",
  ]);
});
