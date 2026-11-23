import type { MusicSource, MusicRequest, MusicTrack } from "./types.ts";
import type { MusicSourceConfig } from "../storage/store.ts";

export class HttpJsonMusicSource implements MusicSource {
  readonly id: string;
  private readonly config: MusicSourceConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MusicSourceConfig, fetchImpl: typeof fetch = fetch) {
    this.id = config.id;
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async search(request: MusicRequest): Promise<MusicTrack[]> {
    const url = new URL(this.config.endpoint);
    if (this.config.protocol === "topone") {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...this.authHeader(),
        },
        body: JSON.stringify({
          keyword: request.artist
            ? request.artist + " " + request.title
            : request.title,
          hint: {
            title: request.title,
            ...(request.artist ? { artist: request.artist } : {}),
          },
          quality: "320k",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error("topone 音乐源请求失败，HTTP " + response.status);
      const text = await readLimited(response, 2 * 1024 * 1024);
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new Error("topone 音乐源没有返回有效 JSON");
      }
      if (!envelope || typeof envelope !== "object")
        throw new Error("topone 音乐源响应格式无效");
      const result = envelope as Record<string, unknown>;
      if (Number(result.code) !== 0)
        throw new Error(textField(result.msg) || "topone 音乐源未找到歌曲");
      const data =
        result.data && typeof result.data === "object"
          ? (result.data as Record<string, unknown>)
          : undefined;
      if (!data) return [];
      return normalizeTracks([data], this.id);
    }
    url.searchParams.set(
      "q",
      request.artist ? request.artist + " " + request.title : request.title,
    );
    url.searchParams.set("title", request.title);
    if (request.artist) url.searchParams.set("artist", request.artist);
    const payload = await this.fetchPayload(url);
    const entries = arrayField(payload, ["tracks", "results", "data"]);
    if (!entries)
      throw new Error("音乐源响应中需要 tracks、results 或 data 数组");
    return normalizeTracks(entries, this.id);
  }

  async searchPlaylist(name: string): Promise<MusicTrack[]> {
    if (!this.config.playlistEndpoint) return [];
    const url = new URL(this.config.playlistEndpoint);
    url.searchParams.set("q", name);
    url.searchParams.set("playlist", name);
    const payload = await this.fetchPayload(url);
    const direct = arrayField(payload, ["tracks", "songs", "items"]);
    if (direct && (direct.length === 0 || direct.some(isTrackRecord)))
      return normalizeTracks(direct, this.id, Infinity);

    const playlists = arrayField(payload, ["playlists", "results", "data"]);
    if (!playlists)
      throw new Error("歌单源响应中需要 playlists、results 或 data 数组");
    const named = playlists.filter((raw) => raw && typeof raw === "object");
    const exact = named.find((raw) => {
      const item = raw as Record<string, unknown>;
      return (
        textField(item.name ?? item.title)
          .normalize("NFKC")
          .toLocaleLowerCase() === name.normalize("NFKC").toLocaleLowerCase()
      );
    });
    if (!exact && named.length && named.every(isTrackRecord))
      return normalizeTracks(named, this.id, Infinity);
    const selected = exact ?? (named.length === 1 ? named[0] : undefined);
    if (!selected || typeof selected !== "object") return [];
    const entries = arrayField(selected, [
      "tracks",
      "songs",
      "items",
      "songList",
    ]);
    return entries ? normalizeTracks(entries, this.id, Infinity) : [];
  }

  private async fetchPayload(url: URL): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.authHeader(),
    };
    const response = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error("音乐源请求失败，HTTP " + response.status);
    const text = await readLimited(response, 2 * 1024 * 1024);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("音乐源没有返回有效 JSON");
    }
  }

  private authHeader(): Record<string, string> {
    return this.config.apiKey
      ? { authorization: "Bearer " + this.config.apiKey }
      : {};
  }
}

function arrayField(value: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys)
    if (Array.isArray(record[key])) return record[key] as unknown[];
  return undefined;
}

function isTrackRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return Boolean(
    textField(item.title ?? item.name) &&
    textField(item.playUrl ?? item.url ?? item.src),
  );
}

function normalizeTracks(
  entries: unknown[],
  sourceId: string,
  limit = 200,
): MusicTrack[] {
  return entries.slice(0, limit).flatMap((raw, index): MusicTrack[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const title = textField(item.title ?? item.name);
    const artist = textField(item.artist ?? item.author ?? item.singer);
    const playUrl = validPlayUrl(
      textField(item.playUrl ?? item.url ?? item.src),
    );
    if (!title || !artist || !playUrl) return [];
    const durationSeconds = numberField(item.durationSeconds ?? item.duration);
    return [
      {
        id: textField(item.id) || String(index),
        sourceId,
        title,
        artist,
        ...(textField(item.album) ? { album: textField(item.album) } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(textField(item.quality)
          ? { quality: textField(item.quality) }
          : {}),
        playUrl,
      },
    ];
  });
}

async function readLimited(
  response: Response,
  maximum: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximum) throw new Error("音乐源响应超过 2 MB 限制");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("音乐源响应超过 2 MB 限制");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function textField(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function numberField(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function validPlayUrl(value: string): string {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}
