import type { MusicRequest, MusicTrack } from "./types.ts";

export interface ScoredTrack {
  track: MusicTrack;
  score: number;
}

export type TrackSelection =
  | { status: "selected"; match: ScoredTrack }
  | { status: "ambiguous"; candidates: ScoredTrack[] }
  | { status: "not_found"; candidates: ScoredTrack[] };

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function similarity(leftValue: string, rightValue: string): number {
  const left = normalize(leftValue);
  const right = normalize(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return (
      0.84 +
      (0.16 * Math.min(left.length, right.length)) /
        Math.max(left.length, right.length)
    );
  }

  const a = Array.from(left);
  const b = Array.from(right);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function scoreTrack(request: MusicRequest, track: MusicTrack): number {
  const titleScore = similarity(request.title, track.title);
  if (request.artist) {
    const artistScore = similarity(request.artist, track.artist);
    return titleScore * 0.72 + artistScore * 0.28;
  }
  return titleScore * 0.96 + (track.artist ? 0.04 : 0);
}

export function selectTrack(
  request: MusicRequest,
  tracks: MusicTrack[],
  minimumScore = 0.84,
  minimumMargin = 0.07,
): TrackSelection {
  const candidates = tracks
    .map((track) => ({ track, score: scoreTrack(request, track) }))
    .sort((left, right) => right.score - left.score);
  if (!candidates.length || candidates[0].score < minimumScore) {
    return { status: "not_found", candidates: candidates.slice(0, 5) };
  }
  if (
    candidates[1] &&
    candidates[0].score - candidates[1].score < minimumMargin
  ) {
    return { status: "ambiguous", candidates: candidates.slice(0, 5) };
  }
  return { status: "selected", match: candidates[0] };
}
