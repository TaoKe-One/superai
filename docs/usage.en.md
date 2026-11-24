# Feature guide

[简体中文](usage.md) · [User guide](index.en.md)

## Connect music libraries and sources

Choose a source mode in **Settings → Music Services** and save. The mode applies to browser playback, voice requests, playlists, and replaying favorites.

| Source mode                          | When to use it                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| LX online only                       | Browse online search, charts, and playlists, and use enabled LX sources for playback URLs |
| Private libraries only               | Play connected private libraries with LX search and resolution turned off                 |
| Private libraries first, LX fallback | Search private libraries first and supplement results through LX                          |
| LX and advanced compatibility APIs   | Keep existing HTTP JSON or topone source integrations                                     |

### Add a private library

1. Open **Settings → Music Services** and choose **Add Private Library**.
2. Select the service type and enter an address reachable from the deployment host. Supply the required credentials or access code. Navidrome uses its Subsonic-compatible API. For fnOS Music, enter the full direct URL.
3. Save. Subsonic, Navidrome, and fnOS read the catalog directly. WebDAV scans the files after saving and exposes folders as browsable playlists.
4. To cast from a private library, fill in the platform URL the speaker can reach, such as `http://192.168.1.20:8787`. For Docker, use the host LAN address and published port.

Search your private library by song or artist in the player. The screenshots use sample data. Select any screenshot to open it at full size.

[![The player's private library showing the library selector, search, pagination, and track list](previews/player.png)](previews/player.png)

### Import an LX source

Open **Player → Music Sources**, import a compatible LX script you have permission to use from a file or URL (up to 2 MiB per script), enable it, and run the availability check. Search, charts, and playlists provide catalog entries. Playback sources resolve the stream URLs. The check validates sample tracks. If a QQ Music track fails, confirm the source is enabled and supports QQ Music, then test the requested track.

For a voice request for a specific song, SuperAI searches the online platforms supported by enabled LX sources in parallel and matches the title and artist. It checks matching recordings from NetEase Cloud Music, QQ Music, Kugou, and Kuwo in parallel, starting with one source per platform and running up to four checks at a time. It tries Migu once the other platforms have failed. Within each platform, cooldown, priority, and recent availability determine source order. SuperAI casts the first version to pass the audio check, saves it in the queue, and cancels the other checks. Say “用 QQ 音乐播放周杰伦的晴天” to compare sources within QQ Music only.

When you ask to hear an artist’s music or popular songs, SuperAI queues up to 20 distinct tracks by that artist by default.

## Playback and casting

Use a voice command to switch between sequential play, queue repeat, track repeat, and shuffle. Browser and speaker playback share the current mode. A mode change applies when the current queue advances.

- Double-click a track row in search, charts, a private library, recent plays, or a playlist to start the current list at that track. The player mode controls what plays next.
- Open **Player → My Music** for favorites, recent plays, and saved playlists. Select tracks in search or charts and import them to a playlist.
- Under **Speaker Devices**, scan the Xiaomi sign-in QR code, refresh devices, and select a speaker. Try casting a track that already plays in the browser.
- Disconnect the speaker in the player to continue playback in the browser. Reconnecting attempts to cast the current track. After a successful new voice request, the browser follows the target speaker's queue.

[![Speaker Devices showing the selected speaker, voice diagnostics, and playback queue](previews/devices.png)](previews/devices.png)

## AI models and voice integration

1. Open **Settings → AI Models**, choose MiniMax or another compatible provider, and enter the API base URL, model name, and key. Use the versioned base URL, such as one ending in `/v1`.
2. Test the model, then save. Model discovery depends on the provider. You can enter the model name manually.
3. Ask a question in **AI Assistant** to verify a text reply. Configure provider search or external search under **Settings → Web Search** for questions that need current information.
4. Enable monitoring under **Speaker Devices → Voice Diagnostics**. Use command preview to inspect how a request is interpreted. Then ask the speaker to play a few songs by an artist or answer a question.

SuperAI reads Xiaomi cloud conversation records, identifies intent, and handles music requests, playback controls, and questions. Supported speakers read answers aloud. After a clarifying question, supported speakers wake again. Speak after the prompt tone. Each question opens a 60-second reply window, and SuperAI keeps the context on that speaker until the request completes or the window expires. If the speaker does not wake on its own, say “小爱同学” and continue. XiaoAi handles appliances, infrared controls, scenes, and reminders. Its native reply may play before SuperAI responds.

[![The web AI Assistant showing a user question and the AI's reply](previews/assistant.png)](previews/assistant.png)

### Local weather and speaker status

Enter a city or district under **Speaker Devices → Speaker Location**. Web questions use the selected speaker's location. Voice questions use the location of the speaker that received the request. Both fall back to the default location. Ask “What's the weather like today?” or name a place explicitly, as in “Will it rain in Beijing tomorrow?”

Ask “Where is this speaker?” to hear its configured location. For questions about volume or what's playing, SuperAI reads the current status from the speaker. Update the location after moving the device.

## Passwords and updates

Starting with v0.1.2, **Settings → Change Administrator Password** verifies the current password and accepts a new password of at least five characters. Changing the password signs out all administrator sessions. On versions with the built-in updater, Docker, Docker Compose, and command-line deployments can check and install stable releases under **Settings → System Update**. Sign in again after updating. [Password recovery](deployment.en.md#forgotten-administrator-password) · [One-click upgrades](deployment.en.md#one-click-upgrades-in-settings)

## Download runtime logs

Administrators can download `superai-runtime.log` under **Settings → Runtime Logs**. The latest 500 records persist in `runtime.log` in the data directory. Each entry includes a UTC timestamp, level, and event type.

- The platform and player record clicks, double-clicks, changes, and form submissions with the page and control. Related API requests can share the same action ID and include their status, duration, and error details.
- Speaker and web assistant logs include the user’s words, resolved intent, execution stages, reply, and outcome. Playback logs include the track, queue position, mode, and source checks. Speaker utterances come from Xiaomi’s cloud transcripts.
- The log redacts recognized credentials and URL paths. Review conversation text for personal information before sharing an export.
