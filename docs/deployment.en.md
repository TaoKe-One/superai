# Deployment configuration

[简体中文](deployment.md) · [Project home](../README.en.md)

## Docker Compose

Run this in the project root to pull the image from Docker Hub. For an existing installation, use the same Compose project so the service keeps its `speaker-data` volume.

```bash
SUPERAI_IMAGE=taokeone/superai:0.1.0 docker compose up -d --no-build --pull always
```

You can save `SUPERAI_IMAGE` in `.env`. To upgrade, change its version tag and run `docker compose up -d --no-build --pull always`. For a local source build, remove `SUPERAI_IMAGE` and run `docker compose up -d --build`.

## Bind address and port

Both quick-start methods make the admin page available locally by default. Finish administrator setup before enabling LAN access.

| Setting      | Docker Compose                           | Command line                     |
| ------------ | ---------------------------------------- | -------------------------------- |
| Bind address | Set `PUBLISH_HOST` in `.env`             | Set `HOST`                       |
| Port         | `PUBLISH_PORT`, defaults to `8787`       | `PORT`, defaults to `8787`       |
| Data         | `speaker-data` volume mounted at `/data` | `DATA_DIR`, defaults to `./data` |

To cast tracks from a private library, bind to the server's LAN IP, for example `192.168.1.10`. Restart and enter `http://192.168.1.10:8787` under Music Services in settings, using the actual IP and port. Both the browser and the speaker need to reach the addresses used for their playback.

Run `curl -fsS http://localhost:8787/healthz` to check that the service is running. For an HTTPS reverse proxy, set `COOKIE_SECURE=true`. Enable `TRUST_PROXY=true` only if a trusted proxy overwrites `X-Forwarded-For` and clients can reach the app only through that proxy.

## Persistence and backups

Back up the whole volume or `DATA_DIR`, including `state.json` and the generated `master.key`. If you set your own `MASTER_KEY`, back it up and keep the same value when migrating. Each running instance needs a separate data directory. Use `docker compose down` to stop Docker Compose. Adding `-v` removes the data volume.

When upgrading an existing Docker deployment, keep its Compose project name and `.env`. Set `COMPOSE_PROJECT_NAME` to the existing name in `.env` and run `docker compose up -d --build --remove-orphans` so the renamed `superai` service reuses the project's `speaker-data` volume.

## Cast accepted but no audio

Check that the track plays in the browser and that the speaker can reach the audio URL. For firmware that has trouble with signed query parameters, enable the song URL relay. The relay redirects the speaker to the resolved audio URL without caching the track.

For a **command-line deployment**, add these values to `.env` and restart. Replace the example IP with your server's LAN IP.

```dotenv
SPEAKER_RELAY_HOST=192.168.1.10
SPEAKER_RELAY_PORT=8788
```

For **Docker Compose**, add this `compose.override.yaml` in the project root. Replace the example IP with an address the speaker can reach, then run `docker compose up -d`.

```yaml
services:
  superai:
    environment:
      SPEAKER_RELAY_HOST: 0.0.0.0
      SPEAKER_RELAY_PORT: "8788"
      SPEAKER_RELAY_BASE_URL: "http://192.168.1.10:8788"
    ports:
      - "192.168.1.10:8788:8788"
```

## Troubleshooting

- **No speaker appears after QR sign-in.** Confirm that the phone and platform use the same Xiaomi account, then refresh the devices. Enable `MIOT_LOGIN_DIAGNOSTICS=true` while troubleshooting and turn it off afterward.
- **Search works but music will not play.** Enable a source for the music platform in the player's Music Sources panel and run its availability check. The check probes a sample. Actual playback depends on the source and track.
- **LX reports a Fake-IP DNS error.** If the host can reach Cloudflare DNS over HTTPS, set `LX_DNS_OVER_HTTPS=true` and restart.
- **WebDAV transcoding fails.** The Docker image includes FFmpeg. For command-line deployments, check `ffmpeg -version` or set `FFMPEG_PATH` to the executable.
