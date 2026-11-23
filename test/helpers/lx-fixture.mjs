export const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
export const lxFixtureScript = [
  "/**",
  " * @name Browser acceptance source",
  " * @version 1.0.0",
  " * @description Test data only; does not access media services.",
  " */",
  'lx.send("inited",{sources:Object.fromEntries(["wy","tx","kg","kw","mg"].map(p=>[p,{actions:["musicUrl"],qualitys:["128k","320k"]}]))});',
  'lx.on("request",({info})=>new Promise((resolve,reject)=>lx.request("https://source.example/resolve?id="+encodeURIComponent(info.musicInfo.songmid),{},(e,r,b)=>e?reject(e):resolve(b.url))));',
].join("\n");
const wySongs = ["晴天", "稻香"].map((name, index) => ({
  id: index + 1,
  name,
  ar: [{ name: "周杰伦" }],
  al: { name: "测试专辑", id: 1, picUrl: "" },
  dt: 269000,
  privilege: { maxbr: 320000 },
  h: { size: 1000000 },
  l: { size: 500000 },
}));
const list = {
  id: 123,
  name: "验收歌单",
  creator: { nickname: "Fixture" },
  coverImgUrl: "",
  trackCount: 2,
  playCount: 100,
  description: "测试目录",
};
export function catalogFixture(input) {
  const url = new URL(input);
  if (url.hostname.endsWith("163.com")) {
    if (url.pathname.includes("lyric"))
      return {
        code: 200,
        lrc: {
          lyric:
            "[00:01.00]测试歌词第一句\n[00:12.00]测试歌词第二句\n[00:20.00]测试歌词第三句",
        },
        tlyric: { lyric: "[00:12.00]A translated fixture line" },
      };
    if (url.pathname.includes("catalogue"))
      return {
        code: 200,
        sub: [{ category: 0, name: "华语" }],
        categories: { 0: "语种" },
      };
    if (url.pathname.includes("hottags"))
      return { code: 200, tags: [{ playlistTag: { name: "华语" } }] };
    if (url.pathname.includes("playlist/list"))
      return { code: 200, total: 2, playlists: [list] };
    if (
      url.pathname.includes("playlist/detail") ||
      url.pathname.includes("linux/forward")
    )
      return {
        code: 200,
        playlist: {
          ...list,
          trackIds: wySongs.map(({ id }) => ({ id })),
          tracks: wySongs,
        },
        privileges: wySongs.map(({ id }) => ({ id, maxbr: 320000 })),
      };
    if (url.pathname.includes("song/detail"))
      return {
        code: 200,
        songs: wySongs,
        privileges: wySongs.map(({ id }) => ({ id, maxbr: 320000 })),
      };
    return {
      code: 200,
      data: {
        totalCount: 2,
        resources: wySongs.map((song) => ({
          baseInfo: { simpleSongData: song },
        })),
        itemList: [{ searchWord: "晴天" }, { searchWord: "周杰伦" }],
      },
      result: { playlistCount: 1, playlists: [list] },
      songs: wySongs,
      privileges: wySongs.map(({ id }) => ({ id, maxbr: 320000 })),
    };
  }
  if (url.hostname.includes("qq.com"))
    return {
      code: 0,
      "music.search.SearchCgiService": {
        code: 0,
        data: {
          body: {
            song: {
              list: [
                {
                  title: "晴天",
                  mid: "qq-one",
                  id: 1,
                  file: {
                    media_mid: "qq-one",
                    size_128mp3: 1,
                    size_320mp3: 1,
                    size_flac: 0,
                    size_hires: 0,
                  },
                  singer: [{ name: "周杰伦", mid: "singer" }],
                  album: { name: "测试专辑", mid: "album" },
                  interval: 269,
                },
              ],
            },
          },
          meta: { sum: 1 },
        },
      },
    };
  if (url.hostname.includes("kugou"))
    return {
      error_code: 0,
      data: {
        total: 1,
        lists: [
          {
            Audioid: 1,
            FileHash: "kg-one",
            OriSongName: "晴天",
            Singers: [{ name: "周杰伦" }],
            Duration: 269,
            FileSize: 1,
            HQFileSize: 0,
            SQFileSize: 0,
            ResFileSize: 0,
            AlbumName: "测试专辑",
            Grp: [],
          },
        ],
      },
    };
  if (url.hostname.includes("kuwo"))
    return {
      TOTAL: "1",
      SHOW: "1",
      abslist: [
        {
          MUSICRID: "MUSIC_1",
          SONGNAME: "晴天",
          ARTIST: "周杰伦",
          DURATION: "269",
          N_MINFO: "level:exhigh,bitrate:320,format:mp3,size:8.2Mb",
        },
      ],
    };
  if (url.hostname.includes("migu"))
    return {
      code: "000000",
      songResultData: {
        totalCount: 1,
        resultList: [
          [
            {
              songId: "mg-one",
              copyrightId: "mg-copyright",
              name: "晴天",
              singerList: [{ name: "周杰伦" }],
              album: "测试专辑",
              duration: 269,
              audioFormats: [{ formatType: "PQ", asize: 1000 }],
            },
          ],
        ],
      },
    };
  throw Error("No catalog fixture for " + url.hostname);
}
