import test from "node:test";
import assert from "node:assert/strict";
import { testAi } from "../src/assistant/providers.ts";
import { OpenAICompatibleIntentClassifier } from "../src/assistant/llm.ts";

const config = {
  provider: "custom",
  baseUrl: "https://model.example/v1",
  apiKey: "fixture",
  model: "reasoning-model",
};
for (const fenced of [false, true]) {
  test(
    "model test and assistant accept compatible service, fenced=" + fenced,
    async () => {
      const requests = [];
      const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        if ("response_format" in body || "temperature" in body)
          return new Response("{}", { status: 400 });
        const content = JSON.stringify({
          action: "play_song",
          title: "晴天",
          artist: "周杰伦",
          confidence: 1,
        });
        return Response.json({
          choices: [
            {
              message: {
                content: fenced ? "```json\n" + content + "\n```" : content,
              },
            },
          ],
        });
      };
      assert.equal((await testAi(config, false, fetchImpl)).intent, true);
      const classifier = new OpenAICompatibleIntentClassifier(
        config,
        fetchImpl,
      );
      assert.equal((await classifier.classify("周杰伦的晴天")).title, "晴天");
      assert.equal(requests.length, 2);
      assert.ok(
        requests.every((body) => body.messages[0].content.includes("JSON")),
      );
    },
  );
}
test("compatible responses remain validated and failed requests are not retried", async () => {
  for (const content of [
    "plain text",
    '```json\n{"action":"delete_all"}\n```',
    '{"action":"set_volume","volume":999}',
  ]) {
    const fetchImpl = async () =>
      Response.json({ choices: [{ message: { content } }] });
    await assert.rejects(testAi(config, false, fetchImpl));
    await assert.rejects(
      new OpenAICompatibleIntentClassifier(config, fetchImpl).classify("test"),
    );
  }
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return new Response("{}", { status: 401 });
  };
  await assert.rejects(testAi(config, false, fetchImpl), /401/);
  await assert.rejects(
    new OpenAICompatibleIntentClassifier(config, fetchImpl).classify("test"),
    /401/,
  );
  assert.equal(count, 2);
});

test("MiniMax M3 uses direct single-intent replies and retains thinking for task planning", async () => {
  const bodies = [];
  const intent = {
    action: "answer",
    answer: "太阳是一颗恒星。",
    confidence: 1,
  };
  const text = "太阳是什么";
  const classify = (baseUrl) =>
    new OpenAICompatibleIntentClassifier(
      { ...config, baseUrl, model: "MiniMax-M3" },
      async (_, options) => {
        const body = JSON.parse(options.body);
        bodies.push(body);
        const content = body.messages[0].content.includes("拆解组合请求")
          ? { tasks: [{ text, intent }] }
          : intent;
        return Response.json({
          choices: [{ message: { content: JSON.stringify(content) } }],
        });
      },
    );
  const official = classify("https://api.minimax.cn/v1");
  assert.equal((await official.classify(text)).answer, intent.answer);
  assert.equal((await official.plan(text))[0].intent.answer, intent.answer);
  await classify(config.baseUrl).classify(text);
  assert.deepEqual(
    bodies.map((body) => body.thinking),
    [{ type: "disabled" }, undefined, undefined],
  );
});

test("MiniMax M3 treats plain-text conversation history as context for JSON intent routing", async () => {
  const history = [
    { role: "user", content: "介绍一下月球" },
    { role: "assistant", content: "月球是地球唯一的天然卫星。" },
  ];
  const classifier = new OpenAICompatibleIntentClassifier(
    {
      ...config,
      baseUrl: "https://api.minimax.cn/v1/chat/completions",
      model: "MiniMax-M3",
    },
    async (_, options) => {
      const body = JSON.parse(options.body);
      // The real model sometimes copies the earlier assistant's plain-text format.
      if (body.messages.some((message) => message.role === "assistant"))
        return Response.json({
          choices: [{ message: { content: "月球也有昼夜之分。" } }],
        });
      assert.ok(body.messages[0].content.includes("history"));
      assert.deepEqual(JSON.parse(body.messages[1].content), {
        history,
        request: "再补充一下",
      });
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "answer",
                answer: "月球也有昼夜之分。",
                confidence: 1,
              }),
            },
          },
        ],
      });
    },
  );
  assert.equal(
    (await classifier.classify("再补充一下", history)).answer,
    "月球也有昼夜之分。",
  );
});
