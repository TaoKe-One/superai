import { LxResolutionError } from "../music/lx/health.ts";

export function redactLogText(text: string, secrets: string[] = []) {
  for (const value of secrets) {
    if (!value) continue;
    if (value.length >= 5) {
      text = text.replaceAll(value, "[已隐藏]");
    } else {
      const literal = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      text = text.replace(
        new RegExp("(?<![a-zA-Z0-9_])" + literal + "(?![a-zA-Z0-9_])", "gu"),
        "[已隐藏]",
      );
    }
  }
  return text
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`，。；）]+/giu, (url) => {
      try {
        return new URL(url).origin + "/…";
      } catch {
        return "[URL 已隐藏]";
      }
    })
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/giu, "[凭证已隐藏]")
    .replace(
      /((?:api[_ -]?key|speaker_session|password|passToken|serviceToken|access[_ -]?token|accessCode|secret|ssecurity|cookie|authorization|密钥|密码|令牌|访问码)["']?\s*(?:[:：=]|是)\s*)("[^"]*"|'[^']*'|[^\s,;，；。]+)/giu,
      "$1[已隐藏]",
    )
    .replace(
      /\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]+)\b/gu,
      "[凭证已隐藏]",
    )
    .slice(0, 2000);
}

export function logError(error: unknown) {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...(error instanceof LxResolutionError
          ? { attempts: error.attempts }
          : {}),
      }
    : { message: typeof error === "string" ? error : "未知错误" };
}

export function assistantLogResult(result: Record<string, unknown>) {
  const queue = result.playbackQueue as
    { tracks?: unknown[]; currentIndex?: number } | undefined;
  const track = result.track as
    { title?: string; artist?: string; sourceId?: string } | undefined;
  return {
    status:
      result.executionStatus ??
      (result.speechError ? "unconfirmed" : "completed"),
    message: result.message,
    modelError: result.modelError,
    speechError: result.speechError,
    searchError: result.searchError,
    playbackMode: result.playbackMode,
    ...(track
      ? {
          track: {
            title: track.title,
            artist: track.artist,
            sourceId: track.sourceId,
          },
        }
      : {}),
    ...(queue
      ? { queueLength: queue.tracks?.length, currentIndex: queue.currentIndex }
      : {}),
  };
}
