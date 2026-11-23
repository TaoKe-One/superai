import { libraryRef } from "../library/config.ts";
import { createHash, randomUUID } from "node:crypto";
import type { JsonStore, StoredTrack } from "../../storage/store.ts";
import { validLxTrack } from "../../storage/store.ts";
import type { MusicTrack, MusicSource } from "../types.ts";
import {
  LxCatalog,
  lxPlatform,
  PLATFORMS,
  type LxPlatform,
} from "./catalog.ts";
import { runLxScript } from "./runtime.ts";
import { publicRequest, publicUrl } from "./http.ts";
import { probeAudio } from "./probe.ts";
import { rankSources, healthSample, LxResolutionError } from "./health.ts";
import type { ResolutionAttempt, SourceHealth } from "./health.ts";
import { trackLyrics } from "./lyrics.ts";
import {
  completePlaylist,
  playlistQuery,
  playlistScore,
  playlistPopularity,
} from "../playlist-query.ts";

export class LxMusicService {
  readonly catalog: LxCatalog;
  private store: JsonStore;
  private fetchImpl?: typeof fetch;
  constructor(store: JsonStore, fetchImpl?: typeof fetch) {
    this.store = store;
    this.fetchImpl = fetchImpl === fetch ? undefined : fetchImpl;
    this.catalog = new LxCatalog(this.fetchImpl);
  }
  sources() {
    return this.store
      .snapshot()
      .config.lxSources.map(({ script, ...metadata }) => metadata);
  }
  async importScript(script: string) {
    const metadata = await runLxScript(script, undefined, this.fetchImpl);
    const id = createHash("sha256").update(script).digest("hex").slice(0, 24);
    await this.store.update((state) => {
      if (state.config.lxSources.some((s) => s.id === id)) return;
      if (state.config.lxSources.length >= 8)
        throw new Error("LX 音源最多导入 8 个");
      state.config.lxSources.push({
        ...metadata,
        id,
        enabled: true,
        script: this.store.encrypt(script),
      });
    });
    return this.sources().find((source) => source.id === id);
  }
  async importUrl(url: string) {
    publicUrl(url);
    const response = await publicRequest(url);
    if (response.statusCode !== 200) throw new Error("下载音源脚本失败");
    return this.importScript(response.raw.toString("utf8"));
  }
  async changeSource(id: string, enabled?: boolean) {
    await this.store.update((state) => {
      const index = state.config.lxSources.findIndex((s) => s.id === id);
      if (index < 0) throw new Error("找不到该音源");
      if (enabled === undefined) state.config.lxSources.splice(index, 1);
      else state.config.lxSources[index].enabled = enabled;
    });
    return this.sources();
  }
  async testSource(id: string) {
    const source = this.store
      .snapshot()
      .config.lxSources.find((s) => s.id === id);
    if (!source) throw new Error("找不到该音源");
    return runLxScript(
      this.store.decrypt(source.script),
      undefined,
      this.fetchImpl,
    );
  }
  async lyrics(raw?: unknown) {
    const queue = this.store.snapshot().config.playbackQueue;
    const track = raw
      ? this.requestedTrack(raw)
      : queue.tracks[queue.currentIndex];
    return trackLyrics(this.store, this.catalog, track);
  }
  async updateRouting(
    id: string,
    platform: string,
    enabled: boolean,
    priority: number,
  ) {
    lxPlatform(platform);
    if (
      typeof enabled !== "boolean" ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 100
    )
      throw new Error("平台启用状态或优先级无效（0—100）");
    await this.store.update((state) => {
      const source = state.config.lxSources.find((s) => s.id === id);
      if (!source?.sources[platform]) throw new Error("音源不支持该平台");
      (source.routing ??= {})[platform] = { enabled, priority };
    });
    return this.sources();
  }
  async resolveTrack(track: MusicTrack): Promise<string> {
    return (await this.resolve(track, false)).url;
  }
  async resolvePlayback(track: MusicTrack, signal?: AbortSignal) {
    return this.resolve(track, true, signal);
  }
  async checkPlatform(id: string, track: MusicTrack, signal: AbortSignal) {
    const source = this.store
      .snapshot()
      .config.lxSources.find((s) => s.id === id);
    if (!source || !track.lx || !source.sources[track.lx.platform])
      throw new Error("找不到音源或平台");
    const attempts: ResolutionAttempt[] = [];
    return this.trySource(
      source,
      track,
      true,
      Date.now() + 12000,
      attempts,
      signal,
      true,
    );
  }
  private async recordHealth(
    id: string,
    platform: string,
    ok: boolean,
    elapsedMs: number,
    reason: SourceHealth["reason"],
    quality: string,
  ) {
    await this.store.update((state) => {
      const source = state.config.lxSources.find((s) => s.id === id);
      if (source)
        (source.health ??= {})[platform] = healthSample(
          source.health?.[platform],
          ok,
          elapsedMs,
          reason,
          quality,
        );
    });
  }
  private async resolve(
    track: MusicTrack,
    verifyAudio: boolean,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!track.lx) {
      if (!track.playUrl) throw new Error("歌曲缺少播放地址");
      return { url: validPlaybackUrl(track.playUrl) };
    }
    const { platform } = track.lx;
    const config = this.store.snapshot().config;
    const sources = rankSources(
      config.lxSources.filter(
        (s) => s.enabled && s.sources[platform]?.actions.includes("musicUrl"),
      ),
      platform,
    );
    if (!sources.length)
      throw new Error("请在音乐源管理中导入支持该平台的 LX 自定义音源");
    const deadline = Date.now() + 25000;
    const attempts: ResolutionAttempt[] = [];
    for (const source of sources) {
      signal?.throwIfAborted();
      if (deadline - Date.now() < 200) break;
      const current = this.store
        .snapshot()
        .config.lxSources.find((s) => s.id === source.id);
      if (!current?.enabled || current.routing?.[platform]?.enabled === false)
        continue;
      try {
        return await this.trySource(
          source,
          track,
          verifyAudio,
          Math.min(deadline, Date.now() + 12000),
          attempts,
          signal,
        );
      } catch {
        signal?.throwIfAborted();
        // Only resolution/audio checks fail over, before sending any speaker command.
      }
    }
    throw new LxResolutionError(attempts);
  }
  private async trySource(
    source: ReturnType<JsonStore["snapshot"]>["config"]["lxSources"][number],
    track: MusicTrack,
    verifyAudio: boolean,
    deadline: number,
    attempts: ResolutionAttempt[],
    signal?: AbortSignal,
    checkingDisabledSource = false,
  ) {
    const { platform, songInfo } = track.lx!;
    const config = this.store.snapshot().config;
    const supported = source.sources[platform].qualitys;
    const order = ["flac24bit", "flac", "320k", "128k"];
    const wanted = track.quality ?? config.lxQuality;
    const lower = order
      .slice(Math.max(0, order.indexOf(wanted)))
      .filter((q) => supported.includes(q));
    const qualities = (lower.length ? lower : supported.slice(-1)).slice(
      0,
      config.lxQualityFallback ? 4 : 1,
    );
    const sourceStarted = Date.now();
    let lastReason: SourceHealth["reason"] = "resolve",
      lastQuality = qualities[0] ?? "";
    for (const quality of qualities) {
      if (signal?.aborted) throw new Error("音源检测已取消");
      const current = this.store
        .snapshot()
        .config.lxSources.find((s) => s.id === source.id);
      if (
        !current ||
        (!checkingDisabledSource &&
          (!current.enabled || current.routing?.[platform]?.enabled === false))
      )
        throw new LxResolutionError([...attempts]);
      const remaining = deadline - Date.now();
      if (remaining < 200) break;
      lastQuality = quality;
      let stage: ResolutionAttempt["stage"] = "resolve";
      const started = Date.now();
      try {
        const result = await runLxScript(
          this.store.decrypt(source.script),
          {
            source: platform,
            action: "musicUrl",
            info: { type: quality, musicInfo: structuredClone(songInfo) },
          },
          this.fetchImpl,
          Math.max(100, Math.min(10000, remaining - (verifyAudio ? 1000 : 0))),
          signal,
        );
        const url = validPlaybackUrl(result);
        publicUrl(url);
        if (verifyAudio) {
          stage = "audio";
          const probeSignal = AbortSignal.timeout(
            Math.max(1, Math.min(5000, deadline - Date.now())),
          );
          await probeAudio(
            url,
            signal ? AbortSignal.any([signal, probeSignal]) : probeSignal,
            this.fetchImpl,
          );
          if (signal?.aborted) throw new Error("音源检测已取消");
        }
        const current = this.store
          .snapshot()
          .config.lxSources.find((s) => s.id === source.id);
        if (
          !current ||
          (!checkingDisabledSource &&
            (!current.enabled ||
              current.routing?.[platform]?.enabled === false))
        )
          throw new Error("音源设置已变化");
        if (verifyAudio)
          await this.recordHealth(
            source.id,
            platform,
            true,
            Date.now() - sourceStarted,
            "ok",
            quality,
          );
        attempts.push({
          sourceId: source.id,
          sourceName: source.name,
          platform,
          quality,
          stage: "ready",
          ok: true,
          elapsedMs: Date.now() - started,
        });
        return {
          url,
          sourceId: source.id,
          sourceName: source.name,
          platform,
          quality,
          attempts: [...attempts],
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("音源检测已取消");
        lastReason =
          Date.now() >= deadline ||
          /超时|timeout/i.test(String((error as Error)?.message))
            ? "timeout"
            : stage;
        attempts.push({
          sourceId: source.id,
          sourceName: source.name,
          platform,
          quality,
          stage,
          ok: false,
          elapsedMs: Date.now() - started,
        });
      }
    }
    if (verifyAudio)
      await this.recordHealth(
        source.id,
        platform,
        false,
        Date.now() - sourceStarted,
        lastReason,
        lastQuality,
      );
    throw new LxResolutionError([...attempts]);
  }
  assistantSources(signal?: AbortSignal): MusicSource[] {
    const configured = this.store.snapshot().config.lxSources;
    const supported = new Set(
      PLATFORMS.filter(
        (p) =>
          rankSources(
            configured.filter(
              (s) => s.enabled && s.sources[p]?.actions.includes("musicUrl"),
            ),
            p,
          ).length,
      ),
    );
    return PLATFORMS.filter((p) => supported.has(p)).map((platform) => ({
      id: "lx-" + platform,
      search: async (request) => {
        const result = await this.catalog.search(
          platform,
          [request.artist, request.title].filter(Boolean).join(" "),
          1,
          "song",
          signal,
        );
        return result.list.map((raw: any) => fromLxSong(raw, platform));
      },
    }));
  }
  async playlist(
    name: string,
    signal?: AbortSignal,
    excludedPlatform?: LxPlatform,
  ): Promise<MusicTrack[]> {
    signal?.throwIfAborted();
    const deadline = AbortSignal.any([
      AbortSignal.timeout(25000),
      ...(signal ? [signal] : []),
    ]);
    const supported = PLATFORMS.filter(
      (platform) =>
        platform !== excludedPlatform &&
        rankSources(
          this.sources().filter(
            (s) =>
              s.enabled && s.sources[platform]?.actions.includes("musicUrl"),
          ),
          platform,
        ).length,
    );
    const saved = this.store
      .snapshot()
      .config.lxPlaylists.find(
        (list) => list.name.normalize("NFKC") === name.normalize("NFKC"),
      );
    if (saved && excludedPlatform) return [];
    if (saved)
      return saved.tracks.map((track) => ({
        ...track,
        playUrl: track.playUrl ? this.store.decrypt(track.playUrl) : undefined,
      }));
    const query = playlistQuery(name);
    const candidates: Array<{
      platform: (typeof PLATFORMS)[number];
      list: any;
      score: number;
    }> = [];
    const failures: string[] = [];
    await Promise.all(
      supported.map(async (platform) => {
        try {
          const result = await this.catalog.search(
            platform,
            query.keyword,
            1,
            "songlist",
            deadline,
          );
          for (const list of result.list) {
            const score = playlistScore(query, String(list.name ?? ""));
            if (score && list.id != null)
              candidates.push({ platform, list, score });
          }
        } catch {
          failures.push(platform + " 歌单搜索失败");
        }
      }),
    );
    signal?.throwIfAborted();
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        playlistPopularity(b.list.play_count) -
          playlistPopularity(a.list.play_count) ||
        PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) ||
        String(a.list.id).localeCompare(String(b.list.id)),
    );
    for (const { platform, list } of candidates.slice(0, 5)) {
      try {
        const tracks = await completePlaylist(
          async (page) => {
            const detail = await this.catalog.request(
              platform,
              "list",
              "getListDetail",
              [String(list.id), ...(platform === "tx" ? [] : [page])],
              deadline,
            );
            // TX's upstream detail API returns the entire list in one request.
            if (platform === "tx" && detail.has_more)
              throw new Error("歌单接口未完整返回曲目");
            return {
              items: (detail.list ?? []).map((raw: any) =>
                fromLxSong(raw, platform),
              ),
              hasMore: !!detail.has_more,
            };
          },
          (track: MusicTrack) => track.sourceId + ":" + track.id,
          deadline,
        );
        signal?.throwIfAborted();
        if (tracks.length) return tracks;
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(
          error instanceof Error && /重复|完整/u.test(error.message)
            ? error.message
            : platform + " 歌单曲目读取失败",
        );
      }
    }
    if (failures.length || deadline.aborted)
      throw new Error(
        "歌单目录读取失败：" + (failures.join("；") || "读取超时"),
      );
    return [];
  }
  playlists() {
    const config = this.store.snapshot().config;
    return [
      { id: "favorites", name: "收藏", song_count: config.favorites.length },
      ...config.lxPlaylists.map((list) => ({
        id: list.id,
        name: list.name,
        song_count: list.tracks.length,
      })),
    ];
  }
  playlistTracks(id: string) {
    const config = this.store.snapshot().config;
    const list =
      id === "favorites"
        ? { id, name: "收藏", tracks: config.favorites }
        : config.lxPlaylists.find((list) => list.id === id);
    if (!list) throw new Error("找不到歌单");
    return {
      id: list.id,
      name: list.name,
      tracks: list.tracks.map(({ playUrl, ...track }) => track),
    };
  }
  requestedTrack(raw: unknown): MusicTrack {
    const privateTrack = libraryRef(raw);
    if (privateTrack) return privateTrack;
    const value = raw as any;
    if (value?.sourceId && !value.lx && !value.playUrl) {
      const config = this.store.snapshot().config;
      const saved = [
        ...config.playbackQueue.tracks,
        ...Object.values(config.devicePlaybackQueues).flatMap(
          (queue) => queue.tracks,
        ),
        ...config.favorites,
        ...config.playbackHistory.map((entry) => entry.track),
        ...config.lxPlaylists.flatMap((list) => list.tracks),
      ].find(
        (track) => track.id === value.id && track.sourceId === value.sourceId,
      );
      if (!saved) throw new Error("找不到保存的歌曲，请刷新列表");
      return {
        ...saved,
        playUrl: saved.playUrl ? this.store.decrypt(saved.playUrl) : undefined,
      };
    }
    return fromLxSong(raw);
  }
  async importRemotePlaylist(
    platform: string,
    remoteId: string,
    name: string,
    destination?: string,
  ) {
    const source = lxPlatform(platform),
      signal = AbortSignal.timeout(25000);
    const tracks: MusicTrack[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 40; page++) {
      const result = await this.catalog.request(
        source,
        "list",
        "getListDetail",
        [remoteId, ...(source === "tx" ? [] : [page])],
        signal,
      );
      name ||= result.info?.name || "导入歌单";
      const previousCount = tracks.length;
      for (const raw of result.list ?? []) {
        const track = fromLxSong(raw, source);
        if (!seen.has(track.id)) {
          seen.add(track.id);
          tracks.push(track);
        }
      }
      if (tracks.length > 1000 || Number(result.total) > 1000)
        throw new Error("歌单超过 1000 首，请选择部分歌曲导入");
      if (page > 1 && tracks.length === previousCount && result.has_more)
        throw new Error("歌单接口重复返回同一页，请打开详情后选择歌曲导入");
      if (!result.has_more) return this.savePlaylist(name, tracks, destination);
      if (
        source === "tx" ||
        !result.list?.length ||
        tracks.length >= Number(result.total || Infinity)
      )
        break;
      if (page === 40) throw new Error("歌单分页过多，请选择部分歌曲导入");
    }
    throw new Error("未能完整获取歌单，请打开详情后选择歌曲导入");
  }
  async savePlaylist(name: string, raw: unknown[], id?: string) {
    name = name.trim();
    if (!name.trim() || name.length > 80 || raw.length > 1000)
      throw new Error("歌单名称或歌曲数量无效");
    const tracks = raw.map((item) => this.requestedTrack(item));
    const key = id || randomUUID();
    let count = 0;
    await this.store.update((state) => {
      if (id === "favorites") {
        for (const track of tracks)
          if (
            !state.config.favorites.some(
              (item) =>
                item.id === track.id && item.sourceId === track.sourceId,
            )
          ) {
            state.config.favorites.push({
              ...track,
              playUrl: track.playUrl ? this.store.encrypt(track.playUrl) : "",
            });
            count++;
          }
        if (state.config.favorites.length > 5000)
          throw new Error("收藏最多 5000 首");
        return;
      }
      if (
        state.config.lxPlaylists.some(
          (list) => list.name === name && list.id !== key,
        )
      )
        throw new Error("歌单名称已存在");
      const list = state.config.lxPlaylists.find((list) => list.id === key);
      if (id && !list) throw new Error("目标歌单已不存在，请重新选择");
      const additions = tracks.map((track) => ({
        ...track,
        playUrl: track.playUrl ? this.store.encrypt(track.playUrl) : "",
      }));
      if (list) {
        for (const track of additions)
          if (
            !list.tracks.some(
              (t) => t.id === track.id && t.sourceId === track.sourceId,
            )
          ) {
            list.tracks.push(track);
            count++;
          }
        if (list.tracks.length > 1000) throw new Error("歌单最多 1000 首");
      } else {
        if (state.config.lxPlaylists.length >= 100)
          throw new Error("最多保存 100 个歌单");
        const unique = additions.filter(
          (track, index) =>
            additions.findIndex(
              (item) =>
                item.id === track.id && item.sourceId === track.sourceId,
            ) === index,
        );
        state.config.lxPlaylists.push({ id: key, name, tracks: unique });
        count = unique.length;
      }
    });
    return { id: key, name, count };
  }
}

export function fromLxSong(value: unknown, platformHint?: string): MusicTrack {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 20000
  )
    throw new Error("歌曲信息无效");
  const raw = value as Record<string, any>;
  if (
    raw.sourceId &&
    (validLxTrack(raw.lx) || (typeof raw.playUrl === "string" && raw.playUrl))
  ) {
    return {
      id: required(raw.id),
      sourceId: raw.lx ? "lx-" + raw.lx.platform : required(raw.sourceId),
      title: required(raw.title),
      artist: required(raw.artist),
      ...(raw.lx
        ? { lx: structuredClone(raw.lx) }
        : { playUrl: validPlaybackUrl(raw.playUrl) }),
      ...(["128k", "320k", "flac", "flac24bit"].includes(raw.quality)
        ? { quality: raw.quality }
        : {}),
      ...(raw.coverUrl
        ? { coverUrl: String(raw.coverUrl).slice(0, 2000) }
        : {}),
      ...(Number.isFinite(raw.durationSeconds)
        ? { durationSeconds: raw.durationSeconds }
        : {}),
      ...(raw.album ? { album: String(raw.album).slice(0, 300) } : {}),
    };
  }
  let data = raw.source_data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error("歌曲源数据无效");
    }
  }
  const info = data?.songInfo ?? raw;
  const platform = lxPlatform(platformHint ?? data?.platform ?? raw.source);
  const title = required(raw.name ?? raw.title ?? info.name);
  const artist = required(
    raw.singer ?? raw.artist ?? info.singer ?? "未知歌手",
  );
  const identifier = required(
    info.songmid ??
      info.musicId ??
      info.hash ??
      info.copyrightId ??
      info.songId ??
      raw.id,
  );
  const songInfo = structuredClone(info);
  delete songInfo.source_data;
  delete songInfo.playUrl;
  delete songInfo.url;
  const lx = { platform, songInfo };
  if (!validLxTrack(lx)) throw new Error("歌曲源数据无效");
  const duration =
    typeof raw.duration === "number"
      ? raw.duration
      : parseDuration(raw.interval ?? info.interval);
  return {
    id: identifier,
    sourceId: "lx-" + platform,
    title,
    artist,
    lx,
    ...(["128k", "320k", "flac", "flac24bit"].includes(
      raw.quality ?? data?.quality,
    )
      ? { quality: raw.quality ?? data.quality }
      : {}),
    ...((raw.albumName ?? raw.album)
      ? { album: String(raw.albumName ?? raw.album).slice(0, 300) }
      : {}),
    ...(duration > 0 ? { durationSeconds: duration } : {}),
    ...((raw.img ?? raw.cover_url)
      ? { coverUrl: String(raw.img ?? raw.cover_url).slice(0, 2000) }
      : {}),
  };
}
export function toLxSong(
  track: Omit<StoredTrack, "playUrl"> | MusicTrack,
): Record<string, unknown> {
  return {
    id: track.id,
    name: track.title,
    title: track.title,
    singer: track.artist,
    artist: track.artist,
    album: track.album ?? "",
    duration: track.durationSeconds ?? 0,
    durationSeconds: track.durationSeconds,
    coverUrl: track.coverUrl,
    cover_url: track.coverUrl ?? "",
    source: track.lx?.platform ?? track.sourceId,
    sourceId: track.sourceId,
    lx: track.lx,
    library: track.library,
    quality: track.quality,
    source_data: track.lx
      ? {
          platform: track.lx.platform,
          songInfo: track.lx.songInfo,
          quality: track.quality,
        }
      : undefined,
  };
}
function required(value: unknown): string {
  const s =
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  if (!s || s.length > 500) throw new Error("歌曲信息无效");
  return s;
}
function parseDuration(value: unknown): number {
  if (typeof value !== "string") return 0;
  return value.split(":").reduce((sum, n) => sum * 60 + (Number(n) || 0), 0);
}
function validPlaybackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("音源没有返回有效 HTTP 地址");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("音源没有返回有效 HTTP 地址");
  return url.toString();
}
