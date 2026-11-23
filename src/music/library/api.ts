import type { JsonStore } from "../../storage/store.ts";
import type { PlaybackService } from "../../playback/service.ts";
import { MusicServices } from "./service.ts";
import { LibraryAdapter } from "./adapters.ts";
import { normalizeMusicServices, publicMusicServices } from "./config.ts";

export async function musicServicesApi(
  path: string,
  method: string,
  body: any,
  store: JsonStore,
  music: MusicServices,
  playback: PlaybackService,
  fetchImpl: typeof fetch,
) {
  if (path === "" && method === "GET")
    return {
      ...publicMusicServices(store.snapshot().config.musicServices),
      scans: music.scanStatus(),
    };
  if (path === "/test" && method === "POST") {
    if (body.library) {
      const c = normalizeMusicServices(
        { mode: "private", gatewayBaseUrl: "", libraries: [body.library] },
        store.snapshot().config.musicServices,
        store,
      ).libraries[0];
      return new LibraryAdapter(
        {
          ...c,
          password: c.password ? store.decrypt(c.password) : "",
          accessCode: c.accessCode ? store.decrypt(c.accessCode) : "",
        },
        fetchImpl,
      ).test();
    }
    return music.test(text(body.id));
  }
  if (path === "/scan" && method === "POST")
    return music.startScan(text(body.id));
  if (path === "/scan/stop" && method === "POST")
    return music.stopScan(text(body.id));
  if (path === "/scan/status" && method === "GET") return music.scanStatus();
  if (path === "/browse" && method === "POST") {
    const id = text(body.providerId),
      page = body.page ?? 1;
    const query =
      typeof body.query === "string" ? body.query.trim().slice(0, 500) : "";
    if (!Number.isInteger(page) || page < 1 || page > 1000)
      throw new Error("页码无效");
    if (body.kind === "songs") return music.browse(id, query, page);
    if (!["playlists", "albums", "artists"].includes(body.kind))
      throw new Error("音乐目录类型无效");
    return body.collectionId
      ? music.collectionTracks(id, body.kind, text(body.collectionId), page)
      : music.collections(id, body.kind, page, query);
  }
  if (path === "/play" && method === "POST") {
    const deviceId = store.snapshot().config.selectedDeviceId;
    if (!deviceId) throw new Error("请先连接并选择音箱");
    if (!Array.isArray(body.tracks) || !body.tracks.length)
      throw new Error("播放至少需要一首歌曲");
    return playback.replaceAndPlay(
      deviceId,
      body.tracks.map((t: any) => music.requestedTrack(t)),
      body.index ?? 0,
    );
  }
  if (path === "/lyrics" && method === "POST") {
    const q = store.snapshot().config.playbackQueue;
    const track = body.track
      ? music.requestedTrack(body.track)
      : q.tracks[q.currentIndex];
    if (!track) return { available: false, lyric: "", lines: [] };
    return music.lyrics(track);
  }
  throw new Error("不支持的音乐服务接口");
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 2000)
    throw new Error("音乐库标识无效");
  return v;
}
