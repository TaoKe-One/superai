import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JsonStore } from "../src/storage/store.ts";
import { createAppServer, executeAssistant } from "../src/server.ts";
import { MusicServices } from "../src/music/library/service.ts";
import {
  LibraryAdapter,
  libraryFingerprint,
} from "../src/music/library/adapters.ts";
import { normalizeMusicServices } from "../src/music/library/config.ts";
import {
  aiDraft,
  listAiModels,
  testAi,
  nativeSearch,
} from "../src/assistant/providers.ts";
import { PlaybackService } from "../src/playback/service.ts";
import { LxMusicService } from "../src/music/lx/service.ts";
import { catalogFixture, lxFixtureScript } from "./helpers/lx-fixture.mjs";

const json = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
const audio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20000)]);
const library = (type = "subsonic", overrides = {}) => ({
  id: "home",
  name: "私人音乐库",
  type,
  baseUrl: "http://library.example/music",
  username: "test-user",
  password: "private-password",
  accessCode: "",
  enabled: true,
  ...overrides,
});
const song = {
  id: "song-1",
  title: "晴天",
  artist: "周杰伦",
  album: "叶惠美",
  duration: 269,
  coverArt: "cover-1",
};
const sr = (value) =>
  json({ "subsonic-response": { status: "ok", version: "1.16.1", ...value } });
async function storeFor(t, type = "subsonic") {
  const directory = await mkdtemp(join(tmpdir(), "speaker-services-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.init();
  await store.update((s) => {
    s.config.musicServices = normalizeMusicServices(
      {
        mode: "private",
        gatewayBaseUrl: "http://192.168.1.20:8787",
        libraries: [library(type)],
      },
      s.config.musicServices,
      store,
    );
  });
  return { store, directory };
}
async function serve(t, directory, fetchImpl) {
  const server = await createAppServer({ dataDir: directory, fetchImpl });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const setup = await fetch(origin + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "services-browser-test-only" }),
  });
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const call = async (path, method = "GET", body) => {
    const r = await fetch(origin + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  return { server, origin, cookie, call };
}

test("Subsonic signs each request, paginates and uses playlist/lyrics endpoints without exposing auth", async () => {
  const calls = [];
  const adapter = new LibraryAdapter(library(), async (input) => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(
      url.searchParams.get("t"),
      createHash("md5")
        .update("private-password" + url.searchParams.get("s"))
        .digest("hex"),
    );
    assert.equal(url.search.includes("private-password"), false);
    const method = url.pathname.split("/").at(-1);
    if (method === "search3") {
      assert.equal(url.searchParams.get("songOffset"), "50");
      return sr({ searchResult3: { song: [song] } });
    }
    if (method === "getPlaylist") return sr({ playlist: { entry: [song] } });
    if (method === "getLyricsBySongId")
      return sr({
        lyricsList: {
          structuredLyrics: [
            { synced: true, line: [{ start: 1200, value: "故事的小黄花" }] },
          ],
        },
      });
    return sr({});
  });
  const result = await adapter.search("晴天", 2);
  assert.equal(result.items[0].library.providerId, "home");
  assert.equal(JSON.stringify(result).includes("private-password"), false);
  assert.equal(
    (await adapter.collectionTracks("playlists", "commute")).items[0].title,
    "晴天",
  );
  assert.match(
    await adapter.lyric(result.items[0]),
    /\[00:01.20\]故事的小黄花/,
  );
  const up = await adapter.upstream("song-1");
  assert.equal(up.url.searchParams.has("f"), false);
  assert.equal(up.url.searchParams.get("format"), "mp3");
  assert.notEqual(
    calls[0].searchParams.get("s"),
    calls[1].searchParams.get("s"),
  );
});

test("private artist search is paged and large discographies only fetch the requested track page", async (t) => {
  const { directory } = await storeFor(t);
  const fetched = [];
  const api = await serve(t, directory, async (input) => {
    const url = new URL(input);
    const method = url.pathname.split("/").at(-1);
    if (method === "getArtists")
      return new Response("large artist index", {
        headers: { "content-length": "100000000" },
      });
    if (method === "search3") {
      assert.equal(url.searchParams.get("artistCount"), "51");
      assert.equal(url.searchParams.get("songCount"), "0");
      assert.equal(url.searchParams.get("albumCount"), "0");
      const offset = Number(url.searchParams.get("artistOffset"));
      const count = url.searchParams.get("query")
        ? 1
        : Math.min(51, 57 - offset);
      return sr({
        searchResult3: {
          artist: Array.from({ length: count }, (_, i) => ({
            id: "artist-" + (offset + i),
            name: url.searchParams.get("query") || "歌手 " + (offset + i),
          })),
        },
      });
    }
    if (method === "getArtist")
      return sr({
        artist: {
          album: Array.from({ length: 56 }, (_, i) => ({
            id: "album-" + i,
            songCount: i === 0 ? undefined : 10,
          })),
        },
      });
    assert.equal(method, "getAlbum");
    const album = Number(url.searchParams.get("id").slice("album-".length));
    fetched.push(album);
    return sr({
      album: {
        song: Array.from({ length: 10 }, (_, i) => ({
          ...song,
          id: "song-" + (album * 10 + i),
        })),
      },
    });
  });
  const browse = (body) =>
    api.call("/api/music/services/browse", "POST", {
      providerId: "home",
      kind: "artists",
      ...body,
    });
  const first = await browse({});
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.hasMore, true);
  const next = await browse({ page: 2 });
  assert.equal(next.body.items.length, 7);
  assert.equal(next.body.items[0].id, "artist-50");
  assert.equal(next.body.hasMore, false);
  const search = await browse({ query: " 周杰伦 " });
  assert.equal(search.status, 200);
  assert.equal(search.body.items[0].name, "周杰伦");
  const collectionId = search.body.items[0].id;
  const page = await browse({ collectionId });
  assert.equal(page.status, 200);
  assert.equal(page.body.items.at(-1).id, "song-49");
  assert.equal(page.body.hasMore, true);
  assert.ok(fetched.length < 12);
  fetched.length = 0;
  const pageTwo = await browse({ collectionId, page: 2 });
  assert.equal(pageTwo.status, 200);
  assert.equal(pageTwo.body.items[0].id, "song-50");
  assert.equal(pageTwo.body.items.at(-1).id, "song-99");
});

test("Feiniu hashes password, uses music-token cookies and reads actual playlist detail", async () => {
  let logins = 0;
  const paths = [];
  const adapter = new LibraryAdapter(
    library("feiniu", { accessCode: "access-code" }),
    async (input, opts) => {
      const u = new URL(input);
      paths.push(u.pathname);
      if (u.pathname === "/access_code_verify") {
        assert.equal(
          opts.headers["x-access-code"],
          Buffer.from("access-code").toString("base64"),
        );
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": "os-access-code=fixture; Path=/; HttpOnly" },
        });
      }
      if (u.pathname.endsWith("password-login")) {
        logins++;
        const b = JSON.parse(opts.body);
        assert.equal(
          b.password,
          createHash("sha256").update("private-password").digest("hex"),
        );
        assert.equal(opts.headers.cookie, "os-access-code=fixture");
        return json({ code: 0, data: { userToken: "test-token" } });
      }
      assert.match(opts.headers.cookie, /music-token=test-token/);
      if (u.pathname.endsWith("/track/playlist-detail/list")) {
        assert.equal(u.searchParams.get("playlistGUID"), "playlist-1");
        return json({
          code: 0,
          data: {
            list: [
              {
                guid: "one",
                title: "晴天",
                artists: [{ name: "周杰伦" }],
                duration: 269000,
              },
            ],
            total: 1,
          },
        });
      }
      if (u.pathname.endsWith("/lyric/list"))
        return json({ code: 0, data: { list: [{ content: "[00:01]歌词" }] } });
      return json({ code: 0, data: {} });
    },
  );
  const result = await adapter.collectionTracks("playlists", "playlist-1");
  assert.equal(result.items[0].durationSeconds, 269);
  assert.equal(await adapter.lyric(result.items[0]), "[00:01]歌词");
  assert.equal(logins, 1);
  const upstream = await adapter.upstream("one");
  assert.equal(upstream.url.searchParams.get("guid"), "one");
  assert.equal(upstream.url.search.includes("token"), false);
  assert.equal(
    paths.some((p) => p.endsWith("/track/list")),
    false,
  );
});

const davXml = (entries) =>
  '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
  entries
    .map(
      (e) =>
        "<d:response><d:href>" +
        e.href +
        "</d:href><d:propstat><d:prop><d:resourcetype>" +
        (e.dir ? "<d:collection/>" : "") +
        "</d:resourcetype><d:getetag>" +
        (e.etag || "v1") +
        "</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
    )
    .join("") +
  "</d:multistatus>";
test("WebDAV keeps mount path, scans safely and serves folder collections and sidecar lyrics", async () => {
  const paths = [];
  const adapter = new LibraryAdapter(
    library("webdav", { baseUrl: "http://library.example/dav/music" }),
    async (input, opts) => {
      const u = new URL(input);
      paths.push(u.pathname);
      assert.equal(
        opts.headers.authorization,
        "Basic " + Buffer.from("test-user:private-password").toString("base64"),
      );
      if (opts.method === "PROPFIND")
        return new Response(
          davXml(
            u.pathname.endsWith("/album/")
              ? [
                  { href: "/dav/music/album/", dir: true },
                  {
                    href: "/dav/music/album/%E5%91%A8%E6%9D%B0%E4%BC%A6%20-%20%E6%99%B4%E5%A4%A9.mp3",
                  },
                ]
              : [
                  { href: "/dav/music/", dir: true },
                  { href: "/dav/music/album/", dir: true },
                ],
          ),
          { status: 207 },
        );
      if (u.pathname.endsWith(".lrc")) return new Response("[00:01]歌词");
      return new Response(audio, { status: 206 });
    },
  );
  const index = await adapter.scan(
    undefined,
    new AbortController().signal,
    () => {},
  );
  assert.equal(index.tracks.length, 1);
  assert.equal(index.tracks[0].title, "晴天");
  assert.equal(index.tracks[0].artist, "周杰伦");
  assert.equal((await adapter.search("周杰伦 晴天", 1, index)).items.length, 1);
  const lists = await adapter.collections("playlists", 1, index);
  assert.equal(lists.items[0].name, "album");
  assert.equal(
    (await adapter.collectionTracks("playlists", lists.items[0].id, 1, index))
      .items.length,
    1,
  );
  assert.match(await adapter.lyric(index.tracks[0]), /歌词/);
  assert.ok(paths.every((p) => p.startsWith("/dav/music/")));
  await assert.rejects(
    adapter.upstream(Buffer.from("../secret.mp3").toString("base64url")),
    /路径无效/,
  );
});
test("WebDAV rejects external href and XML entities instead of requesting them", async () => {
  for (const xml of [
    davXml([{ href: "https://evil.example/private.mp3" }]),
    '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><multistatus/>',
  ]) {
    let count = 0;
    const a = new LibraryAdapter(library("webdav"), async () => {
      count++;
      return new Response(xml, { status: 207 });
    });
    await assert.rejects(
      a.scan(undefined, new AbortController().signal, () => {}),
    );
    assert.equal(count, 1);
  }
});

test("private mode blocks LX search, health checks and replay of saved online tracks", async (t) => {
  const { store, directory } = await storeFor(t);
  let upstream = 0;
  const fetchImpl = async (input) => {
    const u = new URL(input);
    assert.equal(u.hostname, "library.example");
    upstream++;
    return sr({ searchResult3: { song: [song] } });
  };
  const music = new MusicServices(store, fetchImpl);
  const result = await music.search({ title: "晴天" });
  assert.equal(result.tracks[0].sourceId, "library:home");
  const api = await serve(t, directory, fetchImpl);
  const before = upstream;
  for (const path of [
    "/api/lx/catalog",
    "/api/lx/sources/check",
    "/api/lx/sources/test",
  ]) {
    const r = await api.call(path, "POST", {
      operation: "search",
      keyword: "晴天",
      id: "fake",
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /私人音乐库/);
  }
  assert.equal(upstream, before);
  const online = {
    id: "online",
    sourceId: "lx-wy",
    title: "晴天",
    artist: "周杰伦",
    lx: { platform: "wy", songInfo: { songmid: "online" } },
  };
  await store.update((s) => {
    s.config.favorites = [{ ...online, playUrl: "" }];
  });
  let commands = 0;
  const playback = new PlaybackService(
    store,
    {
      execute: async () => {
        commands++;
      },
    },
    (track) => music.resolvePlayback(track),
  );
  await assert.rejects(
    playback.playSavedTrack(
      "favorites",
      { id: online.id, sourceId: online.sourceId },
      "speaker",
    ),
    /仅使用私人音乐库/,
  );
  assert.equal(commands, 0);
});

test("private songs round-trip through the LX playlist and queue APIs", async (t) => {
  const { directory } = await storeFor(t);
  const api = await serve(t, directory, async () =>
    sr({ searchResult3: { song: [song] } }),
  );
  const track = {
    id: "song-1",
    sourceId: "library:home",
    title: "晴天",
    artist: "周杰伦",
    library: { providerId: "home", trackId: "song-1" },
  };
  const saved = await api.call("/api/lx/playlists", "POST", {
    name: "私人收藏",
    songs: [track],
  });
  assert.equal(saved.status, 200);
  const list = await api.call("/api/lx/playlist?id=" + saved.body.id);
  assert.deepEqual(list.body.songs[0].library, track.library);
  assert.equal(list.body.songs[0].sourceId, track.sourceId);
  const queued = await api.call("/api/lx/player/queue", "POST", {
    operation: "append",
    tracks: list.body.songs,
  });
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.body.playbackQueue.tracks[0].library, track.library);
});

test("hybrid search keeps private hits and reports private outages without contacting LX", async (t) => {
  const { store } = await storeFor(t);
  await store.update((s) => {
    s.config.musicServices.mode = "hybrid";
  });
  let calls = 0;
  const fetchImpl = async (input) => {
    assert.equal(new URL(input).hostname, "library.example");
    calls++;
    return sr({ searchResult3: { song: [song] } });
  };
  const result = await new MusicServices(store, fetchImpl).search({
    title: "晴天",
  });
  assert.equal(result.tracks.length, 1);
  assert.equal(calls, 1);
  // A different store avoids reusing an adapter from the successful request.
  const next = await storeFor(t);
  await next.store.update((s) => {
    s.config.musicServices.mode = "hybrid";
  });
  const failed = await new MusicServices(next.store, async () => {
    throw Error("private offline");
  }).search({ title: "晴天" });
  assert.equal(failed.tracks.length, 0);
  assert.equal(failed.sourceErrors.length, 1);
});
test("hybrid empty private results can fall back to the configured LX source", async (t) => {
  const { store } = await storeFor(t);
  await store.update((s) => {
    s.config.musicServices.mode = "hybrid";
  });
  const fetchImpl = async (input, options) => {
    const u = new URL(input);
    if (u.hostname === "library.example")
      return sr({ searchResult3: { song: [] } });
    return json(catalogFixture(input, options));
  };
  await new LxMusicService(store, fetchImpl).importScript(lxFixtureScript);
  const result = await new MusicServices(store, fetchImpl).search({
    title: "晴天",
  });
  assert.ok(result.tracks.length > 0);
  assert.ok(result.tracks.every((t) => t.lx));
});

test("private media grants support authenticated Range, HEAD, expiry and revocation", async (t) => {
  const { store, directory } = await storeFor(t);
  const calls = [];
  const fetchImpl = async (input, opts) => {
    const u = new URL(input);
    calls.push({ u, opts });
    assert.equal(u.hostname, "library.example");
    if (u.pathname.endsWith("/stream")) {
      assert.ok(u.searchParams.get("t"));
      const range = new Headers(opts.headers).get("range");
      if (opts.method === "HEAD")
        return new Response(null, {
          headers: {
            "content-type": "audio/mpeg",
            "content-length": "20003",
            "accept-ranges": "bytes",
          },
        });
      return new Response(
        range === "bytes=4-9" ? Buffer.from("abcdef") : audio,
        {
          status: 206,
          headers: {
            "content-type": "audio/mpeg",
            "accept-ranges": "bytes",
            "content-range":
              range === "bytes=4-9" ? "bytes 4-9/20003" : "bytes 0-20002/20003",
          },
        },
      );
    }
    return sr({});
  };
  const music = new MusicServices(store, fetchImpl),
    track = {
      id: "song-1",
      sourceId: "library:home",
      title: "晴天",
      artist: "周杰伦",
      library: { providerId: "home", trackId: "song-1" },
    };
  const resolved = await music.resolvePlayback(track);
  assert.equal(resolved.url.includes("private-password"), false);
  assert.equal(resolved.url.includes("test-user"), false);
  assert.equal(new URL(resolved.url).search, "");
  const api = await serve(t, directory, fetchImpl),
    path = new URL(resolved.url).pathname;
  const r = await fetch(api.origin + path, { headers: { range: "bytes=4-9" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 4-9/20003");
  assert.equal(await r.text(), "abcdef");
  const head = await fetch(api.origin + path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "20003");
  assert.equal(await head.text(), "");
  assert.equal(
    (await fetch(api.origin + path.replace(/\/audio.mp3$/, "x/audio.mp3")))
      .status,
    404,
  );
  const parts = path.split("/");
  parts[5] = "1000000000";
  assert.equal((await fetch(api.origin + parts.join("/"))).status, 403);
  const status = (await api.call("/api/status")).body;
  const cfg = status.musicServices;
  cfg.libraries[0].enabled = false;
  cfg.libraries[0].password = "";
  cfg.libraries[0].accessCode = "";
  assert.equal(
    (await api.call("/api/settings", "PUT", { musicServices: cfg })).status,
    200,
  );
  assert.equal((await fetch(api.origin + path)).status, 403);
});
test("private audio preflight rejects HTML before changing queue or commanding the speaker", async (t) => {
  const { store } = await storeFor(t);
  const music = new MusicServices(
    store,
    async () =>
      new Response("<html>login</html>", {
        headers: { "content-type": "text/html" },
      }),
  );
  let commands = 0;
  const playback = new PlaybackService(
    store,
    { execute: async () => commands++ },
    (track) => music.resolvePlayback(track),
  );
  const track = {
    id: "song-1",
    sourceId: "library:home",
    title: "晴天",
    artist: "周杰伦",
    library: { providerId: "home", trackId: "song-1" },
  };
  await assert.rejects(
    playback.replaceAndPlay("speaker", [track]),
    /不是可识别的音频/,
  );
  assert.equal(commands, 0);
  assert.equal(playback.queue().tracks.length, 0);
});
test("library credentials stay encrypted, survive restart, and are not reused for a changed endpoint", async (t) => {
  const { store, directory } = await storeFor(t);
  assert.equal(
    (await readFile(join(directory, "state.json"), "utf8")).includes(
      "private-password",
    ),
    false,
  );
  const saved = store.snapshot().config.musicServices;
  const draft = {
    ...library(),
    password: "",
    baseUrl: "http://different.example",
  };
  const normalized = normalizeMusicServices(
    { mode: "private", gatewayBaseUrl: "", libraries: [draft] },
    saved,
    store,
  );
  assert.equal(normalized.libraries[0].password, "");
  const next = new JsonStore(directory);
  await next.init();
  assert.equal(
    next.decrypt(next.snapshot().config.musicServices.libraries[0].password),
    "private-password",
  );
});

test("model list and model test use draft endpoint and never reuse another endpoint's key", async (t) => {
  const { store } = await storeFor(t);
  await store.update((s) => {
    s.config.ai = {
      provider: "custom",
      baseUrl: "https://model.example/v1",
      apiKey: store.encrypt("saved-key"),
      model: "chosen",
    };
  });
  assert.throws(
    () => aiDraft(store, { baseUrl: "https://other.example/v1" }),
    /服务已切换/,
  );
  const draft = aiDraft(store);
  const calls = [];
  const fetchImpl = async (input, opts) => {
    calls.push(new URL(input).pathname);
    assert.equal(opts.redirect, "error");
    assert.equal(opts.headers.authorization, "Bearer saved-key");
    return String(input).endsWith("/models")
      ? json({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, {}] })
      : json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "play_song",
                  title: "晴天",
                  artist: "周杰伦",
                  confidence: 1,
                }),
              },
            },
          ],
        });
  };
  assert.deepEqual((await listAiModels(draft, fetchImpl)).models, ["a", "b"]);
  assert.equal((await testAi(draft, false, fetchImpl)).intent, true);
  assert.deepEqual(calls, ["/v1/models", "/v1/chat/completions"]);
  await assert.rejects(
    testAi(draft, false, async () =>
      json({ choices: [{ message: { content: "你好" } }] }),
    ),
    /JSON 意图/,
  );
});
test("native OpenAI search requires citations and custom relays do not inherit vendor capabilities", async () => {
  const ai = {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "test-model",
    apiKey: "test",
  };
  const result = await nativeSearch(ai, "今天新闻", async (input, opts) => {
    assert.match(String(input), /\/responses$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.tools[0].type, "web_search");
    return json({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "已查证",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.org/article",
                  title: "来源",
                },
              ],
            },
          ],
        },
      ],
    });
  });
  assert.equal(result.sources.length, 1);
  await assert.rejects(
    nativeSearch(ai, "今天新闻", async () =>
      json({
        output: [{ content: [{ type: "output_text", text: "未经检索" }] }],
      }),
    ),
    /可核实/,
  );
  await assert.rejects(
    nativeSearch(
      { ...ai, baseUrl: "https://relay.example/v1" },
      "今天新闻",
      async () => {
        throw Error("must not call");
      },
    ),
    /未适配/,
  );
});
test("real-time answer does not fall back to an unverified model answer when search fails", async (t) => {
  const { store } = await storeFor(t);
  await store.update((s) => {
    s.config.ai = {
      baseUrl: "https://model.example/v1",
      model: "test",
      apiKey: store.encrypt("key"),
    };
    s.config.webSearch = { mode: "auto", apiKey: store.encrypt("search-key") };
  });
  const result = await executeAssistant(
    "杭州市今天天气如何",
    store,
    { execute: async () => ({}) },
    async (input) => {
      if (new URL(input).hostname === "api.tavily.com")
        throw Error("search offline");
      return json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "answer",
                answer: "今天肯定晴天",
                needsSearch: true,
              }),
            },
          },
        ],
      });
    },
  );
  assert.match(result.message, /没有取得可核实/);
  assert.equal(result.searchUsed, false);
  assert.ok(result.searchError);
  assert.equal(result.message.includes("肯定晴天"), false);
});

test("Qwen Responses extracts action.sources and DeepSeek only enables adapted search models", async () => {
  const qwen = {
    provider: "dashscope",
    baseUrl:
      "https://workspace-demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiKey: "fixture",
  };
  const result = await nativeSearch(qwen, "今天", async (input, options) => {
    assert.match(String(input), /\/compatible-mode\/v1\/responses$/);
    assert.equal(JSON.parse(options.body).tool_choice, "required");
    return json({
      output: [
        {
          type: "web_search_call",
          action: {
            sources: [
              { url: "https://example.org/news", title: "新闻" },
              { url: "javascript:alert(1)" },
            ],
          },
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "查证结果" }],
        },
      ],
    });
  });
  assert.equal(result.sources.length, 1);
  const { nativeSearchProvider } =
    await import("../src/assistant/providers.ts");
  assert.equal(
    nativeSearchProvider({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
    }),
    "deepseek",
  );
  assert.equal(
    nativeSearchProvider({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    }),
    undefined,
  );
  assert.equal(
    nativeSearchProvider({
      ...qwen,
      baseUrl:
        "https://workspace-demo.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1",
    }),
    undefined,
  );
});

test("AI endpoints require admin and switching saved provider clears the previous key", async (t) => {
  const { directory } = await storeFor(t);
  const api = await serve(t, directory, async (input) =>
    String(input).endsWith("/models")
      ? json({ data: [{ id: "available" }] })
      : json({
          choices: [
            {
              message: {
                content:
                  '{"action":"play_song","title":"晴天","artist":"周杰伦"}',
              },
            },
          ],
        }),
  );
  for (const path of ["/api/ai/providers", "/api/ai/models", "/api/ai/test"]) {
    const r = await fetch(api.origin + path, {
      method: path.endsWith("providers") ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: path.endsWith("providers") ? undefined : "{}",
    });
    assert.equal(r.status, 401);
  }
  const ai = {
    provider: "custom",
    baseUrl: "https://model.example/v1",
    model: "available",
    apiKey: "fixture-old-key",
  };
  assert.equal((await api.call("/api/settings", "PUT", { ai })).status, 200);
  assert.deepEqual(
    (await api.call("/api/ai/models", "POST", { ai: { apiKey: "" } })).body
      .models,
    ["available"],
  );
  assert.equal(
    (await api.call("/api/ai/test", "POST", { ai: { apiKey: "" } })).body
      .intent,
    true,
  );
  assert.equal(
    (
      await api.call("/api/settings", "PUT", {
        ai: { ...ai, baseUrl: "https://other.example/v1", apiKey: "" },
      })
    ).status,
    200,
  );
  assert.equal((await api.call("/api/status")).body.ai.keySet, false);
  assert.equal(
    (await api.call("/api/ai/models", "POST", { ai: { apiKey: "" } })).status,
    400,
  );
});

test("built-in MiniMax lists models, tests a draft, and answers with the saved configuration", async (t) => {
  const { directory } = await storeFor(t);
  const requests = [];
  const model = "MiniMax-M3.1-Flash";
  const completion = (content) =>
    json({
      choices: [{ message: { reasoning_content: "内部思考", content } }],
    });
  const api = await serve(t, directory, async (input, opts) => {
    const url = new URL(input);
    if (url.hostname === "api.tavily.com") {
      assert.equal(JSON.parse(opts.body).api_key, "fixture-search");
      return json({
        results: [
          {
            title: "资料",
            content: "模拟天气",
            url: "https://example.org/weather",
          },
        ],
      });
    }
    requests.push(url.pathname);
    assert.equal(url.origin, "https://api.minimax.cn");
    assert.equal(opts.headers.authorization, "Bearer fixture-minimax");
    assert.equal(opts.redirect, "error");
    if (url.pathname === "/v1/models") return json({ data: [{ id: model }] });
    assert.equal(url.pathname, "/v1/chat/completions");
    assert.equal(opts.method, "POST");
    const { messages, ...params } = JSON.parse(opts.body);
    assert.deepEqual(params, {
      model,
      reasoning_split: true,
      reasoning_effort: "low",
    });
    const prompt = messages.at(-1).content;
    if (prompt.includes("搜索材料：")) return completion("据资料，今天有雨。");
    if (prompt === "杭州市今天天气如何")
      return completion(
        JSON.stringify({ action: "answer", needsSearch: true }),
      );
    return completion(
      JSON.stringify({ action: "play_song", title: "晴天", artist: "周杰伦" }),
    );
  });
  const { providers } = (await api.call("/api/ai/providers")).body;
  const preset = providers.find((p) => p.id === "minimax");
  assert.deepEqual(preset, {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.cn/v1",
    defaultModel: model,
    search: false,
  });
  assert.equal(
    (
      await api.call("/api/settings", "PUT", {
        ai: {
          provider: "custom",
          model: "old",
          baseUrl: "https://old.example/v1",
          apiKey: "fixture-old",
        },
      })
    ).status,
    200,
  );
  const ai = {
    provider: preset.id,
    baseUrl: preset.baseUrl + "/chat/completions",
    model,
  };
  const missingKey = await api.call("/api/ai/test", "POST", { ai });
  assert.equal(missingKey.status, 400);
  assert.match(missingKey.body.error, /服务已切换/);
  assert.deepEqual(requests, []);
  ai.apiKey = "fixture-minimax";
  assert.deepEqual(
    (await api.call("/api/ai/models", "POST", { ai })).body.models,
    [model],
  );
  const tested = await api.call("/api/ai/test", "POST", { ai });
  assert.equal(tested.body.intent, true);
  assert.equal(tested.body.nativeSearchAvailable, false);
  assert.equal((await api.call("/api/status")).body.ai.provider, "custom");
  assert.equal(
    (
      await api.call("/api/settings", "PUT", {
        ai,
        webSearch: { mode: "auto", apiKey: "fixture-search" },
      })
    ).status,
    200,
  );
  const saved = (await api.call("/api/status")).body.ai;
  assert.equal(saved.provider, "minimax");
  assert.equal(saved.keySet, true);
  assert.equal(JSON.stringify(saved).includes(ai.apiKey), false);
  const answer = await api.call("/api/assistant/command", "POST", {
    text: "杭州市今天天气如何",
  });
  assert.equal(answer.body.intent.source, "llm");
  assert.equal(answer.body.message, "据资料，今天有雨。");
  assert.equal(answer.body.searchUsed, true);
  assert.deepEqual(requests, [
    "/v1/models",
    ...Array(3).fill("/v1/chat/completions"),
  ]);
});

test("MiniMax request fields are limited to official chat endpoints", async () => {
  const ai = {
    provider: "minimax",
    model: "MiniMax-M3.1-Flash",
    apiKey: "fixture",
  };
  for (const baseUrl of [
    "https://api.minimax.io/v1/",
    "https://api.minimax.cn.example/v1",
  ]) {
    const official = new URL(baseUrl).hostname === "api.minimax.io";
    await assert.rejects(
      testAi({ ...ai, baseUrl }, false, async (input, opts) => {
        assert.equal(input, baseUrl.replace(/\/$/, "") + "/chat/completions");
        const { messages, ...params } = JSON.parse(opts.body);
        assert.equal(messages[0].role, "system");
        assert.deepEqual(
          params,
          official
            ? {
                model: ai.model,
                reasoning_split: true,
                reasoning_effort: "low",
              }
            : { model: ai.model },
        );
        return json({
          choices: [
            {
              message: {
                reasoning_content:
                  '{"action":"play_song","title":"晴天","artist":"周杰伦"}',
                content: "",
              },
            },
          ],
        });
      }),
      /没有返回有效文本/,
    );
  }
});

test("WebDAV scan reuses unchanged ETags and keeps folder groups distinct from album tags", async () => {
  let reads = 0;
  const config = library("webdav");
  const id = Buffer.from("folder/song.mp3").toString("base64url");
  const saved = {
    id,
    sourceId: "library:home",
    library: { providerId: "home", trackId: id },
    title: "标签歌名",
    artist: "标签歌手",
    album: "标签专辑",
  };
  const adapter = new LibraryAdapter(config, async (input, opts) => {
    if (opts.method !== "PROPFIND") {
      reads++;
      return new Response(audio);
    }
    return new Response(
      davXml(
        new URL(input).pathname.endsWith("/folder/")
          ? [
              { href: "/music/folder/", dir: true },
              { href: "/music/folder/song.mp3", etag: "same" },
            ]
          : [
              { href: "/music/", dir: true },
              { href: "/music/folder/", dir: true },
            ],
      ),
      { status: 207 },
    );
  });
  const index = await adapter.scan(
    {
      fingerprint: libraryFingerprint(config),
      scannedAt: 1,
      tracks: [saved],
      etags: { [id]: "same" },
      warnings: 0,
    },
    new AbortController().signal,
    () => {},
  );
  assert.equal(reads, 0);
  assert.equal(index.tracks[0].title, "标签歌名");
  assert.equal(
    (await adapter.collections("playlists", 1, index)).items[0].name,
    "folder",
  );
  assert.equal(
    (await adapter.collections("albums", 1, index)).items[0].name,
    "标签专辑",
  );
});

test("cancelled WebDAV scan keeps the previous saved index and private identities survive restart", async (t) => {
  const { store, directory } = await storeFor(t, "webdav");
  const id = Buffer.from("song.mp3").toString("base64url"),
    track = {
      id,
      sourceId: "library:home",
      library: { providerId: "home", trackId: id },
      title: "晴天",
      artist: "周杰伦",
      playUrl: "",
    };
  await store.update((s) => {
    s.config.libraryIndexes.home = {
      fingerprint: libraryFingerprint(s.config.musicServices.libraries[0]),
      scannedAt: 1,
      tracks: [track],
      warnings: 0,
      etags: { [id]: "v1" },
      fallbackIds: [],
    };
    s.config.favorites = [track];
    s.config.lxPlaylists = [
      {
        id: "list",
        name: "收藏的歌单",
        tracks: [track],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
  });
  const music = new MusicServices(
    store,
    async (_input, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener(
          "abort",
          () => reject(Error("cancelled")),
          { once: true },
        );
      }),
  );
  music.startScan("home");
  music.stopScan("home");
  for (let i = 0; i < 30 && music.scanStatus()[0].state === "running"; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(music.scanStatus()[0].state, "cancelled");
  assert.equal(store.snapshot().config.libraryIndexes.home.scannedAt, 1);
  const next = new JsonStore(directory);
  await next.init();
  assert.equal(next.snapshot().config.favorites[0].library.trackId, id);
  assert.equal(
    next.snapshot().config.lxPlaylists[0].tracks[0].library.providerId,
    "home",
  );
  assert.equal(next.snapshot().config.libraryIndexes.home.etags[id], "v1");
});

test("WebDAV native media gateway actually transcodes FLAC, handles HEAD, and rejects failed decoding", async (t) => {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const { stdout } = await promisify(execFile)(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.3",
      "-f",
      "flac",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  const { store, directory } = await storeFor(t, "webdav");
  let corrupt = false;
  const fetchImpl = async (_input, opts) =>
    new Response(
      opts.method === "HEAD"
        ? null
        : corrupt
          ? Buffer.from("fLaCbroken")
          : stdout,
      { headers: { "content-type": "audio/flac" } },
    );
  const music = new MusicServices(store, fetchImpl),
    id = Buffer.from("sample.flac").toString("base64url");
  const track = {
    id,
    sourceId: "library:home",
    library: { providerId: "home", trackId: id },
    title: "测试音频",
    artist: "测试",
  };
  const resolved = await music.resolvePlayback(track),
    api = await serve(t, directory, fetchImpl),
    path = new URL(resolved.url).pathname;
  const r = await fetch(api.origin + path, { headers: { range: "bytes=2-4" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal(r.headers.get("content-range"), null);
  const mp3 = Buffer.from(await r.arrayBuffer());
  assert.ok(mp3.length > 1000);
  assert.equal(mp3.subarray(0, 3).toString(), "ID3");
  const head = await fetch(api.origin + path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), null);
  assert.equal(await head.text(), "");
  corrupt = true;
  assert.equal((await fetch(api.origin + path)).status, 502);
});
