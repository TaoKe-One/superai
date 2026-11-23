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
    return tasks.map((task) => {
      const deterministic = parseRuleIntent(task.text);
      return {
        ...task,
        intent:
          deterministic?.action === "set_playback_mode"
            ? deterministic
            : (nativeIntent(task.text) ?? requireConfidence(task.intent)),
      };
    });
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

    const deterministic = parseRuleIntent(query);
    if (deterministic?.action === "set_playback_mode") return deterministic;

    const native = nativeIntent(query);
    if (native) return native;
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
        if (needsConfidence(result) && result.confidence < 0.68) {
          return {
            action: "clarify",
            question: !result.action.startsWith("play_")
              ? "请再说清楚要执行的播放控制、播放模式或音量数值。"
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

function needsConfidence(intent: AssistantIntent): boolean {
  return (
    intent.action.startsWith("play_") ||
    intent.action === "control" ||
    intent.action === "set_volume" ||
    intent.action === "set_playback_mode"
  );
}

function requireConfidence(intent: AssistantIntent): AssistantIntent {
  if (needsConfidence(intent) && intent.confidence < 0.68)
    return {
      action: "clarify",
      question: "请再说清楚需要执行的歌曲或播放操作。",
      confidence: intent.confidence,
      source: "rules",
    };
  return intent;
}
