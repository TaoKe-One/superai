import { createHash } from "node:crypto";
import type { JsonStore } from "../../storage/store.ts";
import type { MusicTrack } from "../types.ts";
import { LxCatalog, lxPlatform } from "./catalog.ts";

export interface LyricLine {
  time: number;
  text: string;
  translation?: string;
}
export function parseLrc(raw: string): LyricLine[] {
  if (typeof raw !== "string" || raw.length > 262144) return [];
  // LRC offsets advance the lyric clock, so effective cue times subtract it.
  const offset =
    Number(raw.match(/\[offset:\s*([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const line of raw.split(/\r?\n/).slice(0, 5000)) {
    const tags = [
      ...line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g),
    ];
    const text = line
      .replace(/\[[^\]]*\]/g, "")
      .replace(/<\d+,\d+>/g, "")
      .trim();
    if (!text) continue;
    for (const tag of tags) {
      const time = Math.max(
        0,
        Number(tag[1]) * 60 +
          Number(tag[2]) +
          Number("0." + (tag[3] ?? "0")) -
          offset,
      );
      if (time < 86400) lines.push({ time, text: text.slice(0, 2000) });
      if (lines.length >= 5000) break;
    }
    if (lines.length >= 5000) break;
  }
  lines.sort((a, b) => a.time - b.time);
  return lines.filter(
    (line, i) =>
      !i || line.time !== lines[i - 1].time || line.text !== lines[i - 1].text,
  );
}
function normalizedLyrics(raw: any) {
  const text = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 262144) : "";
  const lyric = text(raw?.lyric || raw?.lxlyric),
    tlyric = text(raw?.tlyric);
  const lines = parseLrc(lyric),
    translations = parseLrc(tlyric);
  let i = 0;
  for (const line of lines) {
    while (
      i + 1 < translations.length &&
      translations[i + 1].time <= line.time + 0.1
    )
      i++;
    if (translations[i] && Math.abs(translations[i].time - line.time) < 0.15)
      line.translation = translations[i].text;
  }
  return {
    available: !!lyric.trim(),
    timed: !!lines.length,
    lyric,
    tlyric,
    lines,
  };
}
const caches = new WeakMap<
  JsonStore,
  Map<string, { expires: number; promise: Promise<any> }>
>();
export async function trackLyrics(
  store: JsonStore,
  catalog: LxCatalog,
  track?: MusicTrack,
) {
  if (!track?.lx) return { ...normalizedLyrics(null), reason: "no_metadata" };
  let cache = caches.get(store);
  if (!cache) caches.set(store, (cache = new Map()));
  const key = createHash("sha256")
    .update(JSON.stringify(track.lx))
    .digest("hex");
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  if (cache.size >= 50) cache.delete(cache.keys().next().value!);
  const entry = {
    expires: Date.now() + 60000,
    promise: Promise.resolve(null) as Promise<any>,
  };
  entry.promise = (async () => {
    try {
      const raw = await catalog.lyrics(
        lxPlatform(track.lx!.platform),
        track.lx!.songInfo,
        AbortSignal.timeout(12000),
      );
      const result = normalizedLyrics(raw);
      entry.expires = Date.now() + (result.available ? 21600000 : 60000);
      return {
        ...result,
        platform: track.lx!.platform,
        reason: result.available ? "ok" : "not_found",
      };
    } catch {
      return {
        ...normalizedLyrics(null),
        platform: track.lx!.platform,
        reason: "unavailable",
      };
    }
  })();
  cache.set(key, entry);
  return entry.promise;
}
