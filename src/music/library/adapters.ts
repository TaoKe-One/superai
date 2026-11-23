// Protocol reference: pcyear/pcyear-bridge, Apache-2.0, commit 049116b.
// Reimplemented for native Node services: no Songloft runtime, SDK, raw sockets or FN relay discovery.
import { createHash, randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { parseBuffer } from "music-metadata";
import { limitedBytes } from "../../security/http.ts";
import type { MusicTrack } from "../types.ts";
import type { LibraryConfig, LibraryIndex } from "./config.ts";

export type CollectionKind = "playlists" | "albums" | "artists";
export interface Collection {
  id: string;
  name: string;
  count?: number;
  providerId: string;
}
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  total?: number;
}
export const PAGE_SIZE = 50;
const array = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);
function davGroup(track: MusicTrack, kind: CollectionKind) {
  if (kind === "artists") return track.artist;
  if (kind === "albums") return track.album || "未分类";
  const path = Buffer.from(track.id, "base64url").toString("utf8");
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "根目录";
}
export function libraryFingerprint(c: LibraryConfig) {
  return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}
export class LibraryAdapter {
  readonly config: LibraryConfig;
  private fetchImpl: typeof fetch;
  private token = "";
  private cookie = "";
  private loginPromise?: Promise<void>;
  private loggedAt = 0;
  constructor(config: LibraryConfig, fetchImpl: typeof fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }
  private base() {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    if (this.config.type === "subsonic")
      return base.replace(/\/rest$/, "") + "/rest";
    if (this.config.type === "feiniu")
      return (
        base.replace(/\/api\/v1$/, "").replace(/\/music$/, "") + "/music/api/v1"
      );
    return base + "/";
  }
  async request(
    url: string | URL,
    options: RequestInit = {},
  ): Promise<Response> {
    const target = new URL(url);
    if (target.origin !== new URL(this.config.baseUrl).origin)
      throw new Error("音乐库请求不能跨服务发送凭证");
    try {
      return await this.fetchImpl(target, {
        ...options,
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error("音乐库连接失败或超时；重定向地址请直接填写到服务配置");
    }
  }
  private async json(url: URL | string, options: RequestInit = {}) {
    const response = await this.request(url, options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("音乐库请求失败，HTTP " + response.status);
    }
    try {
      return JSON.parse((await limitedBytes(response)).toString("utf8"));
    } catch (e) {
      if (e instanceof SyntaxError)
        throw new Error("音乐库返回非 JSON 数据，请检查地址、访问码和登录状态");
      throw e;
    }
  }
  private subUrl(
    method: string,
    params: Record<string, any> = {},
    binary = false,
  ) {
    const url = new URL(this.base() + "/" + method);
    const salt = randomBytes(12).toString("hex");
    const auth = {
      u: this.config.username,
      t: createHash("md5")
        .update(this.config.password + salt)
        .digest("hex"),
      s: salt,
      v: "1.16.1",
      c: "speaker-platform",
      ...(binary ? {} : { f: "json" }),
      ...params,
    };
    for (const [k, v] of Object.entries(auth))
      if (v !== undefined) url.searchParams.set(k, String(v));
    return url;
  }
  private async sub(
    method: string,
    params: Record<string, any> = {},
    signal?: AbortSignal,
  ) {
    const result = (
      await this.json(
        this.subUrl(method, params),
        signal
          ? { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) }
          : {},
      )
    )["subsonic-response"];
    if (result?.status !== "ok")
      throw new Error(
        "Subsonic 服务拒绝请求（错误码 " +
          String(Number(result?.error?.code) || "未知") +
          "），请检查账号和接口支持情况",
      );
    return result;
  }
  private async login() {
    if (this.token && Date.now() - this.loggedAt < 240000) return;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      this.cookie = "";
      if (this.config.accessCode) {
        const verify = new URL("/access_code_verify", this.config.baseUrl);
        const r = await this.request(verify, {
          headers: {
            "x-access-code": Buffer.from(this.config.accessCode).toString(
              "base64",
            ),
            "x-access-source": "web",
          },
        });
        const cookies = r.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .filter((v) => /^[\w-]+=[^;\r\n]*$/.test(v));
        await r.body?.cancel();
        if (!r.ok || !cookies.some((c) => c.startsWith("os-access-code=")))
          throw new Error("飞牛访问码验证失败，请使用可直接访问的音乐服务地址");
        this.cookie = cookies.join("; ");
      }
      const data = await this.json(this.base() + "/user/password-login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: JSON.stringify({
          username: this.config.username,
          password: createHash("sha256")
            .update(this.config.password)
            .digest("hex"),
          deviceId: "speaker-platform-" + this.config.id,
        }),
      });
      const token = data?.data?.userToken;
      if (
        data?.code !== 0 ||
        typeof token !== "string" ||
        !token ||
        /[;\r\n]/.test(token)
      )
        throw new Error("飞牛音乐登录失败，请检查账号、密码与服务地址");
      this.token = token;
      this.loggedAt = Date.now();
    })().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }
  private fnHeaders() {
    return {
      cookie: [this.cookie, "music-token=" + this.token]
        .filter(Boolean)
        .join("; "),
    };
  }
  private fnUrl(path: string, params: Record<string, any> = {}) {
    const url = new URL(this.base() + path);
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, String(v));
    return url;
  }
  private async fn(
    path: string,
    params: Record<string, any> = {},
    retry = true,
  ): Promise<any> {
    await this.login();
    const response = await this.request(this.fnUrl(path, params), {
      headers: this.fnHeaders(),
    });
    if ((response.status === 401 || response.status === 403) && retry) {
      await response.body?.cancel();
      this.token = "";
      return this.fn(path, params, false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("飞牛接口失败，HTTP " + response.status);
    }
    let data;
    try {
      data = JSON.parse((await limitedBytes(response)).toString("utf8"));
    } catch {
      throw new Error("飞牛返回非 JSON 响应，请检查网关访问码或改用局域网地址");
    }
    if ([100003, 401].includes(data.code) && retry) {
      this.token = "";
      return this.fn(path, params, false);
    }
    if (data.code !== 0)
      throw new Error(
        "飞牛接口拒绝请求，错误码 " + String(Number(data.code) || "未知"),
      );
    return data.data ?? {};
  }
  private track(s: any): MusicTrack {
    const fn = this.config.type === "feiniu";
    const id = String(fn ? s.guid : s.id);
    if (!id || id === "undefined" || id.length > 2000)
      throw new Error("音乐库返回无效歌曲标识");
    const cover = fn ? s.coverId || s.album?.coverId : s.coverArt;
    return {
      id,
      sourceId: "library:" + this.config.id,
      library: { providerId: this.config.id, trackId: id },
      title: String(s.title || "未知歌曲").slice(0, 300),
      artist: String(
        fn
          ? (s.artists ?? [])
              .map((a: any) => a.name)
              .filter(Boolean)
              .join("、") || "未知歌手"
          : s.artist || "未知歌手",
      ).slice(0, 300),
      album: String(fn ? s.album?.name || "" : s.album || "").slice(0, 300),
      ...(Number(s.duration) > 0
        ? { durationSeconds: Number(s.duration) / (fn ? 1000 : 1) }
        : {}),
      ...(cover
        ? {
            coverUrl:
              "/api/music/services/cover?provider=" +
              encodeURIComponent(this.config.id) +
              "&id=" +
              encodeURIComponent(String(cover)),
          }
        : {}),
    };
  }
  async test() {
    if (this.config.type === "subsonic") await this.sub("ping");
    else if (this.config.type === "feiniu") {
      await this.login();
      await this.fn("/user/me");
    } else await this.davEntries("");
    return { ok: true, message: "连接与认证通过；音箱播放需要另行验证" };
  }
  async search(
    query: string,
    page = 1,
    index?: LibraryIndex,
  ): Promise<Page<MusicTrack>> {
    if (this.config.type === "webdav") {
      if (!index || index.fingerprint !== libraryFingerprint(this.config))
        throw new Error("请先扫描 WebDAV 音乐库建立索引");
      const words = query
        .normalize("NFKC")
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const all = index.tracks.filter((t) =>
        words.every((w) =>
          [t.title, t.artist, t.album ?? ""]
            .join(" ")
            .normalize("NFKC")
            .toLocaleLowerCase()
            .includes(w),
        ),
      );
      return {
        items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        hasMore: page * PAGE_SIZE < all.length,
        total: all.length,
      };
    }
    const data =
      this.config.type === "subsonic"
        ? await this.sub("search3", {
            query,
            songCount: PAGE_SIZE,
            songOffset: (page - 1) * PAGE_SIZE,
            artistCount: 0,
            albumCount: 0,
          })
        : await this.fn(
            query ? "/search/track" : "/track/list",
            query
              ? { q: query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }
              : { page, size: PAGE_SIZE },
          );
    const raw =
      this.config.type === "subsonic"
        ? array(data.searchResult3?.song)
        : array(data.list);
    return {
      items: raw.map((s) => this.track(s)),
      hasMore: raw.length === PAGE_SIZE,
      ...(Number.isFinite(data.total)
        ? { total: data.total, hasMore: page * PAGE_SIZE < data.total }
        : {}),
    };
  }
  async collections(
    kind: CollectionKind,
    page = 1,
    index?: LibraryIndex,
    query = "",
  ): Promise<Page<Collection>> {
    if (this.config.type === "webdav") {
      if (!index || index.fingerprint !== libraryFingerprint(this.config))
        throw new Error("请先扫描 WebDAV 音乐库");
      const groups = new Map<string, number>();
      const needle = kind === "artists" ? query.toLocaleLowerCase() : "";
      for (const t of index.tracks) {
        const key = davGroup(t, kind);
        if (needle && !key.toLocaleLowerCase().includes(needle)) continue;
        groups.set(key, (groups.get(key) || 0) + 1);
      }
      const all = [...groups]
        .sort((a, b) => a[0].localeCompare(b[0], "zh"))
        .map(([name, count]) => ({
          id: Buffer.from(name).toString("base64url"),
          name,
          count,
          providerId: this.config.id,
        }));
      return {
        items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        hasMore: page * PAGE_SIZE < all.length,
        total: all.length,
      };
    }
    let raw: any[], total: number | undefined;
    if (this.config.type === "subsonic") {
      if (kind === "playlists") {
        const r = await this.sub("getPlaylists");
        raw = array(r.playlists?.playlist);
        total = raw.length;
        raw = raw.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      } else if (kind === "albums") {
        const r = await this.sub("getAlbumList2", {
          type: "alphabeticalByName",
          size: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });
        raw = array(r.albumList2?.album);
      } else {
        const r = await this.sub("search3", {
          query,
          artistCount: PAGE_SIZE + 1,
          artistOffset: (page - 1) * PAGE_SIZE,
          albumCount: 0,
          songCount: 0,
        });
        const artists = array(r.searchResult3?.artist);
        return {
          items: artists.slice(0, PAGE_SIZE).map((artist) => ({
            id: String(artist.id),
            name: String(artist.name || "未命名").slice(0, 300),
            providerId: this.config.id,
          })),
          hasMore: artists.length > PAGE_SIZE,
        };
      }
    } else {
      const singular = {
        playlists: "playlist",
        albums: "album",
        artists: "artist",
      }[kind];
      const r = await this.fn("/" + singular + "/list", {
        page,
        size: PAGE_SIZE,
      });
      raw = array(r.list);
      total = r.total;
    }
    return {
      items: raw.map((s) => ({
        id: String(s.guid ?? s.id),
        name: String(s.name ?? s.album ?? "未命名").slice(0, 300),
        count: s.songCount ?? s.trackCount,
        providerId: this.config.id,
      })),
      hasMore:
        total !== undefined
          ? page * PAGE_SIZE < total
          : raw.length === PAGE_SIZE,
      ...(total !== undefined ? { total } : {}),
    };
  }
  async collectionTracks(
    kind: CollectionKind,
    id: string,
    page = 1,
    index?: LibraryIndex,
  ): Promise<Page<MusicTrack>> {
    if (this.config.type === "webdav") {
      const name = Buffer.from(id, "base64url").toString("utf8");
      await this.search("", 1, index);
      const all = (index?.tracks ?? []).filter(
        (t) => davGroup(t, kind) === name,
      );
      return {
        items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        hasMore: page * PAGE_SIZE < all.length,
        total: all.length,
      };
    }
    if (this.config.type === "feiniu") {
      const k = { playlists: "playlist", albums: "album", artists: "artist" }[
        kind
      ];
      const r = await this.fn("/track/" + k + "-detail/list", {
        [k + "GUID"]: id,
        page,
        size: PAGE_SIZE,
      });
      const raw = array(r.list);
      return {
        items: raw.map((s) => this.track(s)),
        hasMore: Number.isFinite(r.total)
          ? page * PAGE_SIZE < r.total
          : raw.length === PAGE_SIZE,
        total: r.total,
      };
    }
    if (kind === "artists") return this.subsonicArtistTracks(id, page);
    const r = await this.sub(kind === "albums" ? "getAlbum" : "getPlaylist", {
      id,
    });
    const all = array(
      kind === "albums" ? r.album?.song : r.playlist?.entry,
    ).map((s) => this.track(s));
    return {
      items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      hasMore: page * PAGE_SIZE < all.length,
      total: all.length,
    };
  }
  private async subsonicArtistTracks(
    id: string,
    page: number,
  ): Promise<Page<MusicTrack>> {
    const signal = AbortSignal.timeout(25000);
    const result = await this.sub("getArtist", { id }, signal);
    const albums = array(result.artist?.album);
    let offset = (page - 1) * PAGE_SIZE;
    let cursor = 0;
    const tracks: MusicTrack[] = [];
    // Consume album counts to seek to the requested page without fetching
    // the preceding discography. Older servers may omit songCount.
    while (cursor < albums.length) {
      const count = albums[cursor].songCount;
      if (!Number.isSafeInteger(count) || count < 0 || count > offset) break;
      offset -= count;
      cursor++;
    }
    while (tracks.length <= PAGE_SIZE && cursor < albums.length) {
      signal.throwIfAborted();
      const batch = albums.slice(cursor, cursor + 4);
      const results = await Promise.all(
        batch.map((album) => this.sub("getAlbum", { id: album.id }, signal)),
      );
      for (const result of results) {
        const songs = array(result.album?.song);
        if (offset >= songs.length) {
          offset -= songs.length;
          continue;
        }
        tracks.push(
          ...songs
            .slice(offset, offset + PAGE_SIZE + 1 - tracks.length)
            .map((song) => this.track(song)),
        );
        offset = 0;
      }
      cursor += batch.length;
    }
    return {
      items: tracks.slice(0, PAGE_SIZE),
      hasMore: tracks.length > PAGE_SIZE,
    };
  }
  async lyric(track: MusicTrack): Promise<string> {
    if (this.config.type === "webdav") {
      const path = this.davPath(track.id).replace(/\.[^/.]+$/, ".lrc");
      const r = await this.request(this.davUrl(path), {
        headers: this.davHeaders(),
      });
      if (r.status === 404) {
        await r.body?.cancel();
        return "";
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new Error("WebDAV 歌词读取失败");
      }
      return (await limitedBytes(r, 262144)).toString("utf8");
    }
    if (this.config.type === "feiniu") {
      const r = await this.fn("/lyric/list", { trackGUID: track.id });
      return String(
        array(r.list).find((l) => typeof l.content === "string")?.content || "",
      ).slice(0, 262144);
    }
    try {
      const r = await this.sub("getLyricsBySongId", { id: track.id });
      const entry = array(r.lyricsList?.structuredLyrics)[0];
      if (entry) {
        return array(entry.line)
          .map((l) => {
            const sec = Number(l.start) / 1000;
            return (
              (entry.synced && Number.isFinite(sec)
                ? "[" +
                  Math.floor(sec / 60)
                    .toString()
                    .padStart(2, "0") +
                  ":" +
                  (sec % 60).toFixed(2).padStart(5, "0") +
                  "]"
                : "") + String(l.value ?? "")
            );
          })
          .join("\n");
      }
    } catch {}
    const r = await this.sub("getLyrics", {
      artist: track.artist,
      title: track.title,
    });
    return String(r.lyrics?.value || r.lyrics?._content || "").slice(0, 262144);
  }
  async upstream(
    id: string,
    cover = false,
  ): Promise<{ url: URL; headers: Record<string, string> }> {
    if (this.config.type === "subsonic")
      return {
        url: this.subUrl(
          cover ? "getCoverArt" : "stream",
          {
            id,
            ...(cover ? { size: 512 } : { format: "mp3", maxBitRate: 320 }),
          },
          true,
        ),
        headers: {},
      };
    if (this.config.type === "feiniu") {
      await this.login();
      return {
        url: this.fnUrl(
          cover ? "/static/cover" : "/track/stream",
          cover ? { coverId: id } : { guid: id },
        ),
        headers: this.fnHeaders(),
      };
    }
    if (cover) throw new Error("WebDAV 暂不提供独立封面");
    return { url: this.davUrl(this.davPath(id)), headers: this.davHeaders() };
  }
  async stream(
    id: string,
    options: RequestInit = {},
    cover = false,
    retry = true,
  ): Promise<Response> {
    const up = await this.upstream(id, cover);
    const r = await this.request(up.url, {
      ...options,
      headers: {
        ...Object.fromEntries(new Headers(options.headers)),
        ...up.headers,
      },
    });
    if (
      this.config.type === "feiniu" &&
      [401, 403].includes(r.status) &&
      retry
    ) {
      await r.body?.cancel();
      this.token = "";
      return this.stream(id, options, cover, false);
    }
    return r;
  }
  private davHeaders() {
    return {
      authorization:
        "Basic " +
        Buffer.from(this.config.username + ":" + this.config.password).toString(
          "base64",
        ),
    };
  }
  private davUrl(path: string) {
    if (
      path.includes("\\") ||
      path
        .split("/")
        .some((s) => s === ".." || s === "." || /[\x00-\x1f]/.test(s))
    )
      throw new Error("WebDAV 路径无效");
    return new URL(
      path.split("/").map(encodeURIComponent).join("/"),
      this.base(),
    );
  }
  private davPath(id: string) {
    const path = Buffer.from(id, "base64url").toString("utf8");
    if (
      !path ||
      path.startsWith("/") ||
      Buffer.from(path).toString("base64url") !== id
    )
      throw new Error("WebDAV 文件标识无效");
    return path;
  }
  private async davEntries(
    path: string,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; directory: boolean; etag: string }>> {
    const url = this.davUrl(path ? path.replace(/\/$/, "") + "/" : "");
    const r = await this.request(url, {
      method: "PROPFIND",
      headers: {
        ...this.davHeaders(),
        depth: "1",
        "content-type": "application/xml",
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
    });
    if (r.status !== 207 && r.status !== 200) {
      await r.body?.cancel();
      throw new Error("WebDAV 目录读取失败，HTTP " + r.status);
    }
    const xml = (await limitedBytes(r)).toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error("WebDAV XML 包含不支持的实体声明");
    const tree = new XMLParser({
      removeNSPrefix: true,
      ignoreAttributes: true,
      processEntities: true,
    }).parse(xml);
    if (!tree.multistatus) throw new Error("WebDAV 没有返回目录清单");
    const root = new URL(this.base()),
      result: Array<{ path: string; directory: boolean; etag: string }> = [];
    for (const entry of array(tree.multistatus.response)) {
      const href = new URL(String(entry.href ?? ""), url);
      if (
        href.origin !== root.origin ||
        !href.pathname.startsWith(root.pathname)
      )
        throw new Error("WebDAV 返回了根目录之外的路径");
      let relative = decodeURIComponent(
        href.pathname.slice(root.pathname.length),
      ).replace(/\/$/, "");
      if (!relative || relative === path.replace(/\/$/, "")) continue;
      this.davUrl(relative);
      // Depth:1 responses must be direct children; do not traverse injected arbitrary paths.
      if (
        relative.slice(0, relative.lastIndexOf("/") + 1) !==
        (path ? path.replace(/\/$/, "") + "/" : "")
      )
        continue;
      const ok = array(entry.propstat).find((p) =>
        /\s200\s/.test(String(p.status)),
      );
      if (!ok?.prop) continue;
      result.push({
        path: relative,
        directory: ok.prop.resourcetype?.collection !== undefined,
        etag: String(ok.prop.getetag || ""),
      });
    }
    return result;
  }
  async scan(
    previous: LibraryIndex | undefined,
    signal: AbortSignal,
    progress: (count: number, dirs: number) => void,
  ): Promise<LibraryIndex> {
    const reusable =
      previous?.fingerprint === libraryFingerprint(this.config)
        ? previous
        : undefined;
    const oldTracks = new Map(reusable?.tracks.map((t) => [t.id, t]) ?? []);
    const oldFallbacks = new Set(reusable?.fallbackIds ?? []);
    const etags: Record<string, string> = {},
      fallbackIds: string[] = [];
    const stack = [""],
      visited = new Set<string>(),
      tracks: MusicTrack[] = [],
      deadline = Date.now() + 180000;
    let warnings = 0,
      metadataReads = 0;
    while (stack.length) {
      signal.throwIfAborted();
      if (Date.now() > deadline)
        throw new Error("扫描超过 3 分钟，旧索引已保留；请缩小 WebDAV 根目录");
      const path = stack.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      if (visited.size > 500)
        throw new Error("扫描超过 500 个目录，旧索引已保留；请缩小根目录");
      for (const entry of await this.davEntries(path, signal)) {
        if (entry.directory) {
          stack.push(entry.path);
          continue;
        }
        if (
          !/\.(mp3|flac|m4a|aac|ogg|opus|wav|ape|wma|aiff?)$/i.test(entry.path)
        )
          continue;
        if (tracks.length >= 5000)
          throw new Error("音乐库超过 5000 首，旧索引已保留；请拆分根目录");
        const parts = entry.path.split("/"),
          stem = parts
            .at(-1)!
            .replace(/\.[^.]+$/, "")
            .replace(/^\d+[.\s_-]+/, "");
        const split = stem.split(" - ");
        const id = Buffer.from(entry.path).toString("base64url");
        if (entry.etag) etags[id] = entry.etag;
        const cached = oldTracks.get(id);
        if (cached && entry.etag && reusable?.etags?.[id] === entry.etag) {
          tracks.push(cached);
          if (oldFallbacks.has(id)) {
            warnings++;
            fallbackIds.push(id);
          }
          progress(tracks.length, visited.size);
          continue;
        }
        let title = split.length > 1 ? split.slice(1).join(" - ") : stem,
          artist = split.length > 1 ? split[0] : parts.at(-3) || "未知歌手",
          album = parts.at(-2) || "未分类",
          durationSeconds: number | undefined;
        // Bounded metadata reads; failed/truncated headers retain a usable filename-based index.
        if (metadataReads++ < 200)
          try {
            const r = await this.request(this.davUrl(entry.path), {
              headers: { ...this.davHeaders(), range: "bytes=0-262143" },
              signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            });
            if (!r.ok) throw new Error("metadata");
            const reader = r.body?.getReader(),
              chunks: Uint8Array[] = [];
            let size = 0;
            if (reader)
              try {
                while (size < 262144) {
                  const next = await reader.read();
                  if (next.done) break;
                  chunks.push(next.value.subarray(0, 262144 - size));
                  size += Math.min(next.value.length, 262144 - size);
                }
              } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
              }
            const metadata = await parseBuffer(
              Buffer.concat(chunks),
              { path: entry.path },
              { duration: false, skipCovers: true },
            );
            title = metadata.common.title || title;
            artist = metadata.common.artist || artist;
            album = metadata.common.album || album;
            durationSeconds = metadata.format.duration;
          } catch {
            warnings++;
            fallbackIds.push(id);
          }
        else {
          warnings++;
          fallbackIds.push(id);
        }
        tracks.push({
          id,
          sourceId: "library:" + this.config.id,
          library: { providerId: this.config.id, trackId: id },
          title: title.slice(0, 300),
          artist: artist.slice(0, 300),
          album: album.slice(0, 300),
          ...(durationSeconds ? { durationSeconds } : {}),
        });
        progress(tracks.length, visited.size);
      }
    }
    signal.throwIfAborted();
    return {
      fingerprint: libraryFingerprint(this.config),
      tracks,
      scannedAt: Date.now(),
      warnings,
      etags,
      fallbackIds,
    };
  }
}
