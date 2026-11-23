import type { AssistantIntent } from "./types.ts";

export type ExecutionStage =
  | "interrupting"
  | "interrupted"
  | "interrupt_unconfirmed"
  | "paused_for_speech"
  | "searching"
  | "selected"
  | "resolving"
  | "retrying_playlist"
  | "sending"
  | "accepted";
export interface ExecutionContext {
  origin?: "voice";
  deviceId?: string;
  signal?: AbortSignal;
  onStage?: (stage: ExecutionStage) => void;
}

export function checkExecution(context?: ExecutionContext) {
  context?.signal?.throwIfAborted();
}

export const VOICE_REPLY_WINDOW_MS = 60_000;

export function estimatedSpeechMs(text: string) {
  return Math.max(3000, Math.min(text.length, 1000) * 420 + 1500);
}

/** Execution role: only dispatches validated intents through the existing tool whitelist. */
export class ExecutionAgent {
  private readonly execute: (
    intent: AssistantIntent,
    text: string,
    context: ExecutionContext,
  ) => Promise<Record<string, unknown>>;
  constructor(
    execute: (
      intent: AssistantIntent,
      text: string,
      context: ExecutionContext,
    ) => Promise<Record<string, unknown>>,
  ) {
    this.execute = execute;
  }
  async run(intent: AssistantIntent, text: string, context: ExecutionContext) {
    checkExecution(context);
    if (intent.action === "native")
      return { message: intent.reason, native: true };
    return this.execute(intent, text, context);
  }
}

export function withExecutionSignal(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): typeof fetch {
  if (!signal) return fetchImpl;
  return (input, init) =>
    fetchImpl(input, {
      ...init,
      signal: AbortSignal.any([
        signal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]),
    });
}
