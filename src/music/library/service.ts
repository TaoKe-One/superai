import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonStore } from "../../storage/store.ts";
import type { MusicRequest, MusicTrack } from "../types.ts";
import {
  LibraryAdapter,
  libraryFingerprint,
  type CollectionKind,
} from "./adapters.ts";
import { libraryRef } from "./config.ts";
import { LxMusicService } from "../lx/service.ts";
import { searchMusic } from "../search.ts";
import { HttpJsonMusicSource } from "../http-source.ts";
import { parseLrc } from "../lx/lyrics.ts";
import { audioFormat } from "../lx/probe.ts";
import { limitedBytes } from "../../security/http.ts";
import { completePlaylist } from "../playlist-query.ts";
import { withExecutionSignal } from "../../assistant/execution.ts";

const adapters = new WeakMap<
  JsonStore,
  Map<
    string,
    { fingerprint: string; adapter: LibraryAdapter; fetchImpl: typeof fetch }
  >
>();
const scans = new WeakMap<
  JsonStore,
  Map<
    string,
    {
      controller: AbortController;
      state: string;
      count: number;
      directories: number;
      error?: string;
      warnings?: number;
    }
  >
>();
let transcodes = 0;
export class MusicServices {
  private store: JsonStore;
  private fetchImpl: typeof fetch;
  constructor(store: JsonStore, fetchImpl: typeof fetch = fetch) {
    this.store = store;
    this.fetchImpl = fetchImpl;
  }
  assertOnline() {
    if (this.store.snapshot().config.musicServices.mode === "private")
      throw new Error("当前仅使用私人音乐库，LX 在线目录与音源已停用");
  }
  assertTrack(track: MusicTrack) {
    const mode = this.store.snapshot().config.musicServices.mode;
    if (track.library) {
      if (mode === "online" || mode === "legacy")
        throw new Error("当前音乐模式未启用私人音乐库");
      this.adapter(track.library.providerId);
      return;
    }
    if (mode === "private")
      throw new Error(
        "当前仅使用私人音乐库，该歌曲来自其他来源，请切换来源模式后播放",
      );
  }
  private adapter(id: string) {
    const c = this.store
      .snapshot()
      .config.musicServices.libraries.find((l) => l.id === id && l.enabled);
    if (!c) throw new Error("音乐库已停用或不存在");
    let cache = adapters.get(this.store);
    if (!cache) adapters.set(this.store, (cache = new Map()));
    const fingerprint = libraryFingerprint(c),
      existing = cache.get(id);
    if (
      existing?.fingerprint === fingerprint &&
      existing.fetchImpl === this.fetchImpl
    )
      return existing.adapter;
    const adapter = new LibraryAdapter(
      {
        ...c,
        password: c.password ? this.store.decrypt(c.password) : "",
        accessCode: c.accessCode ? this.store.decrypt(c.accessCode) : "",
      },
      this.fetchImpl,
    );
    // Fingerprints use encrypted config consistently, while adapters keep plaintext only in memory.
    cache.set(id, { fingerprint, adapter, fetchImpl: this.fetchImpl });
    return adapter;
  }
  private index(id: string) {
    const index = this.store.snapshot().config.libraryIndexes[id];
    const adapter = this.adapter(id);
    // The adapter uses decrypted values; normalize the fingerprint for in-memory comparisons.
    if (
      index &&
      index.fingerprint ===
        libraryFingerprint(
          this.store
            .snapshot()
            .config.musicServices.libraries.find((l) => l.id === id)!,
        )
    )
      return { ...index, fingerprint: libraryFingerprint(adapter.config) };
    return undefined;
  }
  requestedTrack(raw: any): MusicTrack {
    const track = libraryRef(raw);
    if (track) {
      this.assertTrack(track);
      return track;
    }
    const result = new LxMusicService(
      this.store,
      this.fetchImpl,
    ).requestedTrack(raw);
    this.assertTrack(result);
    return result;
  }
  async search(
    request: MusicRequest,
    privateOnly = false,
    signal?: AbortSignal,
    retainLxCandidates = false,
  ) {
    const reader = signal
      ? new MusicServices(
          this.store,
          withExecutionSignal(this.fetchImpl, signal),
        )
      : this;
    const config = this.store.snapshot().config,
      mode = config.musicServices.mode;
    if (privateOnly && !["private", "hybrid"].includes(mode))
      throw new Error("请先启用私人音乐库模式");
    if (request.platform && (privateOnly || mode === "private"))
      throw new Error("当前搜索只使用私人音乐库，无法搜索指定的在线平台");
    if (
      !request.platform &&
      (privateOnly || mode === "private" || mode === "hybrid")
    ) {
      const sources = config.musicServices.libraries
        .filter((l) => l.enabled)
        .map((l) => ({
          id: "library:" + l.id,
          search: async () =>
            (
              await reader
                .adapter(l.id)
                .search(
                  [request.artist, request.title].filter(Boolean).join(" "),
                  1,
                  reader.index(l.id),
                )
            ).items,
        }));
      const result = await searchMusic(request, sources);
      // A failed private service must not silently select an online song.
      if (
        privateOnly ||
        mode === "private" ||
        result.tracks.length ||
        result.sourceErrors.length
      )
        return result;
    }
    const legacy =
      mode === "legacy" && !request.platform
        ? config.musicSources
            .filter((s) => s.enabled)
            .map(
              (s) =>
                new HttpJsonMusicSource(
                  {
                    ...s,
                    apiKey: s.apiKey ? this.store.decrypt(s.apiKey) : "",
                  },
                  reader.fetchImpl,
                ),
            )
        : [];
    const online = new LxMusicService(
      this.store,
      this.fetchImpl,
    ).assistantSources(signal);
    return searchMusic(
      request,
      [
        ...legacy,
        ...online.filter(
          (source) =>
            !request.platform || source.id === "lx-" + request.platform,
        ),
      ],
      retainLxCandidates,
    );
  }
  async playlist(name: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.any([
      AbortSignal.timeout(25000),
      ...(signal ? [signal] : []),
    ]);
    const reader = new MusicServices(
      this.store,
      withExecutionSignal(this.fetchImpl, deadline),
    );
    const mode = this.store.snapshot().config.musicServices.mode;
    if (mode === "private" || mode === "hybrid") {
      const local = this.store
        .snapshot()
        .config.lxPlaylists.find(
          (l) =>
            l.name.normalize("NFKC").toLocaleLowerCase() ===
            name.normalize("NFKC").toLocaleLowerCase(),
        );
      if (local) {
        const allowed = local.tracks.filter(
          (t) =>
            !!t.library &&
            this.store
              .snapshot()
              .config.musicServices.libraries.some(
                (l) => l.id === t.library!.providerId && l.enabled,
              ),
        );
        if (allowed.length) return { tracks: allowed, sourceErrors: [] };
      }
      const tracks: MusicTrack[] = [],
        sourceErrors: Array<{ sourceId: string; message: string }> = [];
      for (const c of this.store
        .snapshot()
        .config.musicServices.libraries.filter((l) => l.enabled))
        try {
          let selected: any;
          for (let page = 1; page <= 20; page++) {
            deadline.throwIfAborted();
            const lists = await reader.collections(c.id, "playlists", page);
            selected = lists.items.find(
              (l) =>
                l.name.normalize("NFKC").toLocaleLowerCase() ===
                name.normalize("NFKC").toLocaleLowerCase(),
            );
            if (selected || !lists.hasMore) break;
            if (page === 20)
              throw new Error("歌单目录过多，请在播放器中选择歌单");
          }
          if (selected) {
            const complete = await completePlaylist(
              async (page) => {
                const result = await reader.collectionTracks(
                  c.id,
                  "playlists",
                  selected.id,
                  page,
                );
                return result;
              },
              (track: MusicTrack) => track.sourceId + ":" + track.id,
              deadline,
            );
            tracks.push(...complete);
          }
        } catch (e) {
          signal?.throwIfAborted();
          sourceErrors.push({
            sourceId: "library:" + c.id,
            message: e instanceof Error ? e.message : "歌单读取失败",
          });
        }
      if (mode === "private" || tracks.length || sourceErrors.length)
        return { tracks, sourceErrors };
    }
    const tracks: MusicTrack[] = [],
      sourceErrors: Array<{ sourceId: string; message: string }> = [];
    try {
      tracks.push(
        ...(await new LxMusicService(this.store, this.fetchImpl).playlist(
          name,
          deadline,
        )),
      );
    } catch (error) {
      signal?.throwIfAborted();
      sourceErrors.push({
        sourceId: "lx",
        message: error instanceof Error ? error.message : "歌单目录读取失败",
      });
    }
    if (mode === "legacy")
      for (const s of this.store
        .snapshot()
        .config.musicSources.filter((s) => s.enabled && s.playlistEndpoint))
        try {
          tracks.push(
            ...(await new HttpJsonMusicSource(
              { ...s, apiKey: s.apiKey ? this.store.decrypt(s.apiKey) : "" },
              reader.fetchImpl,
            ).searchPlaylist(name)),
          );
        } catch {
          signal?.throwIfAborted();
          sourceErrors.push({ sourceId: s.id, message: "兼容歌单源读取失败" });
        }
    return { tracks, sourceErrors };
  }
  private requirePrivate() {
    if (
      !["private", "hybrid"].includes(
        this.store.snapshot().config.musicServices.mode,
      )
    )
      throw new Error("当前模式未启用私人音乐库");
  }
  async browse(id: string, query: string, page: number) {
    this.requirePrivate();
    return this.adapter(id).search(query, page, this.index(id));
  }
  async collections(
    id: string,
    kind: CollectionKind,
    page: number,
    query = "",
  ) {
    this.requirePrivate();
    return this.adapter(id).collections(kind, page, this.index(id), query);
  }
  async collectionTracks(
    id: string,
    kind: CollectionKind,
    key: string,
    page: number,
  ) {
    this.requirePrivate();
    return this.adapter(id).collectionTracks(kind, key, page, this.index(id));
  }
  test(id: string) {
    return this.adapter(id).test();
  }
  async lyrics(track: MusicTrack) {
    this.assertTrack(track);
    if (!track.library)
      return new LxMusicService(this.store, this.fetchImpl).lyrics(track);
    try {
      const lyric = await this.adapter(track.library.providerId).lyric(track);
      const lines = parseLrc(lyric);
      return {
        lyric,
        lines,
        tlyric: "",
        available: !!lyric.trim(),
        timed: !!lines.length,
        reason: lyric ? "ok" : "not_found",
      };
    } catch {
      return {
        lyric: "",
        lines: [],
        tlyric: "",
        available: false,
        timed: false,
        reason: "unavailable",
      };
    }
  }
  private signature(provider: string, id: string, expires: number) {
    const c = this.store
      .snapshot()
      .config.musicServices.libraries.find((l) => l.id === provider);
    return this.store.sign(
      [
        "private-media-v1",
        provider,
        id,
        expires,
        c ? libraryFingerprint(c) : "removed",
        this.store.snapshot().config.musicServices.mode,
      ].join("\n"),
    );
  }
  async resolveFirstPlayable(tracks: MusicTrack[], signal?: AbortSignal) {
    this.assertOnline();
    const winner = await new LxMusicService(
      this.store,
      this.fetchImpl,
    ).resolveFirstPlayable(tracks, signal);
    this.assertTrack(tracks[winner.index]);
    return winner;
  }
  async resolvePlayback(track: MusicTrack, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertTrack(track);
    if (!track.library) {
      const resolved = await new LxMusicService(
        this.store,
        this.fetchImpl,
      ).resolvePlayback(track, signal);
      this.assertTrack(track);
      return resolved;
    }
    const config = this.store.snapshot().config.musicServices;
    if (!config.gatewayBaseUrl)
      throw new Error(
        "请在音乐服务中设置音箱可访问的平台地址（局域网 IP 和端口）",
      );
    const host = new URL(config.gatewayBaseUrl).hostname;
    if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(host))
      throw new Error("音箱无法访问回环地址，请填写部署机器的局域网 IP");
    // Resolve authentication now, before the speaker command. Never put these credentials in its URL.
    const before = libraryFingerprint(
      this.adapter(track.library.providerId).config,
    );
    const streamDeadline = AbortSignal.timeout(12000);
    const up = await this.adapter(track.library.providerId).stream(track.id, {
      headers: { range: "bytes=0-16383" },
      signal: signal
        ? AbortSignal.any([streamDeadline, signal])
        : streamDeadline,
    });
    if (![200, 206].includes(up.status)) {
      await up.body?.cancel();
      throw new Error("私人音乐库音频读取失败，HTTP " + up.status);
    }
    const reader = up.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        while (size < 16384) {
          const next = await reader.read();
          if (next.done) break;
          const b = next.value.subarray(0, 16384 - size);
          chunks.push(b);
          size += b.length;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    const bytes = Buffer.concat(chunks),
      known =
        audioFormat(bytes) ||
        bytes.subarray(0, 4).toString() === "MAC " ||
        bytes.subarray(0, 4).toString() === "FORM" ||
        bytes.subarray(0, 4).toString("hex") === "3026b275";
    if (!known)
      throw new Error("私人音乐库返回的内容不是可识别的音频，已取消投放");
    this.assertTrack(track);
    if (
      before !==
      libraryFingerprint(this.adapter(track.library.providerId).config)
    )
      throw new Error("音乐库配置已变化，请重试播放");
    return {
      url:
        config.gatewayBaseUrl +
        this.privateMediaPath(track.library.providerId, track.id),
      sourceId: track.sourceId,
      sourceName: config.libraries.find(
        (l) => l.id === track.library!.providerId,
      )!.name,
    };
  }
  async resolveBrowserPlayback(track: MusicTrack) {
    this.assertTrack(track);
    if (track.library)
      return this.privateMediaPath(track.library.providerId, track.id);
    return (await this.resolvePlayback(track)).url;
  }

  private privateMediaPath(provider: string, id: string) {
    const expires = Math.floor(Date.now() / 1000) + 43200;
    const encoded = Buffer.from(id).toString("base64url");
    return (
      "/media/private/" +
      provider +
      "/" +
      encoded +
      "/" +
      expires +
      "/" +
      this.signature(provider, encoded, expires) +
      "/audio.mp3"
    );
  }
  async media(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (!path.startsWith("/media/private/")) return false;
    const m = path.match(
      /^\/media\/private\/([\w-]{1,80})\/([\w-]{1,3000})\/(\d{10})\/([\w-]{43})\/audio\.mp3$/,
    );
    const fail = (status: number) => {
      response.writeHead(status, { "cache-control": "no-store" });
      response.end();
      return true;
    };
    if (!m || !["GET", "HEAD"].includes(request.method || "")) return fail(404);
    const [, provider, encoded, expiry, signature] = m,
      expires = Number(expiry),
      expected = this.signature(provider, encoded, expires);
    if (
      expires < Date.now() / 1000 ||
      expires > Date.now() / 1000 + 43260 ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return fail(403);
    try {
      this.requirePrivate();
    } catch {
      return fail(403);
    }
    let adapter;
    try {
      adapter = this.adapter(provider);
    } catch {
      return fail(403);
    }
    const id = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(id).toString("base64url") !== encoded) return fail(403);
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    const headers: Record<string, string> = {};
    const isDav = adapter.config.type === "webdav",
      file = isDav ? Buffer.from(id, "base64url").toString("utf8") : "";
    const transcode = isDav && !/\.(mp3|m4a|aac|wav)$/i.test(file);
    if (request.headers.range && !transcode) {
      if (!/^bytes=\d*-\d*$/.test(request.headers.range)) return fail(416);
      headers.range = request.headers.range;
    }
    if (typeof request.headers["if-range"] === "string" && !transcode)
      headers["if-range"] = request.headers["if-range"];
    let upstream: Response;
    try {
      upstream = await adapter.stream(id, {
        method: request.method,
        headers,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1800000)]),
      });
    } catch {
      return fail(502);
    }
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      return fail(502);
    }
    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";
    if (/json|html|xml|text\//i.test(contentType)) {
      await upstream.body?.cancel();
      return fail(502);
    }
    if (upstream.status === 416) {
      await upstream.body?.cancel();
      return fail(416);
    }
    const outgoing: Record<string, string> = {
      "content-type": transcode ? "audio/mpeg" : contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (!transcode)
      for (const key of [
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ]) {
        const v = upstream.headers.get(key);
        if (v) outgoing[key] = v;
      }
    if (request.method === "HEAD") {
      await upstream.body?.cancel();
      response.writeHead(transcode ? 200 : upstream.status, outgoing);
      response.end();
      return true;
    }
    if (!upstream.body) return fail(502);
    if (transcode) {
      if (transcodes >= 2) {
        await upstream.body.cancel();
        return fail(503);
      }
      transcodes++;
      const proc = spawn(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "pipe",
          "-i",
          "pipe:0",
          "-map",
          "0:a:0",
          "-vn",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "320k",
          "-write_xing",
          "0",
          "-f",
          "mp3",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      abort.signal.addEventListener("abort", () => proc.kill("SIGKILL"), {
        once: true,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          proc.once("spawn", resolve);
          proc.once("error", reject);
        });
        const input = pipeline(
          Readable.fromWeb(upstream.body as any),
          proc.stdin,
        ).catch(() => {
          proc.kill("SIGKILL");
        });
        const iterator = proc.stdout[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || !first.value.length)
          throw new Error("转码没有输出音频");
        response.writeHead(200, outgoing);
        await pipeline(
          Readable.from(
            (async function* () {
              yield first.value;
              for await (const chunk of iterator) yield chunk;
            })(),
          ),
          response,
        );
        await input;
      } catch {
        if (!response.headersSent) fail(502);
        else response.destroy();
      } finally {
        abort.abort();
        proc.kill("SIGKILL");
        transcodes--;
      }
    } else {
      response.writeHead(upstream.status, outgoing);
      try {
        await pipeline(Readable.fromWeb(upstream.body as any), response);
      } catch {
        response.destroy();
      }
    }
    return true;
  }
  async cover(provider: string, id: string, response: ServerResponse) {
    this.requirePrivate();
    const up = await this.adapter(provider).stream(id, {}, true);
    const type = up.headers.get("content-type")?.split(";")[0] || "";
    if (
      !up.ok ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)
    ) {
      await up.body?.cancel();
      throw new Error("音乐库没有返回有效封面");
    }
    const bytes = await limitedBytes(up, 2 * 1024 * 1024);
    response.writeHead(200, {
      "content-type": type,
      "content-length": bytes.length,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    });
    response.end(bytes);
  }
  scanStatus() {
    return this.store.snapshot().config.musicServices.libraries.map((c) => {
      const job = scans.get(this.store)?.get(c.id),
        index = this.store.snapshot().config.libraryIndexes[c.id];
      return {
        id: c.id,
        state: job?.state ?? "idle",
        count: job?.count ?? index?.tracks.length ?? 0,
        directories: job?.directories ?? 0,
        error: job?.error,
        scannedAt: index?.scannedAt,
        warnings: job?.warnings ?? index?.warnings,
      };
    });
  }
  startScan(id: string) {
    this.requirePrivate();
    const adapter = this.adapter(id);
    if (adapter.config.type !== "webdav")
      throw new Error("仅 WebDAV 需要扫描索引");
    let jobs = scans.get(this.store);
    if (!jobs) scans.set(this.store, (jobs = new Map()));
    if (jobs.get(id)?.state === "running") return this.scanStatus();
    if ([...jobs.values()].some((j) => j.state === "running"))
      throw new Error("已有音乐库在扫描，请等待或停止后再试");
    const c = this.store
        .snapshot()
        .config.musicServices.libraries.find((l) => l.id === id)!,
      fingerprint = libraryFingerprint(c);
    const job = {
      controller: new AbortController(),
      state: "running",
      count: 0,
      directories: 0,
      error: undefined as string | undefined,
      warnings: 0,
    };
    jobs.set(id, job);
    adapter
      .scan(this.index(id), job.controller.signal, (count, dirs) => {
        job.count = count;
        job.directories = dirs;
      })
      .then(async (index) => {
        job.controller.signal.throwIfAborted();
        await this.store.update((s) => {
          const current = s.config.musicServices.libraries.find(
            (l) => l.id === id,
          );
          if (
            job.controller.signal.aborted ||
            !current ||
            libraryFingerprint(current) !== fingerprint
          )
            throw new Error("配置已变化，扫描结果未保存");
          s.config.libraryIndexes[id] = { ...index, fingerprint };
        });
        job.state = "done";
        job.warnings = index.warnings;
      })
      .catch((e) => {
        job.state = job.controller.signal.aborted ? "cancelled" : "failed";
        job.error = job.controller.signal.aborted
          ? "扫描已停止，旧索引保留"
          : e instanceof Error
            ? e.message
            : "扫描失败";
      });
    return this.scanStatus();
  }
  stopScan(id?: string) {
    for (const [key, job] of scans.get(this.store) ?? [])
      if (!id || id === key) job.controller.abort();
    return this.scanStatus();
  }
}
