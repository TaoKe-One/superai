// Reproducible, offline import. Upstream code is never executed by this script.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname, relative, extname } from "node:path";
import { createHash } from "node:crypto";

const [official, plugin] = process.argv.slice(2);
if (!official || !plugin)
  throw new Error(
    "Usage: node scripts/import-lx.mjs <LX desktop source> <LX plugin directory>",
  );
const base = resolve(official, "src/renderer/utils");
const common = resolve(official, "src/common/utils/lyricUtils");
const output = resolve("vendor/lx-music");
const destination = (path) =>
  path.startsWith(common + "/")
    ? resolve(output, "common/lyricUtils", relative(common, path))
    : resolve(output, relative(base, path));
const pending = ["kw", "kg", "tx", "wy", "mg"].flatMap((p) =>
  ["musicSearch", "songList", "hotSearch", "leaderboard", "lyric"].map((n) =>
    resolve(base, "musicSdk", p, n + ".js"),
  ),
);
const copied = new Map();
const hash = (data) => createHash("sha256").update(data).digest("hex");
while (pending.length) {
  const path = pending.pop();
  if (copied.has(path)) continue;
  const raw = await readFile(path, "utf8");
  copied.set(path, hash(raw));
  const imports = [...raw.matchAll(/^import .*? from ['"]([^'"]+)['"]/gm)];
  let code = raw;
  // Upstream caches are desktop-global. Keep requests scoped to this platform's
  // bounded, per-store lyric cache instead of sharing pending HTTP contexts.
  if (path.endsWith("/tx/lyric.js")) {
    const start = code.indexOf("    if (songIdMap.has(songmid))");
    const end = code.indexOf("    return info.songId", start);
    if (start < 0 || end < 0) throw new Error("TX lyric cache anchor changed");
    code =
      code.slice(0, start) +
      "    const info = await getMusicInfo(songmid)\n" +
      code.slice(end);
    code = code.replace(
      "const songIdMap = new Map()\nconst promises = new Map()\n",
      "",
    );
    code = code.replace(
      "return this.getLyric(songId, ++retryNum)",
      "return this.getLyric(mInfo, ++retryNum).promise",
    );
    code = code.replace(
      "if (retryNum > 3) return Promise.reject(new Error('Get lyric failed'))",
      "if (retryNum > 3) return { promise: Promise.reject(new Error('Get lyric failed')) }",
    );
  }
  if (path.endsWith("/kg/lyric.js"))
    code = code.replace(
      "this.getLyric(id, accessKey, fmt, ++tryNum)",
      "this.getLyricDownload(id, accessKey, fmt, ++tryNum)",
    );
  // Remove an upstream commented example cookie; it is not configuration.
  code = code.replace(/^.*\/\/ cookie:.*$/gm, "");
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === "zlib") {
      let replacement = relative(
        dirname(destination(path)),
        resolve(output, "zlib.js"),
      );
      if (!replacement.startsWith(".")) replacement = "./" + replacement;
      code = code.replace(match[0], match[0].replace(specifier, replacement));
      continue;
    }
    if (
      !specifier.startsWith(".") &&
      !specifier.startsWith("@renderer/utils") &&
      !specifier.startsWith("@common/utils/lyricUtils/")
    )
      continue;
    let target = specifier.startsWith("@common/utils/lyricUtils/")
      ? resolve(common, specifier.slice("@common/utils/lyricUtils/".length))
      : specifier.startsWith("@renderer/utils")
        ? resolve(base, "." + specifier.slice("@renderer/utils".length))
        : resolve(dirname(path), specifier);
    if (target === base || target === resolve(base, "index"))
      target = resolve(base, "index.js");
    else if (target === resolve(base, "request"))
      target = resolve(base, "request.js");
    else {
      if (
        !target.startsWith(base + "/musicSdk/") &&
        !target.startsWith(common + "/")
      )
        throw new Error("Unexpected LX dependency: " + target);
      if (!/\.(?:js|ts)$/.test(target)) {
        try {
          await readFile(target + ".js");
          target += ".js";
        } catch {
          try {
            await readFile(target + ".ts");
            target += ".ts";
          } catch {
            target = resolve(target, "index.js");
          }
        }
      }
      pending.push(target);
    }
    let replacement = relative(
      dirname(destination(path)),
      destination(target),
    ).replaceAll("\\", "/");
    if (!replacement.startsWith(".")) replacement = "./" + replacement;
    code = code.replace(match[0], match[0].replace(specifier, replacement));
  }
  const dest = destination(path);
  if (path.endsWith("/infSign.min.js"))
    code =
      "const module={exports:{}};const exports=module.exports;\n" +
      code +
      "\nexport default module.exports;\n";
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(
    dest,
    "// Adapted for Node ESM by 超级爱. See vendor/NOTICE.md.\n" +
      code.replace(/\n(?:[ \t]*\r?\n)+$/, "\n"),
  );
}
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "index.js"),
  'export * from "../../src/music/lx/format.js";\n',
);
await writeFile(
  resolve(output, "request.js"),
  'export { httpFetch } from "../../src/music/lx/http.ts";\n',
);
await writeFile(
  resolve(output, "zlib.js"),
  'export * from "../../src/music/lx/zlib.js";\n',
);
await copyFile(resolve(official, "LICENSE"), resolve(output, "LICENSE"));
const files = [
  "static/js/app.bundle.7abaa0ce.js",
  "static/css/style.e29031f6.css",
];
const expected = [
  "7abaa0ce5c9ae3a50a8ef9cf9a66a1d8823eee836b541360d2c54e2164664e5f",
  "e29031f6ae940a466605f558c5cdf12dfa1c372fad515bc90bac4e70c87b1129",
];
const assets = [];
for (const [index, name] of files.entries()) {
  const data = await readFile(resolve(plugin, name));
  if (hash(data) !== expected[index])
    throw new Error("Unexpected player artifact: " + name);
  const dest = resolve("public/lx", name);
  await mkdir(dirname(dest), { recursive: true });
  let content = data;
  if (name.endsWith(".js")) {
    let js = data.toString();
    if (js.split("async function ge(e,t={}){").length !== 2)
      throw new Error("Transport patch anchor changed");
    js = js.replace(
      "async function ge(e,t={}){",
      "async function ge(e,t={}){return globalThis.SpeakerLX.request(e,t);",
    );
    js = js.replace(/(?<![\w$])Vt\(\)/g, "globalThis.SpeakerLX.player(Vt())");
    js = js.replace(/(?<![\w$])lt\(\)/g, "globalThis.SpeakerLX.app(lt())");
    // Keep one LX player/store and reuse its original table and import dialog.
    const replaceOnce = (anchor, replacement) => {
      if (js.split(anchor).length !== 2)
        throw new Error("Player catalog anchor changed: " + anchor);
      js = js.replace(anchor, replacement);
    };
    // Match the repeat icon's 80-unit shafts and 45-degree arrowheads.
    const orderIconPath =
      "M680 120 624 178 686 240H120V320H686L624 382L680 440L840 280Z" +
      "M680 520 624 578 686 640H120V720H686L624 782L680 840L840 680Z";
    replaceOnce(
      'remove:"M200 440V520H760V440Z",',
      `remove:"M200 440V520H760V440Z",play_in_order:"${orderIconPath}",`,
    );
    replaceOnce('singlePlay:"remove"', 'singlePlay:"play_in_order"');
    // The shared row handler now passes the complete playback context.
    replaceOnce(
      "V=(H,w,B)=>{let T=Math.max(Number(l.playContextLimit)||1e3,1),ae=Array.isArray(H)&&H.length>0?H:z.value,te=x(w),se=ae.findIndex(_e=>x(_e)===te);if(se<0&&(se=Math.min(Math.max(B,0),Math.max(ae.length-1,0))),ae.length<=T)return{list:ae,index:se};let ue=se-Math.floor(T/2);return ue=Math.max(0,Math.min(ue,ae.length-T)),{list:ae.slice(ue,ue+T),index:se-ue}},",
      "",
    );
    replaceOnce(
      'f[2]||(f[2]=de(" \\u5F53\\u524D\\u64AD\\u653E ",-1)),n("span",th,"("+P(g(t).playlist.length)+")",1)',
      'f[2]||(f[2]=de(" 当前队列 ",-1))',
    );
    replaceOnce(
      "r=K(()=>{switch(t.currentView)",
      'libraryView=globalThis.SpeakerLibrary({h:S,reactive:jl,computed:K,watch:Pe,onUnmounted:ot,getApp:()=>globalThis.SpeakerLX.app(lt()),getPlayer:()=>globalThis.SpeakerLX.player(Vt()),table:ka,importModal:as}),privateCatalog=globalThis.SpeakerPrivateCatalog({h:S,reactive:jl,watch:Pe,onUnmounted:ot,getApp:()=>globalThis.SpeakerLX.app(lt()),getPlayer:()=>globalThis.SpeakerLX.player(Vt()),table:ka,importModal:as,searchInput:qo}),r=K(()=>{if(t.currentView==="library")return libraryView;if(t.catalog.kind!=="online")return privateCatalog;switch(t.currentView)',
    );
    replaceOnce(
      "i=K(()=>{switch(t.currentView)",
      'i=K(()=>{if(t.currentView==="library")return "我的音乐";if(t.catalog.kind!=="online")return "私人音乐库";switch(t.currentView)',
    );
    replaceOnce(
      '(p(),v(re,null,Se(s,m=>n("button",{key:m.id',
      '(p(!0),v(re,null,Se(s.filter(m=>g(a).catalog.kind==="online"||m.id==="search"||m.id==="library"),m=>n("button",{key:m.id,"data-sp-view":m.id',
    );
    // Row, cover and menu playback use the same queue context. Single-click
    // selection stays available in multiselect, and touch retains tap-to-play.
    replaceOnce(
      "disableRowPlay:{type:Boolean,default:!1}",
      "disableRowPlay:{type:Boolean,default:!1},loadPlayContext:{type:Function,default:null}",
    );
    replaceOnce(
      'b=(H,w)=>{if(i.value)d(w);else if(l.disableRowPlay)r("play",H);else{r("play",H);let B=V(l.playContextSongs,H,w);s.playContext(B.list,B.index)}}',
      'b=(H,w)=>{if(i.value)return;if(l.disableRowPlay){r("play",H);return}let filters=Object.entries(h).filter(([,values])=>values.size).map(([field,values])=>[field,new Set(values)]),matches=song=>filters.every(([field,values])=>values.has($(song,field))),list=l.playContextSongs?l.playContextSongs.filter(matches):z.value,index=list.indexOf(H),loader=l.loadPlayContext;if(index<0)index=w;r("play",H);s.playContext(list,index,loader?signal=>loader(signal,matches):undefined)}',
    );
    replaceOnce(
      "onClick:te=>b(T,ae)},[e.showIndex?",
      'tabindex:0,onClick:te=>{if(i.value){if(te.detail<2)d(ae)}else if(te.pointerType==="touch"&&te.detail<2)b(T,ae)},onDblclick:te=>{if(!te.target.closest("button,input,.lxm-cover-container"))b(T,ae)},onKeydown:te=>{if(te.target===te.currentTarget&&te.key==="Enter"){te.preventDefault();i.value?d(ae):b(T,ae)}}},[e.showIndex?',
    );
    replaceOnce(
      'onClick:be(te=>g(s).playSingle(T),["stop"])',
      'onClick:be(te=>{if(te.detail<2)i.value?d(ae):b(T,ae)},["stop"])',
    );
    replaceOnce(
      "g(s).playSingle(Ce.value.song),oe()",
      "b(Ce.value.song,z.value.indexOf(Ce.value.song)),oe()",
    );
    // Snapshot the actual search that produced the rows. Editing the input
    // must not change the query used to load the rest of their queue.
    replaceOnce(
      'actualHotSource:"",hotLoading:',
      'actualHotSource:"",playSearch:null,hotLoading:',
    );
    replaceOnce(
      "if(this.results=x,this.page=1",
      "if(this.playSearch=null,this.results=x,this.page=1",
    );
    replaceOnce(
      "let a=await Oo(this.keyword,this.source,this.dimension,t);",
      'let search={operation:"search",keyword:this.keyword,source_id:this.source,type:this.dimension,page:t},a=await Oo(search.keyword,search.source_id,search.type,t);',
    );
    replaceOnce(
      "this.results=s,this.page=t,this.total=a.total",
      "this.playSearch=search,this.results=s,this.page=t,this.total=a.total",
    );
    replaceOnce(
      "songs:g(t).results,activeSongId:",
      "songs:g(t).results,loadPlayContext:g(t).playSearch&&(g(t).page>1||g(t).hasMore)?globalThis.SpeakerLX.onlineTrackLoader(g(t).playSearch):null,activeSongId:",
    );
    replaceOnce(
      '"returnedCount","showPagination"])]))',
      '"returnedCount","showPagination","loadPlayContext"])]))',
    );
    replaceOnce(
      "playContextSongs:g(t).songs,onAction:c",
      'playContextSongs:g(t).songs,loadPlayContext:(g(t).hasMore||g(t).totalCount>g(t).songs.length)?globalThis.SpeakerLX.onlineTrackLoader({operation:"leaderboard/list",source_id:g(t).activeSource,board_id:g(t).activeBoardId}):null,onAction:c',
    );
    replaceOnce(
      '"pageSize","playContextSongs"]),g(t).hasMore',
      '"pageSize","playContextSongs","loadPlayContext"]),g(t).hasMore',
    );
    replaceOnce(
      "playContextSongs:i.value,batchImportLabel:",
      'playContextSongs:i.value,loadPlayContext:(Q.value||o.value>i.value.length)?globalThis.SpeakerLX.onlineTrackLoader({operation:"songlist/detail",source_id:l.source,id:l.songlist.id}):null,batchImportLabel:',
    );
    replaceOnce(
      '"currentPage","playContextSongs"]),Q.value',
      '"currentPage","playContextSongs","loadPlayContext"]),Q.value',
    );
    replaceOnce("r.playAll(t.songs.slice(0,1e3))", "r.playAll(t.songs)");
    replaceOnce("M.playAll(i.value.slice(0,1e3))", "M.playAll(i.value)");
    // Filtering changes the number of children when catalog settings load.
    // The compiler's original STABLE_FRAGMENT assumes an invariant child list;
    // use a keyed fragment without block tracking, as Vue compiles dynamic v-for.
    replaceOnce("],10,Xd)),64))])", "],10,Xd)),128))])");
    replaceOnce(
      "function Ot(e){return e?",
      "function Ot(e){if(e?.library)return globalThis.SpeakerLX.songKey(e);return e?",
    );
    replaceOnce(
      't=>e[t]||(t?t.toUpperCase():"")',
      't=>globalThis.SpeakerLX.sourceName(t)||e[t]||(t?t.toUpperCase():"")',
    );
    replaceOnce(
      'playlistId:i.value==="__new__"?0:Number(i.value||0)',
      'playlistId:i.value==="__new__"?0:i.value||0',
    );
    // Official LX catalog modules perform song keyword searches. Avoid offering
    // artist/album directory tabs that would silently fall back to song search.
    const unsupportedDimensions =
      ',{id:"singer",name:"\\u6B4C\\u624B"},{id:"album",name:"\\u4E13\\u8F91"}';
    if (!js.includes(unsupportedDimensions))
      throw new Error("Search dimension anchor changed");
    js = js.replace(unsupportedDimensions, "");
    js = js.replace(
      'class:"player-collapsed",onClick:$e',
      'class:"player-collapsed",role:"button",tabindex:0,"aria-label":"展开播放器",onKeydown:e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$e()}},onClick:$e',
    );
    js = js.replaceAll(
      "\\u5355\\u66F2\\u64AD\\u653E",
      "\\u987A\\u5E8F\\u64AD\\u653E",
    );
    // Replace host-only file scanning with the platform library in this player.
    replaceOnce(
      '{id:"local",name:"\\u672C\\u5730\\u97F3\\u4E50",icon:"navLocalMusic"},',
      '{id:"library",name:"我的音乐",icon:"navLocalMusic"},',
    );
    content =
      "// LXMusic 3.8.0 player, adapted transport and remote player actions. See /lx/NOTICE.md.\n" +
      js;
  }
  await writeFile(dest, content);
  assets.push({
    path: name,
    upstreamSha256: hash(data),
    adaptedSha256: hash(content),
  });
}
await mkdir("vendor", { recursive: true });
await writeFile(
  "vendor/lx-lock.json",
  JSON.stringify(
    {
      desktop: {
        repository: "lyswhut/lx-music-desktop",
        commit: "323e4bac505da428adae8db6b58039fb2b36b86d",
        files: [...copied].map(([p, sha256]) => ({
          path: relative(resolve(official), p),
          sha256,
        })),
      },
      player: {
        repository: "fly818/lxmusic-plugin-release",
        version: "3.8.0",
        manifest: JSON.parse(
          await readFile(resolve(plugin, "plugin.json"), "utf8"),
        ),
        assets,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ modules: copied.size, assets: assets.length }));
