import { createHash } from "node:crypto";

const key = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");

/** Keep named playlists literal; relax only an explicit descriptive request. */
export function playlistQuery(name: string) {
  const literal = name.trim();
  const match = literal
    .replace(/歌单$/u, "")
    .match(
      /^(.+?)(?:的)?(?:一些|几个|几张|一份|一张|一些好听的)?(热门|热歌|经典|精选|最火|流行|代表作)(?:的)?$/u,
    );
  const keyword = match?.[1]?.replace(/的$/u, "").trim();
  return {
    name: literal,
    keyword: keyword || literal,
    descriptive: !!keyword,
    preference: match?.[2] || "",
  };
}

export function playlistScore(
  query: ReturnType<typeof playlistQuery>,
  name: string,
) {
  if (key(name) === key(query.name)) return 1000;
  if (!query.descriptive || !key(name).includes(key(query.keyword))) return 0;
  if (
    /(?:翻唱|伴奏|纯音乐|钢琴版|八音盒)/u.test(name) &&
    !/(?:翻唱|伴奏|纯音乐|钢琴|八音盒)/u.test(query.keyword)
  )
    return 0;
  return (
    10 +
    (name.includes(query.preference) ? 5 : 0) +
    (/(?:热门|热歌|经典|精选|金曲|最火|代表作)/u.test(name) ? 2 : 0)
  );
}

export function playlistPopularity(value: unknown) {
  const text = String(value ?? "").replaceAll(",", "");
  const amount = Number.parseFloat(text);
  return Number.isFinite(amount)
    ? amount * (text.includes("亿") ? 1e8 : text.includes("万") ? 1e4 : 1)
    : 0;
}

/** Bound work by a deadline and forward progress, never by a song count. */
export async function completePlaylist<T>(
  read: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  identity: (item: T) => string,
  signal: AbortSignal,
): Promise<T[]> {
  const tracks: T[] = [];
  const pages = new Set<string>();
  for (let page = 1; ; page++) {
    signal.throwIfAborted();
    const result = await read(page);
    signal.throwIfAborted();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(result.items.map(identity)))
      .digest("hex");
    if (
      (result.items.length && pages.has(fingerprint)) ||
      (!result.items.length && result.hasMore)
    )
      throw new Error("歌单接口重复返回或未返回下一页，无法完整读取歌单");
    pages.add(fingerprint);
    tracks.push(...result.items);
    if (!result.hasMore) return tracks;
  }
}
