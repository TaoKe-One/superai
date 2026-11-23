export interface PlatformRule {
  enabled: boolean;
  priority: number;
}
export interface SourceHealth {
  score: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  checkedAt: number;
  latencyMs: number;
  cooldownUntil: number;
  state: "ok" | "failed";
  reason: "ok" | "resolve" | "audio" | "timeout";
  quality: string;
}
export type SourceRouting = Record<string, PlatformRule>;
export type SourceHealthMap = Record<string, SourceHealth>;
export interface ResolutionAttempt {
  sourceId: string;
  sourceName?: string;
  platform: string;
  quality: string;
  stage: "resolve" | "audio" | "ready";
  ok: boolean;
  elapsedMs: number;
}
export class LxResolutionError extends Error {
  readonly attempts: ResolutionAttempt[];
  constructor(
    attempts: ResolutionAttempt[],
    message = "已启用的 LX 音源均未返回可播放音频，请查看音源检测结果或更换音源",
  ) {
    super(message);
    this.attempts = attempts;
  }
}
export function rankSources<
  T extends { routing?: SourceRouting; health?: SourceHealthMap },
>(sources: T[], platform: string, now = Date.now()): T[] {
  return sources
    .filter((s) => s.routing?.[platform]?.enabled !== false)
    .sort((a, b) => {
      const ah = a.health?.[platform],
        bh = b.health?.[platform];
      const cool =
        Number((ah?.cooldownUntil ?? 0) > now) -
        Number((bh?.cooldownUntil ?? 0) > now);
      const priority =
        (b.routing?.[platform]?.priority ?? 50) -
        (a.routing?.[platform]?.priority ?? 50);
      const score = (h?: SourceHealth) =>
        h && now - h.checkedAt < 86400000 ? h.score : 50;
      return cool || priority || score(bh) - score(ah);
    });
}
export function healthSample(
  previous: SourceHealth | undefined,
  ok: boolean,
  elapsedMs: number,
  reason: SourceHealth["reason"],
  quality: string,
  now = Date.now(),
): SourceHealth {
  const consecutiveFailures = ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
  const sampleScore = Math.max(60, 100 - Math.floor(elapsedMs / 300));
  return {
    score: ok
      ? Math.round(
          previous ? previous.score * 0.65 + sampleScore * 0.35 : sampleScore,
        )
      : Math.max(0, (previous?.score ?? 50) - 35),
    successes: Math.min(1000000, (previous?.successes ?? 0) + Number(ok)),
    failures: Math.min(1000000, (previous?.failures ?? 0) + Number(!ok)),
    consecutiveFailures,
    checkedAt: now,
    latencyMs: elapsedMs,
    quality,
    state: ok ? "ok" : "failed",
    reason,
    cooldownUntil:
      consecutiveFailures >= 2
        ? now +
          Math.min(300000, 30000 * 2 ** Math.min(consecutiveFailures - 2, 4))
        : 0,
  };
}
