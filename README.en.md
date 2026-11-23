# 超级爱 (superai)

[简体中文](README.md) · [Deployment configuration](docs/deployment.en.md) · [Apache-2.0](LICENSE)

A self-hosted web player and voice assistant for Xiaomi speakers. Play music in your browser, cast it to a speaker, or ask XiaoAi to play music and answer questions. The platform runs on Docker or Node.js.

## Features

- **Web and speaker playback** with queues, lyrics, favorites, history, playlists, and four playback modes.
- **Music libraries** from Navidrome / Subsonic, fnOS Music, and WebDAV. You can also import your own LX source for songs, playlists, and charts.
- **XiaoAi integration** with Xiaomi QR sign-in, device discovery, per-speaker conversation monitoring, music requests, and playback controls. When enabled, the platform reads Xiaomi cloud conversation records and uses AI to interpret requests.
- **AI answers** using MiniMax or an OpenAI-compatible service. The originating speaker can read answers and clarification questions aloud and keep context for follow-up replies.

## Deploy

Choose one deployment method. Both default to [http://localhost:8787](http://localhost:8787).

### Option 1 — Docker image

The image supports Linux `amd64` and `arm64` and includes FFmpeg. Start it with Docker.

```bash
docker run -d --name superai --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v superai-data:/data \
  ghcr.io/taoke-one/superai:0.1.0
```

Settings, playlists, and the key live in the `superai-data` volume. The image offers version tags and `latest`. [Container package](https://github.com/TaoKe-One/superai/pkgs/container/superai)

For source builds or pulling the image into an existing Compose project, see the [deployment guide](docs/deployment.en.md).

### Option 2 — Command line

Download or clone the project and run the commands in its root directory. Install Node.js 22.6+ (a supported Node.js LTS version is recommended) and npm. For WebDAV audio that requires transcoding, install FFmpeg and add it to `PATH`.

```bash
cp .env.example .env
npm ci --omit=dev
npm start
```

Data goes into `data/` by default. Set `DATA_DIR` in `.env` to choose a persistent directory. After updating the source, reinstall dependencies and restart the process.

For LAN access, reverse proxies, or signed audio URL redirects, see the [deployment guide](docs/deployment.en.md).

## First run

1. Open the admin page and create a password with at least 12 characters.
2. Connect a private library under Music Services in settings, or import an LX source script you have permission to use in the player's Music Sources panel. The online catalog and playback sources are configured separately.
3. Go to Speaker Devices, scan the Xiaomi sign-in QR code, and select a speaker. Skip this step for browser playback. To cast a private library track, enter a platform LAN address the speaker can reach in Music Services.
4. For voice requests, test and save a model under AI Models in settings, then enable conversation monitoring in Speaker Devices. Try asking XiaoAi to play a song or explain how tides work.

## Speaker compatibility

The platform selects the [music endpoint](src/miot/playback.ts) and [Mi Home speech action](src/miot/tts-commands.json) by hardware model. Music and Mi Home speech were heard on a Xiaomi XiaoAi Speaker Play (L05C, firmware 1.68.2). Verify casting, conversation retrieval, and audible speech separately on other models and firmware versions.

Voice monitoring is off by default. When enabled, XiaoAi may respond natively before the platform handles a request. XiaoAi handles appliances and infrared commands. Music comes from the libraries or sources you configure.

## Develop

```bash
npm ci
npm test
npm run dev
```

Server code is in `src/`, the web interface in `public/`, and tests in `test/`. See the [third-party notices](vendor/NOTICE.md) and [asset manifest](vendor/lx-lock.json) for the player source, hashes, and import steps.

When reporting a problem, include the deployment method, speaker model and firmware, reproduction steps, and redacted errors.

## License

Project code is distributed under [Apache-2.0](LICENSE). Bundled third-party components retain their licenses and attributions. [Third-party notices](vendor/NOTICE.md)

## Acknowledgments

Thank you to the projects and contributors whose work informed this platform.

- **Songloft MIoT plugin** for Xiaomi device discovery, playback control, and model-specific Mi Home speech. [songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot)
- **Songloft XiaoAi voice helper** for natural-language commands, AI questions, and spoken replies. [birdstudy-nj/songloft-miot-helper](https://github.com/birdstudy-nj/songloft-miot-helper)
- **LX Music Desktop** for the online catalog, playlist, chart, and lyrics modules. [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)
- **LX Music for Songloft** for the player assets adapted here. Thanks to fly818 and LX Team. [fly818/lxmusic-plugin-release 3.8.0](https://github.com/fly818/lxmusic-plugin-release/releases/tag/3.8.0)
