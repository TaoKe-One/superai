# Frequently asked questions

[简体中文](faq.md) · [User guide](index.en.md)

## Other devices on my LAN cannot open the page

Run `curl http://127.0.0.1:8787/healthz` on the deployment host. If that works, try the same path from another device with the host's LAN IP. If it times out, check whether Docker binds to `127.0.0.1`, whether you use the published host port, and whether the firewall allows it. Recreate the container with the original data volume when changing the binding. [LAN configuration](deployment.en.md#lan-access)

## Search or charts show tracks, but playback fails

In **Player → Music Sources**, check that the source is enabled, supports the target platform, and passes its availability check. Retry the same track and source. If charts are empty, switch catalog platforms and check connectivity to the catalog API. For private libraries, check the service URL, credentials, and WebDAV scan status. [Music source settings](usage.en.md#connect-music-libraries-and-sources)

Starting with v0.1.6, SuperAI handles common DNS changes automatically. After turning off a proxy, online music remains reachable if the host's system DNS returns public addresses. If the log reports Fake-IP and says it could not obtain a usable public address, check that the host can resolve public addresses through system DNS or reach the encrypted resolver. [DNS for online music](deployment.en.md#dns-for-online-music)

## A track plays in the browser but the speaker stays silent

Confirm the target speaker is online under **Speaker Devices**. For private library casts, set a platform URL reachable from the speaker using the host's LAN address and published port. If the cast is accepted and playback progress stays at zero, check whether the speaker can reach the audio URL. If some QQ Music links repeatedly leave a Xiaomi Speaker Play (L05C) at zero, try the song URL relay. Adding its Docker port mapping requires recreating the container with the original data volume. [Audio relay setup](deployment.en.md#cast-accepted-but-no-audio)

## No speakers appear after QR sign-in

Confirm the phone and SuperAI use the same Xiaomi account, then refresh the device list under **Speaker Devices**. To collect further diagnostics, temporarily set `MIOT_LOGIN_DIAGNOSTICS=true` and turn it off after reproducing the issue.

## XiaoAi still responds on its own or skips the AI reply

Check the event history in **Speaker Devices → Voice Diagnostics**. If no event appears, check voice monitoring, the Xiaomi account, and the speaker model. For an event that was received, inspect intent, model generation, and the speech result. XiaoAi handles appliance and infrared commands. Its native reply may play first because SuperAI reads the conversation from Xiaomi's cloud.

## The model test or an AI reply returns HTTP 400

In **Settings → AI Models**, check the provider, API URL, a model available to your account, and the key. Use the provider's base URL and retest before saving. For intermittent failures after a successful test, record the time, model, version, and redacted error. Check the network route from the deployment host to the provider. A short question in the web AI Assistant is a quick way to check the model path.

## Does SuperAI download music to disk?

Online sources resolve the stream URL. Private library audio is proxied or transcoded on demand. The state file stores settings, queues, favorites, history, and playlists. WebDAV scanning saves a library index. Ordinary media buffering is managed by the browser. [Data directory and backups](deployment.en.md#persistence-and-backups)

## WebDAV audio transcoding fails

The Docker image includes FFmpeg. In a command-line deployment, run `ffmpeg -version` to check availability, or point `FFMPEG_PATH` to the executable.

## I forgot my password or saw the setup page after recreating a container

Use the password recovery command inside a v0.1.1 or newer container if you forgot the password. If setup reappears after recreation, check that `/data` mounts the original volume. Compose uses its project name to name the volume. After moving directories, reuse the project name or specify the existing volume. Preserve `state.json` and the original key configuration during a migration. [Password recovery](deployment.en.md#forgotten-administrator-password) · [Persistence and backups](deployment.en.md#persistence-and-backups)

## Where is the Upgrade Now button?

Select **Check for Updates**. **Upgrade Now** appears when a newer stable release is available. If System Update reports that the updater is disabled, check that you have a version that includes the built-in updater, use the default image command or `npm start`, and review `SUPERAI_UPDATES`. Existing installations with a separate updater container can keep using `SUPERAI_UPDATES=true`. [One-click upgrades](deployment.en.md#one-click-upgrades-in-settings)

When reporting a problem, include the deployment method, version, reproduction steps, and redacted logs. Include the speaker model and firmware for device issues. [Report an issue on GitHub](https://github.com/TaoKe-One/superai/issues)
