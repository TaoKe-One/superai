import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LxSourceMetadata } from "../music/lx/runtime.ts";
import type { MusicTrack } from "../music/types.ts";
import { isPlaybackMode, type PlaybackMode } from "../playback/mode.ts";
import type { SourceRouting, SourceHealthMap } from "../music/lx/health.ts";

import { defaultMusicServices, libraryRef } from "../music/library/config.ts";
import type {
  MusicServicesConfig,
  LibraryIndex,
} from "../music/library/config.ts";

export interface MusicSourceConfig {
  id: string;
  name: string;
  protocol?: "http-json" | "topone";
  endpoint: string;
  playlistEndpoint?: string;
  enabled: boolean;
  apiKey: string;
}

export interface StoredTrack {
  id: string;
  sourceId: string;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
  quality?: string;
  playUrl: string;
  lx?: MusicTrack["lx"];
  library?: MusicTrack["library"];
  coverUrl?: string;
}

export type { PlaybackMode } from "../playback/mode.ts";

export interface MiotDevice {
  deviceId: string;
  name: string;
  model: string;
  hardware: string;
  presence: string;
  location?: string;
}

export interface StoredState {
  version: 1;
  admin: null | { salt: string; hash: string };
  config: {
    ai: { baseUrl: string; model: string; apiKey: string; provider?: string };
    webSearch: { apiKey: string; mode?: "auto" | "off" | "external" };
    musicServices: MusicServicesConfig;
    libraryIndexes: Record<string, LibraryIndex>;
    musicSources: MusicSourceConfig[];
    lxSources: Array<
      LxSourceMetadata & {
        id: string;
        enabled: boolean;
        script: string;
        routing?: SourceRouting;
        health?: SourceHealthMap;
      }
    >;
    lxQuality: string;
    lxQualityFallback: boolean;
    lxPlaylists: Array<{ id: string; name: string; tracks: StoredTrack[] }>;
    playbackQueue: { tracks: StoredTrack[]; currentIndex: number };
    devicePlaybackQueues: Record<
      string,
      { tracks: StoredTrack[]; currentIndex: number }
    >;
    playbackMode: PlaybackMode;
    favorites: StoredTrack[];
    playbackHistory: Array<{ track: StoredTrack; playedAt: number }>;
    voiceMonitorEnabled: boolean;
    selectedDeviceId: string;
    defaultLocation: string;
    devices: MiotDevice[];
    xiaomi: null | {
      userId: string;
      passToken: string;
      cUserId?: string;
      serviceToken: string;
      serviceTokenExpiresAt: number;
    };
  };
}

const freshState = (): StoredState => ({
  version: 1,
  admin: null,
  config: {
    ai: { baseUrl: "", model: "", apiKey: "" },
    webSearch: { apiKey: "" },
    musicServices: defaultMusicServices(),
    libraryIndexes: {},
    musicSources: [],
    lxSources: [],
    lxQuality: "320k",
    lxQualityFallback: true,
    lxPlaylists: [],
    playbackQueue: { tracks: [], currentIndex: -1 },
    devicePlaybackQueues: {},
    playbackMode: "order",
    favorites: [],
    playbackHistory: [],
    voiceMonitorEnabled: false,
    selectedDeviceId: "",
    defaultLocation: "",
    devices: [],
    xiaomi: null,
  },
});

export class JsonStore {
  private state = freshState();
  private readonly filePath: string;
  private readonly configuredKey?: string;
  private key!: Buffer;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    dataDir = process.env.DATA_DIR ?? "./data",
    masterKey = process.env.MASTER_KEY,
  ) {
    this.filePath = join(dataDir, "state.json");
    this.configuredKey = masterKey;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700);
    const configuredKey = this.configuredKey;
    if (configuredKey) {
      if (Buffer.byteLength(configuredKey) < 32)
        throw new Error(
          "MASTER_KEY 至少需要 32 个字节；请使用安全随机生成的密钥",
        );
      this.key = createHash("sha256").update(configuredKey).digest();
    } else {
      const keyPath = join(dirname(this.filePath), "master.key");
      try {
        this.key = await readFile(keyPath);
        if (this.key.length !== 32) throw new Error("invalid master key file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.key = randomBytes(32);
        await writeFile(keyPath, this.key, { mode: 0o600, flag: "wx" }).catch(
          async (writeError: NodeJS.ErrnoException) => {
            if (writeError.code !== "EEXIST") throw writeError;
            this.key = await readFile(keyPath);
          },
        );
      }
      if (this.key.length !== 32) throw new Error("invalid master key file");
      await chmod(keyPath, 0o600);
    }

    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      const normalized = normalizeState(raw);
      try {
        this.verifyEncryptedState(normalized);
      } catch {
        throw new Error(
          "无法解密数据文件，请检查 MASTER_KEY 是否与首次启动时一致，或检查数据文件是否损坏",
        );
      }
      await chmod(this.filePath, 0o600);
      this.state = normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  snapshot(): StoredState {
    return structuredClone(this.state);
  }

  logSecrets() {
    const { config } = this.state;
    const encrypted = [
      config.ai.apiKey,
      config.webSearch.apiKey,
      config.xiaomi?.serviceToken,
      config.xiaomi?.passToken,
      config.xiaomi?.cUserId,
      ...config.musicSources.map((source) => source.apiKey),
      ...config.musicServices.libraries.flatMap((library) => [
        library.password,
        library.accessCode,
      ]),
    ];
    const secrets: string[] = [];
    for (const cipher of encrypted) {
      if (!cipher) continue;
      try {
        secrets.push(this.decrypt(cipher));
      } catch {
        // A malformed setting must not prevent logging the operation.
      }
    }
    return secrets.sort((a, b) => b.length - a.length);
  }

  sign(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }

  decrypt(value: string): string {
    const payload = Buffer.from(value, "base64");
    if (payload.length < 29) throw new Error("encrypted setting is invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      payload.subarray(0, 12),
    );
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([
      decipher.update(payload.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }

  async update(mutator: (state: StoredState) => void): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const next = structuredClone(this.state);
      mutator(next);
      await this.persist(next);
      this.state = next;
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async persist(state = this.state): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }

  private verifyEncryptedState(state: StoredState): void {
    const ciphertexts = [
      state.config.ai.apiKey,
      state.config.webSearch.apiKey,
      ...state.config.musicServices.libraries.flatMap((s) => [
        s.password,
        s.accessCode,
      ]),
      ...state.config.musicSources.map((source) => source.apiKey),
      ...state.config.lxSources.map((source) => source.script),
      ...state.config.lxPlaylists.flatMap((list) =>
        list.tracks.map((track) => track.playUrl),
      ),
      ...state.config.playbackQueue.tracks.map((track) => track.playUrl),
      ...Object.values(state.config.devicePlaybackQueues).flatMap((queue) =>
        queue.tracks.map((track) => track.playUrl),
      ),
      ...state.config.favorites.map((track) => track.playUrl),
      ...state.config.playbackHistory.map((item) => item.track.playUrl),
      ...(state.config.xiaomi
        ? [
            state.config.xiaomi.passToken,
            state.config.xiaomi.cUserId ?? "",
            state.config.xiaomi.serviceToken,
          ]
        : []),
    ];
    for (const ciphertext of ciphertexts)
      if (ciphertext) this.decrypt(ciphertext);
  }
}

function normalizeState(value: unknown): StoredState {
  if (!record(value) || value.version !== 1 || !record(value.config))
    throw new Error("unsupported data file format");
  const defaults = freshState();
  const config = value.config;
  if (config.ai !== undefined && !record(config.ai))
    throw new Error("AI 配置格式无效");
  if (config.webSearch !== undefined && !record(config.webSearch))
    throw new Error("联网搜索配置格式无效");
  const ai = record(config.ai) ? config.ai : {};
  const webSearch = record(config.webSearch) ? config.webSearch : {};
  if (!Array.isArray(config.musicSources) || config.musicSources.length > 16)
    throw new Error("音乐源配置格式无效");
  const musicSources = config.musicSources.map((source) => {
    if (
      !record(source) ||
      !string(source.id) ||
      !string(source.name) ||
      !string(source.endpoint) ||
      typeof source.enabled !== "boolean" ||
      typeof source.apiKey !== "string"
    ) {
      throw new Error("音乐源配置格式无效");
    }
    if (
      source.protocol !== undefined &&
      source.protocol !== "http-json" &&
      source.protocol !== "topone"
    )
      throw new Error("音乐源协议无效");
    if (
      source.playlistEndpoint !== undefined &&
      typeof source.playlistEndpoint !== "string"
    )
      throw new Error("歌单接口配置格式无效");
    return {
      id: source.id,
      name: source.name,
      protocol: source.protocol,
      endpoint: source.endpoint,
      playlistEndpoint:
        source.playlistEndpoint === undefined
          ? undefined
          : string(source.playlistEndpoint),
      enabled: source.enabled,
      apiKey: source.apiKey,
    };
  });
  const queue = record(config.playbackQueue)
    ? config.playbackQueue
    : defaults.config.playbackQueue;
  if (!Array.isArray(queue.tracks) || !Number.isInteger(queue.currentIndex))
    throw new Error("播放队列格式无效");
  const tracks = queue.tracks.map((track) => {
    if (
      !record(track) ||
      !string(track.id) ||
      !string(track.sourceId) ||
      !string(track.title) ||
      !string(track.artist) ||
      !(string(track.playUrl) || validLxTrack(track.lx) || libraryRef(track))
    )
      throw new Error("播放队列格式无效");
    return {
      id: track.id,
      sourceId: track.sourceId,
      title: track.title,
      artist: track.artist,
      ...(track.album === undefined ? {} : { album: string(track.album) }),
      ...(track.durationSeconds === undefined
        ? {}
        : { durationSeconds: number(track.durationSeconds) }),
      ...(track.quality === undefined
        ? {}
        : { quality: string(track.quality) }),
      playUrl: track.playUrl,
      ...(validLxTrack(track.lx) ? { lx: structuredClone(track.lx) } : {}),
      ...(libraryRef(track) ? { library: libraryRef(track)!.library } : {}),
      ...(typeof track.coverUrl === "string"
        ? { coverUrl: track.coverUrl }
        : {}),
    };
  });
  if (queue.currentIndex < -1 || queue.currentIndex >= tracks.length)
    throw new Error("播放队列当前位置无效");
  const playbackMode =
    config.playbackMode === undefined
      ? defaults.config.playbackMode
      : config.playbackMode;
  if (!isPlaybackMode(playbackMode)) throw new Error("播放模式无效");
  const normalizeSavedTrack = (track: unknown): StoredTrack => {
    if (
      !record(track) ||
      !string(track.id) ||
      !string(track.sourceId) ||
      !string(track.title) ||
      !string(track.artist) ||
      !(string(track.playUrl) || validLxTrack(track.lx) || libraryRef(track))
    )
      throw new Error("歌曲信息无效");
    return {
      id: string(track.id),
      sourceId: string(track.sourceId),
      title: string(track.title),
      artist: string(track.artist),
      playUrl: string(track.playUrl),
      ...(validLxTrack(track.lx) ? { lx: structuredClone(track.lx) } : {}),
      ...(libraryRef(track) ? { library: libraryRef(track)!.library } : {}),
      ...(typeof track.coverUrl === "string"
        ? { coverUrl: track.coverUrl }
        : {}),
      ...(track.album === undefined ? {} : { album: string(track.album) }),
      ...(track.durationSeconds === undefined
        ? {}
        : { durationSeconds: number(track.durationSeconds) }),
      ...(track.quality === undefined
        ? {}
        : { quality: string(track.quality) }),
    };
  };
  const favorites = config.favorites === undefined ? [] : config.favorites;
  if (!Array.isArray(favorites) || favorites.length > 5000)
    throw new Error("收藏列表格式无效");
  const normalizedFavorites = favorites.map(normalizeSavedTrack);
  const playbackHistory =
    config.playbackHistory === undefined ? [] : config.playbackHistory;
  if (!Array.isArray(playbackHistory) || playbackHistory.length > 1000)
    throw new Error("播放历史格式无效");
  const normalizedHistory = playbackHistory.map((item) => {
    if (
      !record(item) ||
      typeof item.playedAt !== "number" ||
      !Number.isFinite(item.playedAt)
    )
      throw new Error("播放历史格式无效");
    return { track: normalizeSavedTrack(item.track), playedAt: item.playedAt };
  });
  const devices = config.devices === undefined ? [] : config.devices;
  if (!Array.isArray(devices) || devices.length > 100)
    throw new Error("设备列表格式无效");
  const normalizedDevices = devices.map((device) => {
    if (
      !record(device) ||
      !string(device.deviceId) ||
      !string(device.name) ||
      typeof device.model !== "string" ||
      typeof device.hardware !== "string" ||
      typeof device.presence !== "string"
    )
      throw new Error("设备列表格式无效");
    return {
      deviceId: device.deviceId,
      name: device.name,
      model: device.model,
      hardware: device.hardware,
      presence: device.presence,
      ...(typeof device.location === "string" && device.location.trim()
        ? { location: device.location.trim().slice(0, 80) }
        : {}),
    };
  });
  const xiaomi =
    config.xiaomi === null || config.xiaomi === undefined
      ? null
      : (() => {
          if (
            !record(config.xiaomi) ||
            !string(config.xiaomi.userId) ||
            !string(config.xiaomi.passToken) ||
            !string(config.xiaomi.serviceToken) ||
            !Number.isFinite(config.xiaomi.serviceTokenExpiresAt)
          )
            throw new Error("小米账号配置格式无效");
          return {
            userId: config.xiaomi.userId,
            passToken: config.xiaomi.passToken,
            cUserId:
              config.xiaomi.cUserId === undefined
                ? ""
                : string(config.xiaomi.cUserId),
            serviceToken: config.xiaomi.serviceToken,
            serviceTokenExpiresAt: config.xiaomi.serviceTokenExpiresAt,
          };
        })();
  const admin =
    value.admin === null || value.admin === undefined
      ? null
      : (() => {
          if (
            !record(value.admin) ||
            !string(value.admin.salt) ||
            !string(value.admin.hash)
          )
            throw new Error("管理员配置格式无效");
          return { salt: value.admin.salt, hash: value.admin.hash };
        })();
  return {
    version: 1,
    admin,
    config: {
      defaultLocation: string(config.defaultLocation).trim().slice(0, 80),
      ai: {
        baseUrl: stringField(ai, "baseUrl"),
        model: stringField(ai, "model"),
        apiKey: stringField(ai, "apiKey"),
        provider: stringField(ai, "provider") || "custom",
      },
      webSearch: {
        apiKey: stringField(webSearch, "apiKey"),
        mode: ["auto", "off", "external"].includes(webSearch.mode)
          ? webSearch.mode
          : "auto",
      },
      musicServices: normalizeStoredServices(
        config.musicServices,
        musicSources.length > 0,
      ),
      libraryIndexes: normalizeIndexes(config.libraryIndexes),
      musicSources,
      lxSources: normalizeLxSources(config.lxSources),
      lxQuality: ["128k", "320k", "flac", "flac24bit"].includes(
        config.lxQuality,
      )
        ? config.lxQuality
        : "320k",
      lxQualityFallback: config.lxQualityFallback !== false,
      lxPlaylists: normalizeLxPlaylists(
        config.lxPlaylists,
        normalizeSavedTrack,
      ),
      playbackQueue: { tracks, currentIndex: queue.currentIndex },
      devicePlaybackQueues: normalizeDeviceQueues(
        config.devicePlaybackQueues,
        normalizeSavedTrack,
      ),
      playbackMode,
      favorites: normalizedFavorites,
      playbackHistory: normalizedHistory,
      voiceMonitorEnabled: config.voiceMonitorEnabled === true,
      selectedDeviceId: stringField(config, "selectedDeviceId"),
      devices: normalizedDevices,
      xiaomi,
    },
  };
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringField(value: Record<string, any>, key: string): string {
  if (value[key] === undefined) return "";
  if (typeof value[key] !== "string")
    throw new Error("持久化配置字段格式无效: " + key);
  return value[key];
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("播放队列格式无效");
  return value;
}

export function validLxTrack(
  value: unknown,
): value is NonNullable<MusicTrack["lx"]> {
  return (
    record(value) &&
    ["wy", "tx", "kg", "kw", "mg"].includes(value.platform) &&
    record(value.songInfo) &&
    JSON.stringify(value).length <= 16000
  );
}
function normalizeLxSources(
  value: unknown,
): StoredState["config"]["lxSources"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("LX 音源配置无效");
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !record(item) ||
      !string(item.id) ||
      ids.has(item.id) ||
      !string(item.script) ||
      !string(item.name) ||
      !record(item.sources) ||
      typeof item.enabled !== "boolean"
    )
      throw new Error("LX 音源配置无效");
    ids.add(item.id);
    return {
      id: item.id,
      script: item.script,
      enabled: item.enabled,
      name: item.name,
      version: string(item.version),
      author: string(item.author),
      description: string(item.description),
      sources: item.sources,
      routing: normalizeSourceRouting(item.routing, item.sources),
      health: normalizeSourceHealth(item.health, item.sources),
    };
  });
}
function normalizeSourceRouting(
  raw: unknown,
  sources: Record<string, unknown>,
): SourceRouting {
  if (raw === undefined) return {};
  if (!record(raw)) throw new Error("音源分流规则格式无效");
  const result: SourceRouting = {};
  for (const [platform, rule] of Object.entries(raw)) {
    if (
      !Object.hasOwn(sources, platform) ||
      !record(rule) ||
      typeof rule.enabled !== "boolean" ||
      !Number.isInteger(rule.priority) ||
      rule.priority < 0 ||
      rule.priority > 100
    )
      throw new Error("音源分流规则格式无效");
    result[platform] = { enabled: rule.enabled, priority: rule.priority };
  }
  return result;
}
function normalizeSourceHealth(
  raw: unknown,
  sources: Record<string, unknown>,
): SourceHealthMap {
  if (raw === undefined) return {};
  if (!record(raw)) throw new Error("音源健康记录格式无效");
  const result: SourceHealthMap = {};
  for (const [platform, h] of Object.entries(raw)) {
    if (
      !Object.hasOwn(sources, platform) ||
      !record(h) ||
      !["ok", "failed"].includes(h.state) ||
      !["ok", "resolve", "audio", "timeout"].includes(h.reason) ||
      typeof h.quality !== "string" ||
      ![
        "score",
        "successes",
        "failures",
        "consecutiveFailures",
        "checkedAt",
        "latencyMs",
        "cooldownUntil",
      ].every(
        (key) =>
          typeof h[key] === "number" && Number.isFinite(h[key]) && h[key] >= 0,
      ) ||
      h.score > 100
    )
      throw new Error("音源健康记录格式无效");
    result[platform] = {
      score: h.score,
      successes: h.successes,
      failures: h.failures,
      consecutiveFailures: h.consecutiveFailures,
      checkedAt: h.checkedAt,
      latencyMs: h.latencyMs,
      cooldownUntil: h.cooldownUntil,
      state: h.state,
      reason: h.reason,
      quality: h.quality,
    };
  }
  return result;
}
function normalizeLxPlaylists(
  value: unknown,
  normalize: (value: unknown) => StoredTrack,
): StoredState["config"]["lxPlaylists"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("LX 歌单配置无效");
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !record(item) ||
      !string(item.id) ||
      ids.has(item.id) ||
      !string(item.name) ||
      !Array.isArray(item.tracks) ||
      item.tracks.length > 1000
    )
      throw new Error("LX 歌单配置无效");
    ids.add(item.id);
    return { id: item.id, name: item.name, tracks: item.tracks.map(normalize) };
  });
}

function normalizeStoredServices(
  raw: any,
  legacy: boolean,
): MusicServicesConfig {
  if (raw === undefined)
    return { ...defaultMusicServices(), mode: legacy ? "legacy" : "online" };
  if (
    !record(raw) ||
    !["online", "private", "hybrid", "legacy"].includes(raw.mode) ||
    typeof raw.gatewayBaseUrl !== "string" ||
    !Array.isArray(raw.libraries) ||
    raw.libraries.length > 8
  )
    throw new Error("音乐服务配置无效");
  const ids = new Set();
  const libraries = raw.libraries.map((l: any) => {
    if (
      !record(l) ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(l.id) ||
      ids.has(l.id) ||
      !["subsonic", "webdav", "feiniu"].includes(l.type) ||
      !["name", "baseUrl", "username", "password", "accessCode"].every(
        (k) => typeof l[k] === "string",
      ) ||
      typeof l.enabled !== "boolean"
    )
      throw new Error("私人音乐库配置无效");
    ids.add(l.id);
    return {
      id: l.id,
      name: l.name,
      type: l.type,
      baseUrl: l.baseUrl,
      username: l.username,
      password: l.password,
      accessCode: l.accessCode,
      enabled: l.enabled,
    };
  });
  return { mode: raw.mode, gatewayBaseUrl: raw.gatewayBaseUrl, libraries };
}
function normalizeIndexes(raw: any): Record<string, LibraryIndex> {
  if (raw === undefined) return {};
  if (!record(raw)) throw new Error("音乐库索引无效");
  const result: Record<string, LibraryIndex> = {};
  for (const [id, index] of Object.entries(raw).slice(0, 8)) {
    if (
      !record(index) ||
      typeof index.fingerprint !== "string" ||
      !Array.isArray(index.tracks) ||
      index.tracks.length > 5000 ||
      !Number.isFinite(index.scannedAt)
    )
      throw new Error("音乐库索引无效");
    const tracks = index.tracks.map(libraryRef);
    if (tracks.some((t) => !t || t.library?.providerId !== id))
      throw new Error("音乐库索引歌曲无效");
    const trackIds = new Set(tracks.map((t) => t!.id));
    result[id] = {
      fingerprint: index.fingerprint,
      scannedAt: index.scannedAt,
      tracks: tracks as MusicTrack[],
      warnings: Number(index.warnings) || 0,
      etags: record(index.etags)
        ? (Object.fromEntries(
            Object.entries(index.etags).filter(
              ([key, value]) =>
                trackIds.has(key) &&
                typeof value === "string" &&
                value.length <= 512,
            ),
          ) as Record<string, string>)
        : {},
      fallbackIds: Array.isArray(index.fallbackIds)
        ? index.fallbackIds
            .filter((id) => typeof id === "string" && trackIds.has(id))
            .slice(0, 5000)
        : [],
    };
  }
  return result;
}

function normalizeDeviceQueues(
  value: unknown,
  normalizeTrack: (value: unknown) => StoredTrack,
) {
  const queues: StoredState["config"]["devicePlaybackQueues"] =
    Object.create(null);
  if (!record(value)) return queues;
  for (const [id, queue] of Object.entries(value).slice(0, 64)) {
    if (
      !id ||
      id.length > 200 ||
      !record(queue) ||
      !Array.isArray(queue.tracks)
    )
      continue;
    const tracks = queue.tracks.map(normalizeTrack);
    const currentIndex =
      Number.isInteger(queue.currentIndex) &&
      queue.currentIndex >= -1 &&
      queue.currentIndex < tracks.length
        ? queue.currentIndex
        : -1;
    Object.defineProperty(queues, id, {
      value: { tracks, currentIndex },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return queues;
}
