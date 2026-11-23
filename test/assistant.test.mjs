import assert from "node:assert/strict";
import test from "node:test";
import { IntentRouter } from "../src/assistant/router.ts";
import {
  OpenAICompatibleIntentClassifier,
  normalizeModelIntent,
} from "../src/assistant/llm.ts";

test("natural song request extracts the song and artist without a trigger word", async () => {
  const result = await new IntentRouter().route("我想听周杰伦的晴天");
  assert.deepEqual(result, {
    action: "play_song",
    artist: "周杰伦",
    title: "晴天",
    confidence: 0.96,
    source: "rules",
  });
});

test("bare artist-and-title wording routes to music without a wake phrase", async () => {
  const result = await new IntentRouter().route("周杰伦的晴天");
  assert.equal(result.action, "play_song");
  assert.equal(result.artist, "周杰伦");
  assert.equal(result.title, "晴天");
  assert.equal(result.source, "rules");
});

test("short explicit playback wording still routes a song without a model", async () => {
  const result = await new IntentRouter().route("放晴天");
  assert.equal(result.action, "play_song");
  assert.equal(result.title, "晴天");
});

test("natural playlist requests route to playlist playback", async () => {
  const router = new IntentRouter();
  const result = await router.route("播放我收藏的歌单");
  assert.equal(result.action, "play_playlist");
  assert.equal(result.playlist, "我收藏");
});

test("artist-only requests do not become a song titled 歌", async () => {
  const result = await new IntentRouter().route("周杰伦的歌");
  assert.equal(result.action, "play_artist");
  assert.equal(result.artist, "周杰伦");
});

test("artist-only request routes to artist playback", async () => {
  const result = await new IntentRouter().route("播放周杰伦的歌");
  assert.equal(result.action, "play_artist");
  assert.equal(result.artist, "周杰伦");
});

test("popular songs by an artist are not parsed as a song title", async () => {
  const router = new IntentRouter();
  for (const phrase of [
    "播放周杰伦的一些热门歌曲",
    "小爱同学，放几首周杰伦的经典老歌",
    "周杰伦的热门歌曲",
    "来几首周杰伦的代表作",
  ]) {
    const intent = await router.route(phrase);
    assert.equal(intent.action, "play_artist", phrase);
    assert.equal(intent.artist, "周杰伦", phrase);
    assert.equal(intent.preference, "popular", phrase);
  }
  const named = await router.route("播放周杰伦的《热门歌曲》");
  assert.equal(named.action, "play_song");
  assert.equal(named.artist, "周杰伦");
});

test("playback controls require a command-shaped utterance", async () => {
  assert.equal((await new IntentRouter().route("暂停一下")).action, "control");
  assert.equal(
    (await new IntentRouter().route("怎么暂停音乐")).action,
    "answer",
  );
});

test("ambiguous bare Chinese phrases defer to the configured model", async () => {
  let received;
  const router = new IntentRouter({
    async classify(text) {
      received = text;
      return {
        action: "answer",
        question: text,
        answer: "上海今天有雨。",
        confidence: 0.9,
        source: "llm",
      };
    },
  });
  const result = await router.route("上海的天气");
  assert.equal(received, "上海的天气");
  assert.equal(result.action, "answer");
});

test("low-confidence model controls and volume changes require clarification", async () => {
  const control = new IntentRouter({
    async classify() {
      return {
        action: "control",
        command: "stop",
        confidence: 0.2,
        source: "llm",
      };
    },
  });
  const volume = new IntentRouter({
    async classify() {
      return {
        action: "set_volume",
        volume: 90,
        confidence: 0.3,
        source: "llm",
      };
    },
  });
  assert.equal((await control.route("有点吵")).action, "clarify");
  assert.equal((await volume.route("有点吵")).action, "clarify");
});

test("volume commands require an explicit numeric target", async () => {
  const router = new IntentRouter();
  assert.deepEqual(await router.route("请把音量调到 30"), {
    action: "set_volume",
    volume: 30,
    confidence: 0.99,
    source: "rules",
  });
  const vague = await router.route("音量大一点");
  assert.equal(vague.action, "clarify");
});

test("classifier routes an unprefixed song request", async () => {
  const classifier = {
    async classify() {
      return {
        action: "play_song",
        title: "晴天",
        artist: "周杰伦",
        confidence: 0.94,
        source: "llm",
      };
    },
  };
  const result = await new IntentRouter(classifier).route("晴天 周杰伦");
  assert.equal(result.action, "play_song");
  assert.equal(result.source, "llm");
});

test("classifier can separate artist and title when speech omits 的", async () => {
  let received;
  const router = new IntentRouter({
    async classify(text) {
      received = text;
      return {
        action: "play_song",
        title: "晴天",
        artist: "周杰伦",
        confidence: 0.94,
        source: "llm",
      };
    },
  });
  const result = await router.route("我想听周杰伦晴天");
  assert.equal(received, "我想听周杰伦晴天");
  assert.equal(result.action, "play_song");
  assert.equal(result.title, "晴天");
  assert.equal(result.artist, "周杰伦");
});

test("low-confidence music intent asks for clarification", async () => {
  const classifier = {
    async classify() {
      return {
        action: "play_song",
        title: "晴天",
        confidence: 0.4,
        source: "llm",
      };
    },
  };
  const result = await new IntentRouter(classifier).route("那个歌可以放吗");
  assert.equal(result.action, "clarify");
});

test("model output is validated before becoming an executable intent", () => {
  assert.throws(() =>
    normalizeModelIntent({ action: "play_song", title: "   " }, "晴天"),
  );
  assert.throws(() =>
    normalizeModelIntent({ action: "control", command: "delete" }, "停"),
  );
  assert.throws(() =>
    normalizeModelIntent({ action: "set_volume", volume: 101 }, "音量调到 101"),
  );
  assert.equal(
    normalizeModelIntent({ action: "set_volume", volume: 35 }, "音量调低一点")
      .volume,
    35,
  );
});

test("OpenAI-compatible classifier sends a minimal request and parses the route", async () => {
  let seenUrl;
  let seenBody;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "answer",
                question: "上海天气怎么样",
                answer: "我暂时无法确认上海的实时天气。",
                confidence: 0.91,
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const classifier = new OpenAICompatibleIntentClassifier(
    {
      baseUrl: "https://ai.example/v1/",
      apiKey: "test-key",
      model: "test-model",
    },
    fetchImpl,
  );
  const result = await classifier.classify("那明天呢？", [
    { role: "user", content: "上海今天有雨吗？" },
    { role: "assistant", content: "今天上海有小雨。" },
  ]);
  assert.equal(seenUrl, "https://ai.example/v1/chat/completions");
  assert.equal("response_format" in seenBody, false);
  assert.equal("temperature" in seenBody, false);
  assert.deepEqual(seenBody.messages.slice(1, 3), [
    { role: "user", content: "上海今天有雨吗？" },
    { role: "assistant", content: "今天上海有小雨。" },
  ]);
  assert.equal(result.action, "answer");
  assert.equal(result.answer, "我暂时无法确认上海的实时天气。");
  assert.equal(result.confidence, 0.91);
});
