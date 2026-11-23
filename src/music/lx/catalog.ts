import kwSearch from "../../../vendor/lx-music/musicSdk/kw/musicSearch.js";
import kgSearch from "../../../vendor/lx-music/musicSdk/kg/musicSearch.js";
import txSearch from "../../../vendor/lx-music/musicSdk/tx/musicSearch.js";
import wySearch from "../../../vendor/lx-music/musicSdk/wy/musicSearch.js";
import mgSearch from "../../../vendor/lx-music/musicSdk/mg/musicSearch.js";
import kwList from "../../../vendor/lx-music/musicSdk/kw/songList.js";
import kgList from "../../../vendor/lx-music/musicSdk/kg/songList.js";
import txList from "../../../vendor/lx-music/musicSdk/tx/songList.js";
import wyList from "../../../vendor/lx-music/musicSdk/wy/songList.js";
import mgList from "../../../vendor/lx-music/musicSdk/mg/songList.js";
import kwHot from "../../../vendor/lx-music/musicSdk/kw/hotSearch.js";
import kgHot from "../../../vendor/lx-music/musicSdk/kg/hotSearch.js";
import txHot from "../../../vendor/lx-music/musicSdk/tx/hotSearch.js";
import wyHot from "../../../vendor/lx-music/musicSdk/wy/hotSearch.js";
import mgHot from "../../../vendor/lx-music/musicSdk/mg/hotSearch.js";
import kwBoard from "../../../vendor/lx-music/musicSdk/kw/leaderboard.js";
import kgBoard from "../../../vendor/lx-music/musicSdk/kg/leaderboard.js";
import txBoard from "../../../vendor/lx-music/musicSdk/tx/leaderboard.js";
import wyBoard from "../../../vendor/lx-music/musicSdk/wy/leaderboard.js";
import mgBoard from "../../../vendor/lx-music/musicSdk/mg/leaderboard.js";
import kwLyric from "../../../vendor/lx-music/musicSdk/kw/lyric.js";
import kgLyric from "../../../vendor/lx-music/musicSdk/kg/lyric.js";
import txLyric from "../../../vendor/lx-music/musicSdk/tx/lyric.js";
import wyLyric from "../../../vendor/lx-music/musicSdk/wy/lyric.js";
import mgLyric from "../../../vendor/lx-music/musicSdk/mg/lyric.js";
import { withLxHttp, abortable } from "./http.ts";

export const PLATFORMS = ["wy", "tx", "kg", "kw", "mg"] as const;
export type LxPlatform = (typeof PLATFORMS)[number];
const modules: Record<string, Record<string, any>> = {
  kw: { search: kwSearch, list: kwList, hot: kwHot, board: kwBoard },
  kg: { search: kgSearch, list: kgList, hot: kgHot, board: kgBoard },
  tx: { search: txSearch, list: txList, hot: txHot, board: txBoard },
  wy: { search: wySearch, list: wyList, hot: wyHot, board: wyBoard },
  mg: { search: mgSearch, list: mgList, hot: mgHot, board: mgBoard },
};
const lyricModules: Record<string, any> = {
  kw: kwLyric,
  kg: kgLyric,
  tx: txLyric,
  wy: wyLyric,
  mg: mgLyric,
};
export function lxPlatform(raw: unknown): LxPlatform {
  if (typeof raw !== "string" || !PLATFORMS.includes(raw as LxPlatform))
    throw new Error("不支持的音乐平台");
  return raw as LxPlatform;
}
export class LxCatalog {
  private fetchImpl?: typeof fetch;
  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }
  sorts(platform: LxPlatform) {
    return structuredClone(modules[platform].list.sortList ?? []);
  }
  async lyrics(
    platform: LxPlatform,
    songInfo: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const deadline = signal ?? AbortSignal.timeout(12000);
    return withLxHttp(
      this.fetchImpl,
      () => {
        const module = lyricModules[platform];
        const instance = Object.assign(
          Object.create(Object.getPrototypeOf(module)),
          module,
        );
        const request =
          typeof module === "function"
            ? module(songInfo.songmid)
            : instance.getLyric(structuredClone(songInfo));
        return abortable(request.promise, deadline);
      },
      deadline,
    );
  }
  async call(
    platform: LxPlatform,
    group: string,
    method: string,
    ...args: any[]
  ): Promise<any> {
    return this.request(platform, group, method, args);
  }
  async request(
    platform: LxPlatform,
    group: string,
    method: string,
    args: any[],
    signal?: AbortSignal,
  ): Promise<any> {
    if (group === "board" && method === "getList") {
      // The player selects a display id (e.g. tx__4), while upstream modules
      // require the native bangid. Resolve from this platform's board catalog;
      // never pass a prefixed or cross-platform id to an upstream request.
      signal ??= AbortSignal.timeout(15000);
      const boards = await this.request(
        platform,
        "board",
        "getBoards",
        [],
        signal,
      );
      const id = String(args[0] ?? "");
      const board = boards.list?.find(
        (item: any) => item.id === id || String(item.bangid) === id,
      );
      if (!board) throw new Error("找不到该平台的排行榜，请刷新榜单后重试");
      args = [String(board.bangid), ...args.slice(1)];
    }
    const source = modules[platform]?.[group];
    if (!source || typeof source[method] !== "function")
      throw new Error("该平台暂不支持此项操作");
    const instance = Object.assign(
      Object.create(Object.getPrototypeOf(source)),
      source,
    );
    const result = await withLxHttp(
      this.fetchImpl,
      () => source[method].apply(instance, args),
      signal,
    );
    if (
      result &&
      Array.isArray(result.list) &&
      ["getList", "getListDetail", "search"].includes(method)
    ) {
      const page =
        Number(result.page) ||
        (method === "getList"
          ? Number(args[group === "list" ? 2 : 1])
          : Number(args[1])) ||
        1;
      const limit = Number(result.limit) || result.list.length || 30;
      return {
        ...result,
        page,
        page_size: limit,
        returned_count: result.list.length,
        has_more: page * limit < Number(result.total || 0),
      };
    }
    return result;
  }
  async search(
    platform: LxPlatform,
    keyword: string,
    page = 1,
    type = "song",
    signal?: AbortSignal,
  ) {
    if (!["song", "songlist", "playlist"].includes(type))
      throw new Error("请按歌曲名称或歌手关键词搜索；专辑目录暂不支持");
    const result = await this.request(
      platform,
      type === "songlist" || type === "playlist" ? "list" : "search",
      "search",
      [keyword, page, 30],
      signal,
    );
    const list = Array.isArray(result?.list) ? result.list : [];
    return {
      ...result,
      list: list.slice(0, 200),
      page,
      page_size: result.limit ?? 30,
      returned_count: list.length,
      has_more: page * (result.limit ?? 30) < (result.total ?? 0),
    };
  }
}
