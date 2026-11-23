import { selectTrack, type TrackSelection } from "./matcher.ts";
import type { MusicRequest, MusicSource, MusicTrack } from "./types.ts";

export interface MusicSearchResult {
  selection: TrackSelection;
  tracks: MusicTrack[];
  lxCandidates?: MusicTrack[];
  sourceErrors: Array<{ sourceId: string; message: string }>;
}

export async function searchMusic(
  request: MusicRequest,
  sources: MusicSource[],
  retainLxCandidates = false,
): Promise<MusicSearchResult> {
  const results = await Promise.allSettled(
    sources.map((source) => source.search(request)),
  );
  const tracks: MusicTrack[] = [];
  const sourceErrors: MusicSearchResult["sourceErrors"] = [];

  results.forEach((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled") {
      tracks.push(
        ...result.value.map((track) => ({ ...track, sourceId: source.id })),
      );
    } else {
      sourceErrors.push({
        sourceId: source.id,
        message:
          result.reason instanceof Error
            ? result.reason.message
            : "音乐源搜索失败",
      });
    }
  });

  const unique: MusicTrack[] = [];
  for (const track of tracks) {
    const title = track.title.normalize("NFKC").toLocaleLowerCase();
    const artist = track.artist.normalize("NFKC").toLocaleLowerCase();
    const album = track.album?.normalize("NFKC").toLocaleLowerCase();
    const duplicate = unique.some((item) => {
      if (
        item.title.normalize("NFKC").toLocaleLowerCase() !== title ||
        item.artist.normalize("NFKC").toLocaleLowerCase() !== artist
      )
        return false;
      const otherAlbum = item.album?.normalize("NFKC").toLocaleLowerCase();
      return (
        (!album && !otherAlbum) ||
        (Boolean(album && otherAlbum) && album === otherAlbum)
      );
    });
    if (!duplicate) unique.push(track);
  }
  const deduplicated = unique;
  return {
    selection: selectTrack(request, deduplicated),
    tracks: deduplicated,
    ...(retainLxCandidates
      ? { lxCandidates: tracks.filter((track) => track.lx) }
      : {}),
    sourceErrors,
  };
}
