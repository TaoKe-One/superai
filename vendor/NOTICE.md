# 第三方组件 / Third-party components

- **LX Music Desktop — Apache-2.0.** The catalog, playlist, chart and lyrics modules in `vendor/lx-music/` are adapted from [commit `323e4ba`](https://github.com/lyswhut/lx-music-desktop/tree/323e4bac505da428adae8db6b58039fb2b36b86d). 洛雪目录和歌词模块已适配 Node.js，并保留上游许可。
- **LX Music for Songloft — Apache-2.0 in the release manifest.** The front-end files under `public/lx/static/` are adapted from [fly818's official 3.8.0 release](https://github.com/fly818/lxmusic-plugin-release/releases/tag/3.8.0), credited to LX Team. The original file hashes and the manifest inside the release archive are recorded in `vendor/lx-lock.json`. The repository-level manifest has an empty license field. This attribution applies to the matching release front-end assets. The backend `main.jsc` is excluded. 前端适配包括播放器接入、曲库与导航、控件和音频源管理。发布包不包含该插件的后端二进制。
- **Songloft MIoT plugin — Apache-2.0.** The music request format and hardware table in `src/miot/playback.ts` are adapted from [commit `bcf891f`](https://github.com/songloft-org/songloft-plugin-miot/tree/bcf891ff346c2295614645594cd72d0c343eb246). The speech action mapping comes from [commit `ee6af76`](https://github.com/songloft-org/songloft-plugin-miot/tree/ee6af768614b5d350c9a2b0918fb76e9ecfe9f8f). 投放报文、播报动作及部分设备兼容逻辑参考上游。
- **Material Symbols Outlined — Apache-2.0.** Google, version 385. The font is served from `public/lx/material-symbols.ttf`. 本地提供字形文件。
- The LX front end embeds **Vue**, **Pinia** and **FileSaver.js** under the MIT license. Their notices follow. 前端内嵌依赖的声明见下文。

The Apache-2.0 text ships with the project as `LICENSE` and with the player as `public/lx/LICENSE`. Optional music-source scripts are provided by administrators under the source authors' terms. 可选音源脚本由使用者自行导入。

## Regenerating the adapted assets / 重新导入前端资源

Check out the pinned LX Music Desktop commit and extract the official LX Music for Songloft release archive. Run the following command from the project root. The importer checks the upstream bundle and stylesheet hashes before patching.

检出固定的洛雪桌面版提交，解压上游插件发布包，然后在项目根目录运行以下命令。脚本会在改写前校验上游的前端文件。

```bash
node scripts/import-lx.mjs /path/to/lx-music-desktop /path/to/lxmusic.jsplugin
```

## VUE-LICENSE

The MIT License (MIT)

Copyright (c) 2018-present, Yuxi (Evan) You and Vue contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## PINIA-LICENSE

The MIT License (MIT)

Copyright (c) 2019-present Eduardo San Martin Morote

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## FILESAVER-LICENSE

The MIT License

Copyright © 2016 [Eli Grey][1].

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

[1]: http://eligrey.com
