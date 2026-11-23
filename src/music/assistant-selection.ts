import { scoreTrack } from "./matcher.ts";
import type { MusicRequest, MusicTrack } from "./types.ts";
import type { AssistantIntent } from "../assistant/types.ts";
import { explicitMusicQuery } from "../assistant/rules.ts";

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
const artistName = (value: string) =>
  normalize(value).replace(/(?<=.{2})乐队$/u, "");
export function requestedArtistMatches(requested: string, actual: string) {
  return actual
    .split(/[、,，&＆/|+＋]+/u)
    .some((name) => artistName(name) === artistName(requested));
}

/** Preserve the catalog's order while picking distinct songs by the requested artist. */
export function assistantArtistQueue(
  artist: string,
  tracks: MusicTrack[],
  limit = 20,
) {
  const seen = new Set<string>();
  const queue: MusicTrack[] = [];
  for (const track of tracks) {
    if (!requestedArtistMatches(artist, track.artist)) continue;
    const title = normalize(track.title);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    queue.push(track);
    if (queue.length === limit) break;
  }
  return queue;
}

/** A possessive particle may belong to the title. Let catalog evidence decide. */
export function songSearchRequests(
  intent: Extract<AssistantIntent, { action: "play_song" }>,
  text: string,
): MusicRequest[] {
  const parsed = {
    title: intent.title,
    ...(intent.artist ? { artist: intent.artist } : {}),
    ...(intent.platform ? { platform: intent.platform } : {}),
  };
  const literal = explicitMusicQuery(text);
  return literal &&
    intent.artist &&
    literal.includes("的") &&
    normalize(literal) !== normalize(intent.title)
    ? [
        {
          title: literal,
          ...(intent.platform ? { platform: intent.platform } : {}),
        },
        parsed,
      ]
    : [parsed];
}

/** Keep a short, deterministic queue of relevant recordings; never fill it with weak matches. */
export function assistantSongQueue(
  request: MusicRequest,
  tracks: MusicTrack[],
  limit = 3,
): MusicTrack[] {
  const title = normalize(request.title);
  const baseTitle = (value: string) =>
    normalize(
      value.replace(
        /[（(](?:[^）)]*(?:live|现场|版|伴奏|remix)[^）)]*)[）)]/giu,
        "",
      ),
    );
  const exact = tracks.filter((track) => normalize(track.title) === title);
  const pool = exact.length
    ? tracks.filter((track) => baseTitle(track.title) === title)
    : tracks;
  const ranked = pool
    .filter(
      (track) =>
        !request.artist || requestedArtistMatches(request.artist, track.artist),
    )
    .map((track, index) => ({
      track,
      index,
      score: scoreTrack(request, track),
      exact: normalize(track.title) === title,
    }))
    .filter((item) => item.score >= 0.84)
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.score - a.score ||
        a.index - b.index,
    );
  const seen = new Set<string>();
  const queue: MusicTrack[] = [];
  for (const { track } of ranked) {
    const key = normalize(track.title) + ":" + artistName(track.artist);
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(track);
    if (queue.length >= limit) break;
  }
  return queue;
}

/** Keep different catalog IDs for the same recording until audio resolution. */
export function assistantSongAlternates(
  first: MusicTrack,
  candidates: MusicTrack[],
): MusicTrack[] {
  if (!first.lx) return [];
  const title = normalize(first.title);
  const artist = artistName(first.artist);
  if (!artist || artist === "未知歌手") return [];
  const album = normalize(first.album ?? "");
  const platforms = new Set([first.lx.platform]);
  return candidates.filter((candidate) => {
    if (
      !candidate.lx ||
      platforms.has(candidate.lx.platform) ||
      normalize(candidate.title) !== title ||
      artistName(candidate.artist) !== artist
    )
      return false;
    const otherAlbum = normalize(candidate.album ?? "");
    const hasDurations = !!(first.durationSeconds && candidate.durationSeconds);
    const sameDuration =
      hasDurations &&
      Math.abs(first.durationSeconds! - candidate.durationSeconds!) <= 3;
    if (
      (album && otherAlbum && album !== otherAlbum) ||
      (hasDurations && !sameDuration) ||
      (!(album && otherAlbum) && !sameDuration)
    )
      return false;
    platforms.add(candidate.lx.platform);
    return true;
  });
}
