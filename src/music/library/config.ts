import { randomUUID } from "node:crypto";
import type { JsonStore } from "../../storage/store.ts";
import { serviceUrl } from "../../security/http.ts";
import type { MusicTrack } from "../types.ts";

export type MusicServiceMode = "online" | "private" | "hybrid" | "legacy";
export interface LibraryConfig {
  id: string;
  name: string;
  type: "subsonic" | "webdav" | "feiniu";
  baseUrl: string;
  username: string;
  password: string;
  accessCode: string;
  enabled: boolean;
}
export interface LibraryIndex {
  fingerprint: string;
  scannedAt: number;
  tracks: MusicTrack[];
  warnings: number;
  etags?: Record<string, string>;
  fallbackIds?: string[];
}
export interface MusicServicesConfig {
  mode: MusicServiceMode;
  gatewayBaseUrl: string;
  libraries: LibraryConfig[];
}
export const defaultMusicServices = (): MusicServicesConfig => ({
  mode: "online",
  gatewayBaseUrl: "",
  libraries: [],
});
export function publicMusicServices(config: MusicServicesConfig) {
  return {
    ...config,
    libraries: config.libraries.map(({ password, accessCode, ...item }) => ({
      ...item,
      passwordSet: !!password,
      accessCodeSet: !!accessCode,
    })),
  };
}
export function normalizeMusicServices(
  raw: any,
  current: MusicServicesConfig,
  store: JsonStore,
): MusicServicesConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("音乐服务配置无效");
  if (!Array.isArray(raw.libraries) || raw.libraries.length > 8)
    throw new Error("私人音乐库最多 8 个");
  const mode =
    raw.mode ??
    (raw.libraries.some((l: any) => l.enabled !== false)
      ? "private"
      : current.mode);
  if (!["online", "private", "hybrid", "legacy"].includes(mode))
    throw new Error("音乐来源模式无效");
  if (typeof raw.gatewayBaseUrl !== "string")
    throw new Error("请填写音箱可访问的平台地址");
  const gatewayBaseUrl = raw.gatewayBaseUrl.trim()
    ? serviceUrl(raw.gatewayBaseUrl.trim())
    : "";
  if (gatewayBaseUrl && new URL(gatewayBaseUrl).pathname !== "/")
    throw new Error("平台地址只填写协议、主机和端口，不含子路径");
  const ids = new Set<string>();
  const libraries = raw.libraries.map((l: any): LibraryConfig => {
    if (!l || typeof l !== "object" || Array.isArray(l))
      throw new Error("音乐库配置无效");
    for (const k of ["name", "baseUrl", "username", "password", "accessCode"])
      if (typeof l[k] !== "string") throw new Error("音乐库字段必须是字符串");
    if (
      !["subsonic", "webdav", "feiniu"].includes(l.type) ||
      typeof l.enabled !== "boolean"
    )
      throw new Error("音乐库类型或启用状态无效");
    if (
      !l.name.trim() ||
      l.name.length > 80 ||
      l.baseUrl.length > 2000 ||
      l.username.length > 200 ||
      l.password.length > 4096 ||
      l.accessCode.length > 200
    )
      throw new Error("音乐库字段为空或过长");
    const id = l.id || randomUUID();
    if (
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
      ids.has(id)
    )
      throw new Error("音乐库标识无效或重复");
    ids.add(id);
    const baseUrl = serviceUrl(l.baseUrl.trim());
    const saved = current.libraries.find((p) => p.id === id);
    const same =
      saved?.baseUrl === baseUrl &&
      saved?.type === l.type &&
      saved?.username === l.username;
    const password = l.password
      ? store.encrypt(l.password)
      : l.clearPassword
        ? ""
        : same
          ? saved!.password
          : "";
    const accessCode = l.accessCode
      ? store.encrypt(l.accessCode)
      : l.clearAccessCode
        ? ""
        : same
          ? saved!.accessCode
          : "";
    return {
      id,
      name: l.name.trim(),
      type: l.type,
      baseUrl,
      username: l.username,
      password,
      accessCode,
      enabled: l.enabled,
    };
  });
  return { mode, gatewayBaseUrl, libraries };
}
export function libraryRef(raw: any): MusicTrack | undefined {
  const ref = raw?.library;
  if (
    !ref ||
    typeof ref.providerId !== "string" ||
    typeof ref.trackId !== "string" ||
    !ref.trackId ||
    ref.trackId.length > 2000 ||
    !/^[\w-]{1,80}$/.test(ref.providerId)
  )
    return;
  if (
    raw.id !== ref.trackId ||
    raw.sourceId !== "library:" + ref.providerId ||
    typeof raw.title !== "string" ||
    !raw.title ||
    raw.title.length > 300 ||
    typeof raw.artist !== "string" ||
    !raw.artist ||
    raw.artist.length > 300
  )
    return;
  return {
    id: ref.trackId,
    sourceId: raw.sourceId,
    title: raw.title,
    artist: raw.artist,
    library: { providerId: ref.providerId, trackId: ref.trackId },
    ...(typeof raw.album === "string"
      ? { album: raw.album.slice(0, 300) }
      : {}),
    ...(Number.isFinite(raw.durationSeconds) && raw.durationSeconds > 0
      ? { durationSeconds: raw.durationSeconds }
      : {}),
    ...(typeof raw.coverUrl === "string" &&
    raw.coverUrl.startsWith("/api/music/services/cover?")
      ? { coverUrl: raw.coverUrl }
      : {}),
  };
}
