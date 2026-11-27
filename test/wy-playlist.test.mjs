import test from "node:test";
import assert from "node:assert/strict";
import { LxCatalog } from "../src/music/lx/catalog.ts";

test("NetEase playlist detail loads every track when the web endpoint embeds only a preview", async () => {
  const songs = [5, 7].map((id) => ({ id, name: "Song " + id, dt: 1000 }));
  const privileges = songs.map(({ id }) => ({ id }));
  const requests = [];
  const catalog = new LxCatalog(async (url) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === "/api/linux/forward") return new Response("", { status: 502 });
    if (path === "/weapi/v3/playlist/detail")
      return Response.json({
        code: 200,
        playlist: {
          name: "Playlist",
          creator: { nickname: "Author" },
          playCount: 1,
          trackIds: songs.map(({ id }) => ({ id })),
          tracks: songs.slice(0, 1),
        },
        privileges: privileges.slice(0, 1),
      });
    assert.equal(path, "/weapi/v3/song/detail");
    return Response.json({ code: 200, songs, privileges });
  });
  const result = await catalog.call("wy", "list", "getListDetail", "42", 1);
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.list.map((track) => track.songmid),
    [5, 7],
  );
  assert.deepEqual(requests, [
    "/weapi/v3/playlist/detail",
    "/weapi/v3/song/detail",
  ]);
});

test("NetEase accepts a share link and retains its cookie across retries only for that playlist", async () => {
  let detailCalls = 0;
  const shareRequests = [];
  const cookies = [];
  const catalog = new LxCatalog(async (url, options) => {
    const target = new URL(url);
    if (target.hostname === "163cn.tv") {
      shareRequests.push(url);
      const result = new Response("");
      Object.defineProperty(result, "url", {
        value: "https://music.163.com/playlist?id=42",
      });
      return result;
    }
    assert.equal(target.pathname, "/weapi/v3/playlist/detail");
    cookies.push(options.headers.Cookie);
    if (++detailCalls === 1) return new Response("", { status: 502 });
    return Response.json({
      code: 200,
      playlist: { name: "Playlist", creator: {}, trackIds: [] },
      privileges: [],
    });
  });
  await catalog.call(
    "wy",
    "list",
    "getListDetail",
    "https://163cn.tv/example###fixture-token",
    1,
  );
  await catalog.call("wy", "list", "getListDetail", "42", 1);
  assert.deepEqual(shareRequests, ["https://163cn.tv/example"]);
  assert.deepEqual(cookies, [
    "MUSIC_U=fixture-token",
    "MUSIC_U=fixture-token",
    "MUSIC_U=",
  ]);
});

test("NetEase returns the requested page in playlist order for both preview and full responses", async () => {
  const songs = Array.from({ length: 1002 }, (_, i) => ({
    id: i + 1,
    name: "Song " + (i + 1),
    dt: 1000,
  }));
  const trackIds = songs.map(({ id }) => ({ id }));
  let metadataCalls = 0;
  for (const preview of [true, false]) {
    const catalog = new LxCatalog(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/weapi/v3/playlist/detail") {
        // The preview may have fewer tracks even when privileges cover the whole list.
        const tracks = preview ? songs.slice(0, 1) : songs;
        return Response.json({
          code: 200,
          playlist: { name: "Playlist", creator: {}, trackIds, tracks },
          privileges: trackIds,
        });
      }
      assert.equal(path, "/weapi/v3/song/detail");
      metadataCalls++;
      const pageSongs = songs.slice(-2).reverse();
      return Response.json({
        code: 200,
        songs: pageSongs,
        privileges: pageSongs.map(({ id }) => ({ id })),
      });
    });
    const second = await catalog.call("wy", "list", "getListDetail", "42", 2);
    assert.equal(second.total, 1002);
    assert.deepEqual(
      second.list.map((track) => track.songmid),
      [1001, 1002],
    );
    const third = await catalog.call("wy", "list", "getListDetail", "42", 3);
    assert.deepEqual(third.list, []);
  }
  assert.equal(metadataCalls, 1);
});
