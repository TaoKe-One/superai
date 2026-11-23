import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlaybackService } from "../src/playback/service.ts";
import { JsonStore } from "../src/storage/store.ts";

const tracks = ["first", "second", "third"].map((id) => ({
  id,
  sourceId: "test",
  title: id,
  artist: "fixture",
  playUrl: "https://media.example/" + id + ".mp3",
}));

async function setup(t, initialIndex, hardware, durationSeconds) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const directory = await mkdtemp(join(tmpdir(), "speaker-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.init();
  await store.update((state) => {
    state.config.selectedDeviceId = "fixture";
    if (hardware)
      state.config.devices = [
        {
          deviceId: "fixture",
          hardware,
          model: hardware,
          name: "fixture",
          presence: "online",
        },
      ];
  });
  const calls = [];
  let status,
    fail = false;
  let resolver = (track) => track.playUrl;
  const playback = new PlaybackService(
    store,
    {
      async execute(device, command, args) {
        assert.equal(device, "fixture");
        calls.push(command === "play" ? new URL(args.url).pathname : command);
        if (fail) throw new Error("uncertain delivery");
        return { success: true };
      },
      getPlaybackStatus() {
        return Promise.resolve(status);
      },
    },
    (track) => resolver(track),
  );
  await playback.replaceAndPlay(
    "fixture",
    tracks.map((track) => ({ ...track, durationSeconds })),
    initialIndex,
  );
  function sample(position, state = 1, elapsedMs = 3000, detail = {}) {
    t.mock.timers.tick(elapsedMs);
    status = {
      status: state,
      position,
      hasPosition: true,
      duration: 12,
      sampledAt: Date.now(),
      ...detail,
    };
    return playback.checkPlayback();
  }
  async function nearEnd() {
    await sample(3);
    await sample(7);
    await sample(10);
  }
  return {
    playback,
    calls,
    sample,
    nearEnd,
    store,
    fail: () => {
      fail = true;
    },
    resolveWith: (fn) => {
      resolver = fn;
    },
  };
}

for (const [mode, initial, expected] of [
  ["order", 0, "/second.mp3"],
  ["order", 2, "stop"],
  ["loop", 2, "/first.mp3"],
  ["single", 1, "/second.mp3"],
  ["random", 1, null],
]) {
  test(
    mode + " handles firmware repeat at queue index " + initial,
    async (t) => {
      const { playback, calls, sample, nearEnd } = await setup(t, initial);
      await nearEnd();
      await playback.setMode(mode);
      await Promise.all([
        sample(1),
        playback.checkPlayback(),
        playback.checkPlayback(),
      ]);
      assert.equal(calls.length, 2);
      if (expected) assert.equal(calls[1], expected);
      else assert.ok(["/first.mp3", "/third.mp3"].includes(calls[1]));
      if (expected !== "stop") {
        assert.equal(
          playback.queue().tracks[playback.queue().currentIndex].id,
          calls[1].slice(1, -4),
        );
      }
      await playback.checkPlayback();
      assert.equal(calls.length, 2);
    },
  );
}

test("a stopped report after the end advances without a final position", async (t) => {
  const { calls, sample, nearEnd } = await setup(t, 0);
  await nearEnd();
  await sample(0, 0, 3000, { hasPosition: false, duration: 0 });
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3"]);
});

test("L05C reset to paused at the end advances the queue in order", async (t) => {
  const { playback, calls, sample, nearEnd } = await setup(t, 0);
  await nearEnd();
  await sample(0, 2);
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3"]);
  assert.equal(playback.queue().currentIndex, 1);
});

test("OH2 with consecutive all-zero samples advances by the track duration", async (t) => {
  const { playback, calls, sample } = await setup(t, 0, "OH2", 75);
  await sample(0, 0, 3000, { duration: 0 });
  await sample(0, 0, 71_999, { duration: 0, hasPosition: false });
  assert.equal(playback.autoPlayback.active, true);
  assert.deepEqual(calls, ["/first.mp3"]);
  await sample(0, 0, 1, { duration: 0 });
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3"]);
  assert.equal(playback.queue().currentIndex, 1);
  await sample(0, 0, 3000, { duration: 0 });
  await sample(0, 0, 72_000, { duration: 0 });
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3", "/third.mp3"]);
  await sample(0, 0, 3000, { duration: 0 });
  await sample(0, 0, 72_000, { duration: 0 });
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3", "/third.mp3", "stop"]);
  assert.equal(playback.autoPlayback.active, false);
});

for (const [name, hardware, duration, control] of [
  ["another model", "L05C", 75],
  ["missing duration", "OH2", undefined],
  ["manual pause", "OH2", 75, "pause"],
  ["valid device progress", "OH2", 75, "progress"],
]) {
  test(
    "idle reports do not force an estimated switch with " + name,
    async (t) => {
      const { playback, calls, sample } = await setup(t, 0, hardware, duration);
      await sample(0, 0, 3000, { duration: 0 });
      if (control === "pause") await playback.deviceControl("fixture", "pause");
      if (control === "progress") await sample(8, 1, 5000, { duration: 180 });
      await sample(0, 0, 80_000, { duration: 0, hasPosition: false });
      assert.deepEqual(
        calls,
        control === "pause" ? ["/first.mp3", "pause"] : ["/first.mp3"],
      );
      assert.equal(playback.queue().currentIndex, 0);
    },
  );
}

test("speech pauses music across clarification, resumes the same track, and keeps advancing", async (t) => {
  const { playback, calls, sample, nearEnd } = await setup(t, 0);
  await sample(3, 1, 3000, { mediaId: "original" });
  await playback.speak("fixture", "哪一位歌手？", {}, true);
  await sample(3, 2, 4000, { mediaId: "original" });
  assert.deepEqual(calls, ["/first.mp3", "pause", "tts"]);
  await playback.speak("fixture", "这是最终回答。");
  await sample(3, 2, 10_000, { mediaId: "original" });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["/first.mp3", "pause", "tts", "tts", "resume"]);
  assert.equal(playback.history().length, 1);
  await nearEnd();
  await sample(0, 2);
  assert.equal(playback.queue().currentIndex, 1);
  assert.equal(calls.at(-1), "/second.mp3");
});

test("an explicit pause cancels automatic resume after speech", async (t) => {
  const { playback, calls, sample } = await setup(t, 0);
  await sample(3, 1, 3000, { mediaId: "original" });
  await playback.speak("fixture", "这是回答。");
  await playback.deviceControl("fixture", "pause");
  await sample(3, 2, 10_000, { mediaId: "original" });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["/first.mp3", "pause", "tts", "pause"]);
});

test("pause suppresses completion, resume re-arms it, and stop disarms the queue", async (t) => {
  const { playback, calls, sample, nearEnd } = await setup(t, 0);
  await nearEnd();
  await playback.deviceControl("fixture", "pause");
  await sample(0, 0);
  assert.deepEqual(calls, ["/first.mp3", "pause"]);
  await playback.deviceControl("fixture", "resume");
  await sample(10);
  await sample(1);
  await playback.deviceControl("fixture", "stop");
  await nearEnd();
  await sample(1);
  assert.deepEqual(calls, [
    "/first.mp3",
    "pause",
    "resume",
    "/second.mp3",
    "stop",
  ]);
});

test("an early rewind, a stale sample, and a change to external media do not advance", async (t) => {
  const { calls, sample } = await setup(t, 0);
  await sample(3, 1, 3000, { mediaId: "pushed" });
  await sample(0, 1, 3000, { mediaId: "pushed" });
  await sample(10, 1, 3000, { mediaId: "pushed" });
  await sample(0, 0, 19_000, { mediaId: "pushed" });
  await sample(10, 1, 3000, { mediaId: "pushed" });
  await sample(1, 1, 3000, { mediaId: "external" });
  assert.deepEqual(calls, ["/first.mp3"]);
});

test("a failed automatic cast is not retried or recorded in queue history", async (t) => {
  const { playback, calls, sample, nearEnd, fail } = await setup(t, 0);
  await nearEnd();
  fail();
  await sample(1);
  assert.equal(playback.queue().currentIndex, 0);
  assert.equal(playback.history().length, 1);
  assert.equal(playback.autoPlayback.active, false);
  assert.match(playback.autoPlayback.error, /自动续播失败/);
  await nearEnd();
  await sample(1);
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3"]);
});

test("manual next can leave the current track in single-repeat mode", async (t) => {
  const { playback, calls } = await setup(t, 0);
  await playback.setMode("single");
  await playback.control("fixture", "next");
  assert.deepEqual(calls, ["/first.mp3", "/second.mp3"]);
});

test("pause during automatic URL resolution cancels the pending cast", async (t) => {
  const { playback, calls, sample, nearEnd, resolveWith } = await setup(t, 0);
  await nearEnd();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  resolveWith(async (track) => {
    entered.resolve();
    await release.promise;
    return track.playUrl;
  });
  const advancing = sample(1);
  await entered.promise;
  const pausing = playback.deviceControl("fixture", "pause");
  release.resolve();
  await Promise.all([advancing, pausing]);
  assert.deepEqual(calls, ["/first.mp3", "pause"]);
  assert.equal(playback.queue().currentIndex, 0);
});

test("new playback invalidates an earlier in-flight status sample", async (t) => {
  const { playback, calls, sample, nearEnd, resolveWith } = await setup(t, 0);
  await nearEnd();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let first = true;
  resolveWith(async (track) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return track.playUrl;
  });
  const advancing = sample(1);
  await entered.promise;
  const manual = playback.playIndex("fixture", 2, tracks[2]);
  release.resolve();
  await Promise.all([advancing, manual]);
  assert.deepEqual(calls, ["/first.mp3", "/third.mp3"]);
  assert.equal(playback.queue().currentIndex, 2);
});

test("clearing the queue and switching devices reject a pending natural-end result", async (t) => {
  const { playback, calls, sample, nearEnd, store } = await setup(t, 0);
  await nearEnd();
  await store.update((state) => {
    state.config.selectedDeviceId = "other";
  });
  await sample(1);
  await store.update((state) => {
    state.config.selectedDeviceId = "fixture";
  });
  await sample(10);
  await sample(1);
  assert.deepEqual(calls, ["/first.mp3"]);
  await playback.replaceAndPlay("fixture", tracks);
  await nearEnd();
  await playback.clearQueue();
  await sample(1);
  assert.deepEqual(calls, ["/first.mp3", "/first.mp3"]);
});

test("unknown duration and a paused-at-end device do not cause an automatic cast", async (t) => {
  const { calls, sample } = await setup(t, 0);
  await sample(3, 1, 3000, { duration: 0 });
  await sample(10, 1, 3000, { duration: 0 });
  await sample(0, 1, 3000, { duration: 0 });
  await sample(10);
  await sample(12, 2);
  await sample(0, 2);
  assert.deepEqual(calls, ["/first.mp3"]);
});
