import { MusicServices } from "../library/service.ts";
import type { JsonStore } from "../../storage/store.ts";
import type { PlaybackService } from "../../playback/service.ts";
import { LxMusicService, toLxSong } from "./service.ts";
import { lxPlatform } from "./catalog.ts";
import { MAX_LX_SCRIPT_BYTES } from "./runtime.ts";
import {
  startSourceCheck,
  sourceCheckStatus,
  stopSourceCheck,
} from "./checks.ts";

// Native routes used by the adapted player; no Songloft host or compatibility server.
export async function handleLxApi(
  method: string,
  path: string,
  url: URL,
  body: any,
  lx: LxMusicService,
  store: JsonStore,
  playback: PlaybackService,
  music = new MusicServices(store),
): Promise<unknown> {
  if (path === "/sources" && method === "GET") return lx.sources();
  if (path === "/sources/import" && method === "POST") {
    if (typeof body.script !== "string")
      throw new Error("请选择 LX .js 音源文件");
    return lx.importScript(body.script);
  }
  if (path === "/sources/import-url" && method === "POST") {
    if (typeof body.url !== "string") throw new Error("请填写音源地址");
    return lx.importUrl(body.url);
  }
  if (path === "/sources" && method === "DELETE")
    return lx.changeSource(url.searchParams.get("id") ?? "");
  if (path === "/sources" && method === "PUT") {
    if (typeof body.id !== "string" || typeof body.enabled !== "boolean")
      throw new Error("音源设置无效");
    return lx.changeSource(body.id, body.enabled);
  }
  if (path === "/sources/test" && method === "POST") {
    music.assertOnline();
    return lx.testSource(String(body.id ?? ""));
  }
  if (path === "/sources/check" && method === "POST") {
    music.assertOnline();
    return startSourceCheck(
      store,
      lx,
      body.id === undefined ? undefined : String(body.id),
    );
  }
  if (path === "/sources/check-status" && method === "GET")
    return sourceCheckStatus(store);
  if (path === "/sources/check-stop" && method === "POST")
    return stopSourceCheck(store);
  if (path === "/sources/routing" && method === "PUT")
    return lx.updateRouting(
      String(body.id ?? ""),
      String(body.platform ?? ""),
      body.enabled,
      body.priority,
    );
  if (path === "/lyrics" && method === "POST") {
    const queue = store.snapshot().config.playbackQueue;
    const track = body.track
      ? music.requestedTrack(body.track)
      : queue.tracks[queue.currentIndex];
    return track
      ? music.lyrics(track)
      : { available: false, lyric: "", lines: [], reason: "no_metadata" };
  }
  if (path === "/settings" && method === "GET")
    return {
      quality: store.snapshot().config.lxQuality,
      qualityFallback: store.snapshot().config.lxQualityFallback,
      maxScriptBytes: MAX_LX_SCRIPT_BYTES,
    };
  if (path === "/settings" && method === "PUT") {
    if (
      body.quality !== undefined &&
      !["128k", "320k", "flac", "flac24bit"].includes(body.quality)
    )
      throw new Error("音质设置无效");
    if (
      body.qualityFallback !== undefined &&
      typeof body.qualityFallback !== "boolean"
    )
      throw new Error("音质降级设置无效");
    await store.update((state) => {
      if (body.quality !== undefined) state.config.lxQuality = body.quality;
      if (body.qualityFallback !== undefined)
        state.config.lxQualityFallback = body.qualityFallback;
    });
    return {
      quality: store.snapshot().config.lxQuality,
      qualityFallback: store.snapshot().config.lxQualityFallback,
    };
  }
  if (path === "/catalog" && method === "POST") {
    music.assertOnline();
    const platform = lxPlatform(body.source_id ?? "wy");
    const page = pageNumber(body.page);
    const text = (value: unknown) => {
      if (typeof value !== "string" || !value.trim() || value.length > 500)
        throw new Error("搜索文字或标识无效");
      return value.trim();
    };
    switch (body.operation) {
      case "search":
        return lx.catalog.search(platform, text(body.keyword), page, body.type);
      case "hotsearch":
        return lx.catalog.call(platform, "hot", "getList");
      case "songlist/search":
        return lx.catalog.search(
          platform,
          text(body.keyword),
          page,
          "songlist",
        );
      case "songlist/detail":
        return lx.catalog.call(
          platform,
          "list",
          "getListDetail",
          text(body.id),
          ...(platform === "tx" ? [] : [page]),
        );
      case "songlist/list":
        return lx.catalog.call(
          platform,
          "list",
          "getList",
          String(body.sort_id ?? ""),
          String(body.tag_id ?? ""),
          page,
        );
      case "songlist/tags": {
        const result = await lx.catalog.call(platform, "list", "getTags");
        return { ...result, hot: result.hotTag ?? result.hot ?? [] };
      }
      case "songlist/sorts":
        return lx.catalog.sorts(platform);
      case "leaderboard/boards": {
        const result = await lx.catalog.call(platform, "board", "getBoards");
        return result.list ?? [];
      }
      case "leaderboard/list":
        return lx.catalog.call(
          platform,
          "board",
          "getList",
          text(body.board_id),
          page,
        );
      default:
        throw new Error("不支持的音乐目录操作");
    }
  }
  if (path === "/player/browser" && method === "POST") {
    const { playUrl, ...publicTrack } = music.requestedTrack(body.track);
    const url = await music.resolveBrowserPlayback({ ...publicTrack, playUrl });
    return { url, track: publicTrack };
  }
  if (path === "/player/play" && method === "POST") {
    const deviceId = body.deviceId ?? store.snapshot().config.selectedDeviceId;
    if (!deviceId) throw new Error("请先在音箱设备中连接并选择音箱");
    if (!Array.isArray(body.tracks) || !body.tracks.length)
      throw new Error("播放队列至少需要一首歌曲");
    const index = body.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= body.tracks.length)
      throw new Error("播放索引无效");
    return playback.replaceAndPlay(
      deviceId,
      body.tracks.map((raw: any) => music.requestedTrack(raw)),
      index,
    );
  }
  if (path === "/player/queue" && method === "POST") {
    if (body.operation === "append") {
      if (!Array.isArray(body.tracks)) throw new Error("队列歌曲无效");
      return playback.enqueue(
        body.tracks.map((raw: any) => music.requestedTrack(raw)),
      );
    }
    if (body.operation === "remove" || body.operation === "move")
      return playback.editQueue(
        body.operation,
        body.index,
        body.to,
        String(body.revision ?? ""),
      );
    throw new Error("不支持的队列操作");
  }
  if (path === "/playlists" && method === "GET")
    return { playlists: lx.playlists(), total: lx.playlists().length };
  if (path === "/playlists/import" && method === "POST") {
    music.assertOnline();
    const id = String(body.songlist_id ?? "");
    if (!id || id.length > 500) throw new Error("歌单标识无效");
    const saved = await lx.importRemotePlaylist(
      String(body.source_id),
      id,
      String(body.new_playlist_name ?? ""),
      body.playlist_id ? String(body.playlist_id) : undefined,
    );
    return { success: saved.count, failed: 0, playlist_id: saved.id };
  }
  if (path === "/playlists" && method === "POST") {
    if (!Array.isArray(body.songs)) throw new Error("歌单歌曲无效");
    return lx.savePlaylist(
      String(body.name ?? ""),
      body.songs,
      body.id ? String(body.id) : undefined,
    );
  }
  if (path === "/playlist" && method === "GET") {
    const list = lx.playlistTracks(url.searchParams.get("id") ?? "");
    return {
      ...list,
      songs: list.tracks.map(toLxSong),
      total: list.tracks.length,
    };
  }
  if (path === "/playlists" && method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || id === "favorites") throw new Error("不能删除系统收藏");
    await store.update((state) => {
      const index = state.config.lxPlaylists.findIndex(
        (list) => list.id === id,
      );
      if (index < 0) throw new Error("找不到歌单");
      state.config.lxPlaylists.splice(index, 1);
    });
    return { deleted: true };
  }
  throw new Error("不支持的播放器接口");
}
function pageNumber(raw: unknown): number {
  if (raw === undefined) return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > 1000)
    throw new Error("分页参数无效");
  return page;
}
