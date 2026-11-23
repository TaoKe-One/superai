import type { IntentRouter } from "./router.ts";
import type { AssistantIntent, ConversationTurn } from "./types.ts";

export interface PlannedTask {
  text: string;
  owner: "native" | "platform";
  intent: AssistantIntent;
}
export interface AssistantPlan {
  tasks: PlannedTask[];
}

// Only split explicit, unconditional commands outside quoted titles.
export function splitCommands(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let quote = "";
  const pairs: Record<string, string> = {
    "《": "》",
    "“": "”",
    '"': '"',
    "‘": "’",
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (pairs[char]) {
      quote = pairs[char];
      continue;
    }
    const match =
      /^(?:[，,；;。]|然后|并且|接着|同时|再|并|和|以及|还要|顺便)(?:\s*(?:然后|并且|接着|同时|再|并|和|以及|还要|顺便))?\s*(?=(?:请|帮我|给我)?(?:播放|放|听|我想听|来点|来一首|暂停|继续播放|停止播放|下一首|上一首|打开|关闭|关掉|开启|把|音量|声音|告诉我|介绍|查询|查一下))/u.exec(
        text.slice(i),
      );
    if (!match) continue;
    const part = text.slice(start, i).trim();
    if (part) pieces.push(part);
    i += match[0].length - 1;
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) pieces.push(tail);
  return pieces;
}

/** Understanding role: produces a bounded plan and never calls device tools. */
export class UnderstandingAgent {
  private readonly router: IntentRouter;
  private readonly context: ConversationTurn[];
  constructor(router: IntentRouter, context: ConversationTurn[] = []) {
    this.context = context;
    this.router = router;
  }

  async plan(
    text: string,
    history: ConversationTurn[] = [],
    signal?: AbortSignal,
  ): Promise<AssistantPlan> {
    signal?.throwIfAborted();
    history = [...history.slice(-10), ...this.context];
    // Conditional schedules cannot be represented by the immediate execution tools.
    if (
      /^(?:如果|要是|假如)|(?:[，,；;]|然后)\s*(?:如果|要是|假如)|^等.{1,20}(?:以后|之后|再)/u.test(
        text,
      )
    ) {
      return {
        tasks: [
          {
            text,
            owner: "platform",
            intent: {
              action: "clarify",
              question:
                "这句话包含条件或等待安排。目前只能立即执行，请分别说明现在要做的操作。",
              confidence: 1,
              source: "rules",
            },
          },
        ],
      };
    }
    const parts = splitCommands(text);
    if (
      parts.length === 1 &&
      /(?:然后|并且|顺便|同时|以及|接着|还有|一边.+一边)/u.test(text)
    ) {
      try {
        const proposed = await this.router.plan(text, history, signal);
        signal?.throwIfAborted();
        if (proposed)
          return {
            tasks: proposed.map((task) => ({
              ...task,
              owner: task.intent.action === "native" ? "native" : "platform",
            })),
          };
      } catch {
        signal?.throwIfAborted();
        return {
          tasks: [
            {
              text,
              owner: "platform",
              intent: {
                action: "clarify",
                question: "未能可靠拆分这条组合指令，请分别说明要做的操作。",
                confidence: 1,
                source: "rules",
              },
            },
          ],
        };
      }
    }
    if (parts.length > 4)
      return {
        tasks: [
          {
            text,
            owner: "platform",
            intent: {
              action: "clarify",
              question: "一次最多处理四项任务，请分开说。",
              confidence: 1,
              source: "rules",
            },
          },
        ],
      };
    const tasks: PlannedTask[] = [];
    for (const part of parts) {
      const intent = await this.router.route(part, history, signal);
      signal?.throwIfAborted();
      tasks.push({
        text: part,
        owner: intent.action === "native" ? "native" : "platform",
        intent,
      });
    }
    return { tasks };
  }
}
