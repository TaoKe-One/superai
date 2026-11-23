import { parseRuleIntent } from "./rules.ts";
import { nativeIntent } from "./native.ts";
import { ModelResponseError } from "./llm.ts";
import type {
  AssistantIntent,
  ConversationTurn,
  IntentClassifier,
} from "./types.ts";

export class IntentRouter {
  private readonly classifier?: IntentClassifier;

  constructor(classifier?: IntentClassifier) {
    this.classifier = classifier;
  }

  async plan(text: string, history: ConversationTurn[], signal?: AbortSignal) {
    if (!this.classifier?.plan) return null;
    const tasks = await this.classifier.plan(text, history, signal);
    return tasks.map((task) => ({
      ...task,
      intent: nativeIntent(task.text) ?? requireConfidence(task.intent),
    }));
  }

  async route(
    text: string,
    history: ConversationTurn[] = [],
    signal?: AbortSignal,
  ): Promise<AssistantIntent> {
    const query = text.trim();
    if (!query) {
      return {
        action: "clarify",
        question: "你想听什么，或者想问什么？",
        confidence: 1,
        source: "rules",
      };
    }

    const native = nativeIntent(query);
    if (native) return native;
    const deterministic = parseRuleIntent(query);
    if (
      deterministic &&
      (!this.classifier ||
        deterministic.action === "control" ||
        deterministic.action === "set_volume" ||
        deterministic.action === "clarify")
    )
      return deterministic;
    if (this.classifier) {
      try {
        const result = await this.classifier.classify(query, history, signal);
        if (
          (result.action.startsWith("play_") ||
            result.action === "control" ||
            result.action === "set_volume") &&
          result.confidence < 0.68
        ) {
          return {
            action: "clarify",
            question:
              result.action === "control" || result.action === "set_volume"
                ? "请再说清楚要执行的播放控制或音量数值。"
                : "你是想播放音乐吗？可以告诉我歌名或歌手。",
            confidence: result.confidence,
            source: "llm",
          };
        }
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (deterministic) return deterministic;
        return {
          action: "answer",
          question: query,
          modelError:
            error instanceof ModelResponseError ? "format" : "request",
          confidence: 0.35,
          source: "fallback",
        };
      }
    }
    if (deterministic) return deterministic;
    return {
      action: "answer",
      question: query,
      confidence: 0.3,
      source: "fallback",
    };
  }
}

function requireConfidence(intent: AssistantIntent): AssistantIntent {
  if (
    (intent.action.startsWith("play_") ||
      intent.action === "control" ||
      intent.action === "set_volume") &&
    intent.confidence < 0.68
  )
    return {
      action: "clarify",
      question: "请再说清楚需要执行的歌曲或播放操作。",
      confidence: intent.confidence,
      source: "rules",
    };
  return intent;
}
