import { serviceJson } from "../security/http.ts";
import type {
  AssistantIntent,
  ControlCommand,
  ConversationTurn,
  IntentClassifier,
  ModelIntent,
} from "./types.ts";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  direct?: boolean;
}

const systemPrompt = [
  "你是智能音箱的意图路由器。判断用户是在点歌、控制播放，还是提出普通问题。理解自然表达，不要求固定触发词；结合最近对话理解省略的歌名、艺人和指代。历史消息只用于理解当前请求。只返回 JSON，不要解释。",
  "",
  "JSON 字段：action 必须是 play_song、play_artist、play_playlist、control、set_volume、answer、clarify、native 之一；confidence 是 0 到 1 的数值。",
  "- play_song: title 必填，artist 可选。",
  "- play_artist: artist 必填。用户想听这位艺人的几首热门、经典或代表性作品时，将 preference 设为 popular；artist 只填艺人名。音乐工具会挑选曲目，请勿凭空填歌名。",
  "- play_playlist: playlist 必填。",
  "- control: command 必须是 pause、resume、next、previous、stop 之一。",
  "- set_volume: volume 是 0 到 100 的整数；若用户只说调大或调小，且历史里没有确定音量，不要猜数字，使用 clarify。",
  "- answer: question 保留用户原问题。涉及实时信息、天气、新闻、价格或用户要求联网查证时，needsSearch 为 true。其他问题需要填写 needsSearch: false，并在 answer 中用一到两句口语给出完整回答，供音箱直接播报。",
  "- clarify: question 填写一句简短澄清问题。",
  "如果上一轮已问用户补充信息，当前输入可能只给歌手、地点等片段。结合原请求和补充内容决定完整意图，不把片段单独当成新任务。明确的新请求优先。追问同一话题时，answer.question 写包含所指对象的完整问题，供联网工具查询。只问仍缺失的必要信息。",
  "- native: 家电、红外、米家场景、闹钟或提醒等原生操作，reason 说明保留原生处理。不要声称已执行，不要归为 answer。设备知识问题仍属于 answer。",
  "",
  "若用户要听某歌手的具体歌曲，使用 play_song 并分开歌名和歌手；若只想听某歌手的歌，使用 play_artist。问天气、知识、建议等属于 answer。回答适合语音播报，简洁直接；不确定或涉及实时信息且没有可靠依据时，明确说明无法确认，不要编造。只有确实无法判断时才用 clarify。",
  "示例：‘周杰伦的晴天’ → play_song（artist: 周杰伦，title: 晴天），即使没有‘播放’或‘我想听’；‘周杰伦的晴天是哪年发行的’ → answer；‘晴天，周杰伦唱的’ → play_song。",
  "示例：‘播放周杰伦的一些热门歌曲’或‘想听几首周董最有名的作品’ → play_artist（artist: 周杰伦，preference: popular）；‘播放周杰伦的一些热门歌单’ → play_playlist（playlist: 周杰伦的一些热门）。分辨真实歌曲名和对一组歌曲的描述。",
].join("\n");

const validCommands = new Set<ControlCommand>([
  "pause",
  "resume",
  "next",
  "previous",
  "stop",
]);
const validActions = new Set<ModelIntent["action"]>([
  "native",
  "play_song",
  "play_artist",
  "play_playlist",
  "control",
  "set_volume",
  "answer",
  "clarify",
]);

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("意图模型未返回有效的 " + field);
  return value.trim();
}

export function normalizeModelIntent(
  value: unknown,
  rawText: string,
): AssistantIntent {
  if (!value || typeof value !== "object")
    throw new Error("意图模型返回内容不是对象");
  const model = value as ModelIntent;
  if (!validActions.has(model.action))
    throw new Error("意图模型返回了未知动作");
  const confidence =
    typeof model.confidence === "number" && Number.isFinite(model.confidence)
      ? Math.max(0, Math.min(1, model.confidence))
      : 0.5;
  const source = "llm" as const;

  switch (model.action) {
    case "native":
      return {
        action: "native",
        reason:
          typeof model.reason === "string"
            ? model.reason.slice(0, 300)
            : "保留小爱原生处理，未确认执行结果。",
        confidence,
        source,
      };
    case "set_volume": {
      if (
        !Number.isInteger(model.volume) ||
        (model.volume ?? -1) < 0 ||
        (model.volume ?? 101) > 100
      ) {
        throw new Error("音量必须是 0 到 100 的整数");
      }
      return {
        action: "set_volume",
        volume: model.volume!,
        confidence,
        source,
      };
    }
    case "play_song":
      return {
        action: "play_song",
        title: requiredText(model.title, "title"),
        ...(model.artist?.trim() ? { artist: model.artist.trim() } : {}),
        confidence,
        source,
      };
    case "play_artist":
      return {
        action: "play_artist",
        artist: requiredText(model.artist, "artist"),
        ...(model.preference === "popular"
          ? { preference: "popular" as const }
          : {}),
        confidence,
        source,
      };
    case "play_playlist":
      return {
        action: "play_playlist",
        playlist: requiredText(model.playlist, "playlist"),
        confidence,
        source,
      };
    case "control":
      if (!model.command || !validCommands.has(model.command))
        throw new Error("意图模型返回了未知播放控制命令");
      return { action: "control", command: model.command, confidence, source };
    case "answer":
      return {
        action: "answer",
        question:
          typeof model.question === "string" && model.question.trim()
            ? model.question.trim()
            : rawText,
        ...(typeof model.answer === "string" && model.answer.trim()
          ? { answer: model.answer.trim() }
          : {}),
        needsSearch: model.needsSearch === true,
        confidence,
        source,
      };
    case "clarify":
      return {
        action: "clarify",
        question: requiredText(model.question, "question"),
        confidence,
        source,
      };
  }
}

// Optional JSON-mode and sampling parameters are rejected by some compatible services.
// Validate the returned intent before executing any action.
export function parseModelJson(content: string): unknown {
  const text = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  return JSON.parse(fenced ? fenced[1].trim() : text);
}

export async function requestModelText(
  config: OpenAICompatibleConfig,
  messages: Array<{ role: string; content: string }>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, "");
  const xingchi = new URL(base).origin === "https://api.xingchiapi.com";
  const responses = xingchi || base.endsWith("/responses");
  const root = base.replace(/\/(?:responses|chat\/completions)$/, "");
  const miniMax =
    !responses &&
    (root === "https://api.minimax.cn/v1" ||
      root === "https://api.minimax.io/v1");
  const miniMaxFlash = miniMax && config.model === "MiniMax-M3.1-Flash";
  const endpoint = xingchi
    ? "https://api.xingchiapi.com/v1/responses"
    : root + (responses ? "/responses" : "/chat/completions");
  const payload = await serviceJson(fetchImpl, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: "Bearer " + config.apiKey } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      ...(responses ? { input: messages } : { messages }),
      // Flash requires thinking; keep it out of the final text and lower its depth.
      ...(miniMax ? { reasoning_split: true } : {}),
      ...(miniMaxFlash ? { reasoning_effort: "low" } : {}),
      ...(miniMax && config.model === "MiniMax-M3" && config.direct
        ? { thinking: { type: "disabled" } }
        : {}),
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(config.timeoutMs ?? 25000),
      ...(signal ? [signal] : []),
    ]),
  });
  const content = responses
    ? (payload.output ?? [])
        .filter(
          (item: any) => item.type === "message" && item.role === "assistant",
        )
        .flatMap((item: any) => item.content ?? [])
        .filter(
          (part: any) =>
            part.type === "output_text" && typeof part.text === "string",
        )
        .map((part: any) => part.text)
        .join("")
    : payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim())
    throw new Error("模型没有返回有效文本");
  return content;
}

export class OpenAICompatibleIntentClassifier implements IntentClassifier {
  private readonly config: OpenAICompatibleConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAICompatibleConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async plan(
    text: string,
    history: ConversationTurn[] = [],
    signal?: AbortSignal,
  ) {
    const content = await requestModelText(
      this.config,
      [
        {
          role: "system",
          content:
            systemPrompt +
            "\n你现在负责拆解组合请求。仅返回 {tasks:[{text, intent}]}；最多四项，intent 使用上述动作字段。text 必须逐字摘自当前用户输入，按原顺序覆盖全部实质内容，只可省略标点、空格和连接词。不可增加用户没有要求的动作。家电/红外归 native，不声称执行成功；条件、预约或无法明确拆分的任务归 clarify。不得将历史里的操作作为当前任务。",
        },
        ...history.slice(-12).map((turn) => ({
          role: turn.role,
          content: turn.content.slice(0, 2000),
        })),
        { role: "user", content: text },
      ],
      this.fetchImpl,
      signal,
    );
    const value = parseModelJson(content) as { tasks?: unknown };
    if (
      !Array.isArray(value?.tasks) ||
      value.tasks.length < 1 ||
      value.tasks.length > 4
    )
      throw new Error("任务计划格式无效");
    let offset = 0;
    let uncovered = "";
    const tasks = value.tasks.map((raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.text !== "string" ||
        !raw.text.trim()
      )
        throw new Error("任务文本无效");
      const index = text.indexOf(raw.text, offset);
      if (index < offset) throw new Error("任务不能增加或重排用户指令");
      uncovered += text.slice(offset, index);
      offset = index + raw.text.length;
      return {
        text: raw.text,
        intent: normalizeModelIntent(raw.intent, raw.text),
      };
    });
    uncovered += text.slice(offset);
    if (
      uncovered.replace(
        /(?:然后|并且|同时|顺便|还要|还有|以及|接着|再|并|和|[\s，,。；;])/gu,
        "",
      )
    )
      throw new Error("任务计划遗漏用户内容");
    return tasks;
  }

  async classify(
    text: string,
    history: ConversationTurn[] = [],
    signal?: AbortSignal,
  ): Promise<AssistantIntent> {
    const content = await requestModelText(
      { ...this.config, direct: true },
      [
        { role: "system", content: systemPrompt },
        ...history
          .filter(
            (turn) =>
              (turn.role === "user" || turn.role === "assistant") &&
              typeof turn.content === "string",
          )
          .slice(-12)
          .map((turn) => ({
            role: turn.role,
            content: turn.content.slice(0, 2000),
          })),
        { role: "user", content: text },
      ],
      this.fetchImpl,
      signal,
    );
    let parsed: unknown;
    try {
      parsed = parseModelJson(content);
    } catch {
      throw new Error("意图模型返回了无效 JSON");
    }
    return normalizeModelIntent(parsed, text);
  }
}
