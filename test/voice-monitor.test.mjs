import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceConversationMonitor } from "../src/assistant/voice-monitor.ts";
import { JsonStore } from "../src/storage/store.ts";

test("voice monitor primes old history and dispatches each later utterance once", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "speaker-platform-voice-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.voiceMonitorEnabled = true;
    state.config.selectedDeviceId = "speaker-1";
    state.config.devices = [
      {
        deviceId: "speaker-1",
        name: "客厅",
        model: "LX06",
        hardware: "LX06",
        presence: "online",
      },
    ];
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 60_000,
    };
  });
  let call = 0;
  const miot = {
    async getLatestQuestions() {
      call++;
      return call === 1
        ? { serverTime: 2000, messages: [{ timestamp: 1000, text: "旧问题" }] }
        : {
            serverTime: 4000,
            messages: [
              { timestamp: 1000, text: "旧问题" },
              { timestamp: 3000, text: "周杰伦的晴天" },
            ],
          };
    },
  };
  const utterances = [];
  const monitor = new VoiceConversationMonitor(
    store,
    miot,
    async (_device, text) => {
      utterances.push(text);
    },
    250,
  );
  t.after(() => monitor.stop());
  monitor.sync();
  await new Promise((resolve) => setTimeout(resolve, 600));
  monitor.stop();
  assert.ok(call >= 2);
  assert.deepEqual(utterances, ["周杰伦的晴天"]);
});

test("voice monitor retries an utterance when downstream handling fails", async (t) => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "speaker-platform-voice-retry-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new JsonStore(dataDir);
  await store.init();
  await store.update((state) => {
    state.config.voiceMonitorEnabled = true;
    state.config.selectedDeviceId = "speaker-1";
    state.config.devices = [
      {
        deviceId: "speaker-1",
        name: "客厅",
        model: "LX06",
        hardware: "LX06",
        presence: "online",
      },
    ];
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 60_000,
    };
  });
  let call = 0;
  const miot = {
    async getLatestQuestions() {
      call++;
      return call === 1
        ? { serverTime: 2000, messages: [{ timestamp: 1000, text: "旧问题" }] }
        : {
            serverTime: 4000,
            messages: [
              { timestamp: 1000, text: "旧问题" },
              { timestamp: 3000, text: "新问题" },
              { timestamp: 3000, text: "同一毫秒的另一条" },
            ],
          };
    },
  };
  let attempts = 0;
  const utterances = [];
  const monitor = new VoiceConversationMonitor(
    store,
    miot,
    async (_device, text) => {
      utterances.push(text);
      if (text === "新问题") {
        attempts++;
        if (attempts === 1) throw new Error("temporary failure");
      }
    },
    250,
  );
  t.after(() => monitor.stop());
  monitor.sync();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  monitor.stop();
  assert.ok(call >= 3);
  assert.deepEqual(utterances, ["新问题", "新问题", "同一毫秒的另一条"]);
});
