export const PLAYBACK_MODE_NAMES = {
  order: "顺序播放",
  loop: "列表循环",
  single: "单曲循环",
  random: "随机播放",
} as const;

export type PlaybackMode = keyof typeof PLAYBACK_MODE_NAMES;

export function isPlaybackMode(value: unknown): value is PlaybackMode {
  return typeof value === "string" && Object.hasOwn(PLAYBACK_MODE_NAMES, value);
}
