export const PLATFORMS = ["wy", "tx", "kg", "kw", "mg"] as const;
export type LxPlatform = (typeof PLATFORMS)[number];

export const PLATFORM_NAMES: Record<LxPlatform, string> = {
  wy: "网易云音乐",
  tx: "QQ音乐",
  kg: "酷狗音乐",
  kw: "酷我音乐",
  mg: "咪咕音乐",
};

export function isLxPlatform(value: unknown): value is LxPlatform {
  return PLATFORMS.some((platform) => platform === value);
}

/** Also usable by the offline intent parser for an explicit platform prefix. */
export function musicPlatformByName(value: string): LxPlatform | undefined {
  const name = value.toLowerCase().replace(/\s+/gu, "");
  return PLATFORMS.find((platform) => {
    const label = PLATFORM_NAMES[platform].toLowerCase();
    return name === label || name === label.replace(/音乐$/u, "");
  });
}
