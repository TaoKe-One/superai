# 超级爱（superai）

[English](README.en.md) · [部署配置](docs/deployment.md) · [Apache-2.0](LICENSE)

自托管网页播放器和小爱音箱助手。用浏览器播放音乐、投放到音箱，或直接对小爱说出点歌和问答请求。平台独立运行，部署时只需要 Docker 或 Node.js。

## 功能

- **播放器**支持网页版和音箱投放，提供播放队列、歌词、收藏、播放历史、歌单和四种播放模式。
- **音乐库**支持 Navidrome / Subsonic、飞牛音乐、WebDAV，也可导入自备的 LX 音源。在线目录支持歌曲、歌单和排行榜。
- **小爱联动**支持米家扫码、设备发现、多台音箱独立监听、点歌和播放控制。开启监听后，平台从小米云端读取对话，由 AI 理解意图并执行。
- **AI 问答**支持 MiniMax 和 OpenAI 兼容服务。回答和澄清可由提问的音箱播报，后续补充沿用该音箱的对话上下文。

## 部署

两种部署方式任选一种，默认在本机通过 [http://localhost:8787](http://localhost:8787) 访问。

### 方式一：Docker 镜像

Docker Hub 镜像内置 FFmpeg，包含 Linux `amd64` 和 `arm64` 两个版本。Docker 会根据系统架构自动选择。ARM 设备需要运行 64 位系统。

```bash
docker run -d --name superai --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v superai-data:/data \
  taokeone/superai:0.1.0
```

配置、歌单和密钥保存在 `superai-data` 数据卷。镜像提供版本标签和 `latest`。[镜像页面](https://hub.docker.com/r/taokeone/superai)

也可以克隆项目后从源码构建，或在现有 Compose 项目中直接拉取镜像。详见[部署配置](docs/deployment.md)。

### 方式二：命令行

下载或克隆项目，在项目根目录执行下面的命令。安装 Node.js 22.6+（建议使用受支持的 Node.js LTS 版本）和 npm。使用需要转码的 WebDAV 音频时，还需要安装 FFmpeg 并将其加入 `PATH`。

```bash
cp .env.example .env
npm ci --omit=dev
npm start
```

默认写入项目下的 `data/`。首次部署或更换机器时，可在 `.env` 中通过 `DATA_DIR` 指定持久化目录。更新后重新安装依赖并重启进程。

需要局域网访问、反向代理或签名音频地址转跳时，见[部署配置](docs/deployment.md)。

## 第一次使用

1. 打开管理页面，创建至少 12 个字符的管理员密码。
2. 打开「平台设置 → 音乐服务」，接入已有私人曲库，或者在播放器的「音乐源管理」导入你有权使用的 LX 音源脚本。在线目录与可播放音源分别配置。
3. 到「音箱设备」扫描小米登录二维码，选择音箱。浏览器播放可跳过这一步。投放私人曲库时，在音乐服务中填写音箱能访问的平台局域网地址。
4. 如需语音助手，先到「平台设置 → AI 模型」测试并保存模型，再到「音箱设备 → 语音接管与诊断」开启监听。可以对音箱说「播放周杰伦的晴天」或「帮我解释一下潮汐是怎么形成的」。

## 音箱兼容性

平台根据硬件型号选择[音乐投放接口](src/miot/playback.ts)和[米家播报动作](src/miot/tts-commands.json)。小爱音箱 Play（L05C，固件 1.68.2）已有音乐播放和米家播报的真机记录。其他型号可按实际固件分别验证投放、语音记录和播报。

语音联动默认关闭。开启后，音箱可能先执行小爱的原生响应。家电和红外指令仍由小爱处理。音乐来自你配置的音乐库或音源。

## 开发

```bash
npm ci
npm test
npm run dev
```

服务端代码在 `src/`，网页在 `public/`，测试在 `test/`。播放器资源的来源、哈希和重新导入方式见[第三方来源说明](vendor/NOTICE.md)及[资源清单](vendor/lx-lock.json)。

提交问题时请附上部署方式、音箱型号和固件版本、复现步骤及脱敏后的错误信息。

## 许可证

项目代码采用 [Apache-2.0](LICENSE)。随项目分发的第三方组件保留各自的许可和归属说明。[第三方来源说明](vendor/NOTICE.md)

## 致谢

感谢这些项目及其贡献者提供的实现和经验：

- **Songloft MIoT 插件**提供小爱设备发现、播放控制和多型号米家播报的参考。[songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot)
- **Songloft 小爱语音助手**提供自然语言指令、AI 问答和音箱语音回复的参考。[birdstudy-nj/songloft-miot-helper](https://github.com/birdstudy-nj/songloft-miot-helper)
- **洛雪音乐桌面版**提供在线目录、歌单、排行榜和歌词模块。[lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)
- **洛雪音源 Songloft 插件**提供本项目所适配的播放器前端资源。感谢 fly818 与 LX Team。[fly818/lxmusic-plugin-release 3.8.0](https://github.com/fly818/lxmusic-plugin-release/releases/tag/3.8.0)
