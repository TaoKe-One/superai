# SuperAI user guide

[简体中文](index.md)

SuperAI brings a web player, private music libraries, and Xiaomi speakers together in one self-hosted service. Listen in the browser, or connect a speaker for casting, voice requests, and AI answers.

## From installation to first playback

1. Start SuperAI with Docker, Docker Compose, or Node.js. Open `http://localhost:8787` on the deployment host and set an administrator password. [Deployment steps](deployment.en.md)
2. Choose a music source. Connect an existing Navidrome, Subsonic, fnOS Music, or WebDAV library, or import a compatible LX source for the online catalog. [Libraries and sources](usage.en.md#connect-music-libraries-and-sources)
3. Search for a song and double-click it to try browser playback. To cast, sign in to Xiaomi under Speaker Devices and select a speaker. [Playback and casting](usage.en.md#playback-and-casting)
4. For voice requests and AI answers, test and save a model in Settings, then enable voice monitoring under Speaker Devices. [AI and voice](usage.en.md#ai-models-and-voice-integration)

## Browse by topic

| Guide                          | Topics                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| [Deployment](deployment.en.md) | Docker and Compose commands, LAN access, updates, and backups             |
| [Feature guide](usage.en.md)   | Queues, My Music, online sources, private libraries, speakers, and voice  |
| [FAQ](faq.en.md)               | Connection and playback errors, AI failures, passwords, and data recovery |

The guide covers installation, upgrades, and features in public releases. Check the release notes before choosing an image. [GitHub Releases](https://github.com/TaoKe-One/superai/releases)
