import { musicPlatformByName } from "../music/lx/platforms.ts";
import type { AssistantIntent, ControlCommand } from "./types.ts";
import type { PlaybackMode } from "../playback/mode.ts";

const controls: Array<[RegExp, ControlCommand]> = [
  [/^(?:暂停|暂停一下|暂停播放|先停一下|停一下|歇一会儿)$/, "pause"],
  [/^(?:继续|继续播放|接着听|恢复播放)$/, "resume"],
  [/^(?:下一首|切到下一首|换一首|跳过这首)$/, "next"],
  [/^(?:上一首|切回上一首)$/, "previous"],
  [/^(?:停止|停止播放|别放了|关掉音乐)$/, "stop"],
];

const modePatterns: Array<[RegExp, PlaybackMode]> = [
  [
    /^(?:顺序播放|按顺序(?:播放|放歌)|顺序模式|取消(?:单曲|列表)循环|关闭(?:单曲|列表)循环|关闭随机(?:播放)?|别(?:再|一直)?单曲循环(?:了)?)$/u,
    "order",
  ],
  [
    /^(?:列表循环(?:播放)?|循环列表|循环播放(?:整个|当前)?(?:歌单|列表)|循环播放|循环模式)$/u,
    "loop",
  ],
  [
    /^(?:单曲循环(?:播放)?|循环(?:播放)?(?:这首|这一首)(?:歌)?|重复(?:播放)?(?:这首|这一首)(?:歌)?)$/u,
    "single",
  ],
  [
    /^(?:随机(?:播放|放歌|模式)?|打乱(?:顺序)?播放|打乱(?:播放)?顺序)$/u,
    "random",
  ],
];

const playPrefixes =
  /^(?:(?:我)?想听|(?:我)?要听|请播放|帮我播放|给我播放|给我放|播放|放|来一首|来几首|来点)\s*/u;
const politeness = /(?:吧|好吗|可以吗|谢谢)$/u;
const genericArtistSuffix = /(?:的)?(?:歌|歌曲|音乐|作品)$/u;

function clean(value: string): string {
  return value
    .trim()
    .replace(/^[，,：:\s]+|[，,。.!！?？\s]+$/gu, "")
    .replace(politeness, "")
    .trim();
}

function splitMusicPlatform(text: string) {
  const match = text.match(
    /^(?:用|从|在)\s*(网易云|QQ\s*|酷狗|酷我|咪咕)(?:音乐)?\s*(?:里面|上|里)?\s*/iu,
  );
  if (!match) return { text };
  return {
    text: text.slice(match[0].length),
    platform: musicPlatformByName(match[1]),
  };
}

export function explicitMusicQuery(text: string): string | undefined {
  const normalized = clean(
    text.replace(/^(?:小爱同学|小爱|嘿小爱)[，,：:\s]*/u, ""),
  );
  const { text: command } = splitMusicPlatform(normalized);
  const prefix = command.match(playPrefixes);
  if (!prefix) return undefined;
  const query = clean(splitMusicPlatform(command.slice(prefix[0].length)).text)
    .replace(/^(?:一首|一段)/u, "")
    .replace(/(?:这首)?(?:歌曲|音乐|歌)$/u, "")
    .replace(/^[《“"]|[》”"]$/gu, "")
    .trim();
  return query || undefined;
}

export function parseRuleIntent(text: string): AssistantIntent | null {
  const normalized = clean(
    text.replace(/^(?:小爱同学|小爱|嘿小爱)[，,：:\s]*/u, ""),
  );
  const modeRequest = normalized.replace(
    /^(?:请|帮我|给我)?\s*(?:把)?\s*(?:播放器的?)?\s*(?:播放模式)?\s*(?:(?:切换|切|改|调|设置|设)(?:到|成|为)|(?:开启|打开)|用)?\s*/u,
    "",
  );
  const mode = modePatterns.find(([pattern]) => pattern.test(modeRequest))?.[1];
  if (mode)
    return {
      action: "set_playback_mode",
      mode,
      confidence: 0.99,
      source: "rules",
    };

  for (const [pattern, command] of controls) {
    if (pattern.test(normalized)) {
      return { action: "control", command, confidence: 0.99, source: "rules" };
    }
  }
  if (
    /^(?:音量|声音)(?:大一点|大点|调大|小一点|小点|调小|降低|增大)$/u.test(
      normalized,
    )
  ) {
    return {
      action: "clarify",
      question: "音量需要设置为 0 到 100 的数值，例如“音量调到 30”。",
      confidence: 0.96,
      source: "rules",
    };
  }
  const volumeMatch = normalized.match(
    /^(?:请)?(?:把)?(?:音量|声音)(?:调到|调至|设置为|设为|设成|调成|改为)\s*(\d{1,3})(?:%|百分比)?$/u,
  );
  if (volumeMatch) {
    const volume = Number(volumeMatch[1]);
    if (volume > 100)
      return {
        action: "clarify",
        question: "音量范围是 0 到 100，请告诉我要调到多少。",
        confidence: 0.96,
        source: "rules",
      };
    return { action: "set_volume", volume, confidence: 0.99, source: "rules" };
  }

  if (
    /^(?:怎么|为什么|什么是|告诉我|解释一下|能不能|可不可以)/u.test(normalized)
  )
    return null;
  const leading = splitMusicPlatform(normalized);
  const match = leading.text.match(playPrefixes);
  const requestText = splitMusicPlatform(
    match ? leading.text.slice(match[0].length) : "",
  );
  const platform = leading.platform ?? requestText.platform;
  let request = clean(requestText.text);
  const playlistText = (match ? request : normalized).match(
    /^(.+?)(?:的)?歌单$/u,
  );
  if (playlistText?.[1]) {
    return {
      action: "play_playlist",
      playlist: clean(playlistText[1]),
      confidence: 0.96,
      source: "rules",
    };
  }
  // Offline fallback only. A configured model interprets natural music requests.
  const popularArtist = (match ? request : normalized).match(
    /^(?:几首|一些)?([^《》“”"？，,。]+?)的(?:一些|几首|几支)?(?:最热门|热门|最火|经典|代表性)(?:的)?(?:老歌|歌曲|歌|音乐|作品)$|^(?:几首|一些)?([^《》“”"？，,。]+?)的(?:几首|一些)?(?:代表作|成名曲|热歌)$/u,
  );
  if (popularArtist)
    return {
      action: "play_artist",
      artist: clean(popularArtist[1] ?? popularArtist[2]),
      preference: "popular",
      confidence: 0.96,
      source: "rules",
    };
  if (!match) {
    const artistOnly = normalized.match(/^(.+?)的(?:歌|歌曲|音乐|作品)$/u);
    if (artistOnly?.[1])
      return {
        action: "play_artist",
        artist: clean(artistOnly[1]),
        confidence: 0.92,
        source: "rules",
      };
  }
  if (!match) {
    const naturalSong = normalized.match(
      /^([^，,。.!！?？]+?)的([^，,。.!！?？]+)$/u,
    );
    if (
      !naturalSong?.[1] ||
      !naturalSong[2] ||
      /(?:怎么|为什么|什么是|告诉我|解释|能不能|可不可以|要不要|天气|温度|时间|日期|新闻|热点|情况|怎么样|如何|多少|哪里|谁|是否)/u.test(
        normalized,
      )
    )
      return null;
    return {
      action: "play_song",
      artist: clean(naturalSong[1]),
      title: clean(naturalSong[2]),
      confidence: 0.84,
      source: "rules",
    };
  }
  if (!request) return null;
  const quotedTitle = request.match(/^[《“"](.+)[》”"](?:这首歌)?$/u);
  if (quotedTitle)
    return {
      action: "play_song",
      title: quotedTitle[1],
      ...(platform ? { platform } : {}),
      confidence: 0.99,
      source: "rules",
    };

  const artistRequest = request.match(/^(.+?)的(?:歌|歌曲|音乐|作品)$/u);
  if (artistRequest?.[1]) {
    return {
      action: "play_artist",
      artist: artistRequest[1],
      confidence: 0.96,
      source: "rules",
    };
  }

  const split = request.match(/^(.+?)的(.+)$/u);
  if (split?.[1] && split[2]) {
    const title = clean(
      split[2].replace(/^(?:那首|这首)/u, "").replace(genericArtistSuffix, ""),
    );
    if (title)
      return {
        action: "play_song",
        artist: clean(split[1]),
        title,
        ...(platform ? { platform } : {}),
        confidence: 0.96,
        source: "rules",
      };
  }

  request = clean(
    request
      .replace(/^(?:一首|一段)/u, "")
      .replace(/(?:这首)?(?:歌|歌曲|音乐)$/u, ""),
  );
  if (!request) return null;
  return {
    action: "play_song",
    title: request,
    ...(platform ? { platform } : {}),
    confidence: 0.84,
    source: "rules",
  };
}
