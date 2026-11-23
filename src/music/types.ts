import type { LxPlatform } from "./lx/platforms.ts";

export interface MusicRequest {
  title: string;
  artist?: string;
  platform?: LxPlatform;
}

export interface MusicTrack {
  id: string;
  sourceId: string;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
  quality?: string;
  playUrl?: string;
  library?: { providerId: string; trackId: string };
  lx?: { platform: string; songInfo: Record<string, unknown> };
  coverUrl?: string;
}

export interface MusicSource {
  id: string;
  search(request: MusicRequest): Promise<MusicTrack[]>;
}
export interface PlaybackResolution {
  url: string;
  sourceId?: string;
  sourceName?: string;
  platform?: string;
  quality?: string;
  attempts?: import("./lx/health.ts").ResolutionAttempt[];
}
