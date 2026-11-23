import assert from "node:assert/strict";
import test from "node:test";
import { selectTrack } from "../src/music/matcher.ts";
import { searchMusic } from "../src/music/search.ts";

const track = (id, title, artist, sourceId = "source") => ({
  id,
  title,
  artist,
  sourceId,
});

test("exact title and artist select the intended recording", () => {
  const result = selectTrack({ title: "晴天", artist: "周杰伦" }, [
    track("cover", "晴天", "翻唱歌手"),
    track("original", "晴天", "周杰伦"),
  ]);
  assert.equal(result.status, "selected");
  assert.equal(result.match.track.id, "original");
});

test("same-title recordings without an artist remain ambiguous", () => {
  const result = selectTrack({ title: "晴天" }, [
    track("a", "晴天", "周杰伦"),
    track("b", "晴天", "其他歌手"),
  ]);
  assert.equal(result.status, "ambiguous");
});

test("search queries built-in sources concurrently and reports partial failures", async () => {
  const sources = [
    {
      id: "catalog",
      async search() {
        return [track("1", "晴天", "周杰伦")];
      },
    },
    {
      id: "offline",
      async search() {
        throw new Error("offline");
      },
    },
  ];
  const result = await searchMusic(
    { title: "晴天", artist: "周杰伦" },
    sources,
  );
  assert.equal(result.selection.status, "selected");
  assert.equal(result.tracks[0].sourceId, "catalog");
  assert.deepEqual(
    result.sourceErrors.map((item) => item.sourceId),
    ["offline"],
  );
});

test("search keeps distinct known albums when another source omits album metadata", async () => {
  const result = await searchMusic({ title: "晴天", artist: "周杰伦" }, [
    {
      id: "catalog",
      async search() {
        return [
          { ...track("one", "晴天", "周杰伦"), album: "叶惠美" },
          track("two", "晴天", "周杰伦"),
          { ...track("three", "晴天", "周杰伦"), album: "现场专辑" },
        ];
      },
    },
  ]);
  assert.equal(result.tracks.length, 3);
  assert.equal(result.selection.status, "ambiguous");
});
