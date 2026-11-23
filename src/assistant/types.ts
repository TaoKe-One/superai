export type ControlCommand = "pause" | "resume" | "next" | "previous" | "stop";
export type ExecutableControlCommand = ControlCommand | "volume";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export type AssistantIntent =
  | {
      action: "native";
      reason: string;
      confidence: number;
      source: "rules" | "llm" | "fallback";
    }
  | {
      action: "play_song";
      title: string;
      artist?: string;
      confidence: number;
      source: "rules" | "llm" | "fallback";
    }
  | {
      action: "play_artist";
      artist: string;
      preference?: "popular";
      confidence: number;
      source: "rules" | "llm" | "fallback";
    }
  | {
      action: "play_playlist";
      playlist: string;
      confidence: number;
      source: "rules" | "llm" | "fallback";
    }
  | {
      action: "control";
      command: ControlCommand;
      confidence: number;
      source: "rules" | "llm" | "fallback";
    }
  | {
      action: "set_volume";
      volume: number;
      confidence: number;
      source: "rules" | "llm" | "fallback";
    }
  | {
      action: "answer";
      question: string;
      answer?: string;
      needsSearch?: boolean;
      modelError?: "format" | "request";
      confidence: number;
      source: "llm" | "fallback";
    }
  | {
      action: "clarify";
      question: string;
      confidence: number;
      source: "rules" | "llm" | "fallback";
    };

export interface ModelIntent {
  action: AssistantIntent["action"];
  volume?: number;
  title?: string;
  artist?: string;
  preference?: "popular";
  playlist?: string;
  command?: ControlCommand;
  question?: string;
  answer?: string;
  needsSearch?: boolean;
  confidence?: number;
  reason?: string;
}

export interface IntentClassifier {
  plan?(
    text: string,
    history?: ConversationTurn[],
    signal?: AbortSignal,
  ): Promise<Array<{ text: string; intent: AssistantIntent }>>;
  classify(
    text: string,
    history?: ConversationTurn[],
    signal?: AbortSignal,
  ): Promise<AssistantIntent>;
}
