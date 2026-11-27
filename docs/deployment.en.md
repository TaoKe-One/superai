# Deployment configuration

[简体中文](deployment.md) · [User guide](index.en.md)

## Docker

The Docker Hub image includes FFmpeg and supports Linux `amd64` and `arm64`. Docker selects the matching architecture automatically. ARM devices need a 64-bit operating system.

```bash
docker run -d --name superai --restart unless-stopped \
  -p 8787:8787 -v superai-data:/data \
  taokeone/superai:0.1.8
```

Settings, playlists, and the key live in the `superai-data` volume. Both registries provide versioned tags and `latest`. [Docker Hub](https://hub.docker.com/r/taokeone/superai) · [GitHub Container Registry](https://github.com/TaoKe-One/superai/pkgs/container/superai)

`-p 8787:8787` publishes the port on all host interfaces. For LAN access, open `http://<host-LAN-IP>:8787` from another device. For host-only access, use `-p 127.0.0.1:8787:8787`. To change the binding for an existing container, recreate it with its original data volume. [LAN access](#lan-access)

You can also pull from GitHub or use the same reference in the run command above.

```bash
docker pull ghcr.io/taoke-one/superai:0.1.8
```

## Docker Compose

Create `compose.yaml` in your deployment directory with the following contents.

```yaml
services:
  superai:
    image: taokeone/superai:0.1.8
    restart: unless-stopped
    ports:
      - "8787:8787"
    volumes:
      - speaker-data:/data

volumes:
  speaker-data:
```

Run this in the same directory.

```bash
docker compose up -d
```

To use the Compose file included in the repository, run this in the project root. Existing installations should keep the same Compose project and data volume.

```bash
PUBLISH_HOST=0.0.0.0 SUPERAI_IMAGE=taokeone/superai:0.1.8 docker compose up -d --no-build --pull always
```

You can save `SUPERAI_IMAGE` in `.env`. To upgrade, change its version tag and run `docker compose up -d --no-build --pull always`. For a local source build, remove `SUPERAI_IMAGE` and run `docker compose up -d --build`.

## Node.js command line

Download **Source code** for your chosen version from GitHub Releases, or clone the repository. Run the commands below in the project root. Install Node.js 22.6+ (a supported Node.js LTS version is recommended) and npm. Install `unzip` for in-app updates. For WebDAV audio that requires transcoding, install FFmpeg and add it to `PATH`. [Stable releases](https://github.com/TaoKe-One/superai/releases)

```bash
cp .env.example .env
npm ci --omit=dev
npm start
```

Data goes into `data/` by default. Set `DATA_DIR` in `.env` to choose a persistent directory. In-app releases are stored in the data directory and remain active after a restart.

GitHub-generated source archives include `test/` for development and CI. If you have a separately distributed `*-deploy.zip`, extract it and follow the same steps. Deployment ZIPs and Docker images exclude test files.

## DNS for online music

Docker, Compose, and command-line installations default to `LX_DNS_OVER_HTTPS=auto`. LX requests try the host's system DNS first. SuperAI sends the queried hostname to Cloudflare's DNS over HTTPS service only when every system DNS answer is a proxy Fake-IP address (`198.18.0.0/15`).

| Setting          | Behavior                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Use validated system DNS addresses first. Try encrypted DNS when system DNS returns only Fake-IP addresses.                     |
| `true`           | Preserve the preference for encrypted DNS in existing installations and fall back to validated system DNS addresses on failure. |
| `false`          | Use system DNS only.                                                                                                            |

Encrypted DNS requests have a 1.5-second deadline. A timeout pauses new encrypted DNS requests for 30 seconds. Each connection and redirect validates the destination. Connections require public addresses and reject private or mixed answers. Existing containers can keep their `true` or `false` setting when upgrading.

## One-click upgrades in Settings

Deploy an image or source version that includes the built-in updater. The updater starts automatically with `docker run`, `docker compose up -d`, or `npm start`. For the initial migration from v0.1.2 or earlier, install the new image or source and reuse the original data volume or `DATA_DIR`. If migrating an installation configured with `SUPERAI_UPDATES=true` and a separate updater container, remove that setting and stop the old updater. Existing installations can also keep using the separate updater.

1. Sign in, open **Settings → System Update**, and check for updates.
2. Select **Upgrade Now** when an update is available. SuperAI downloads the deployment ZIP from GitHub Releases, verifies its SHA-256 digest, and installs the runtime dependencies.
3. SuperAI backs up state and restarts briefly. If the new version fails to start, it restores the previous program and state. Sign in again after the switch.

Docker stores the new app under the mounted `/data` volume. Node.js stores it under `DATA_DIR`. System Update shows the active app version. Pull a new Docker image to upgrade the base image, Node.js, or FFmpeg. The deployment host needs access to GitHub Releases and the npm registry. Node.js installations require `unzip`. Set `SUPERAI_UPDATES=false` and restart to disable in-app installation.

## Bind address and port

The Docker and Docker Compose quick-start examples in the README publish the port on all host interfaces. The repository Compose file binds to `127.0.0.1` when `PUBLISH_HOST` is unset. For Node.js deployments, set the listen address with `HOST` in `.env`.

| Setting      | `docker run`                             | Docker Compose                           | Node.js command line             |
| ------------ | ---------------------------------------- | ---------------------------------------- | -------------------------------- |
| Bind address | Host IP in `-p`, example `127.0.0.1`     | Set `PUBLISH_HOST` in `.env`             | Set `HOST`                       |
| Port         | Host port in `-p`, example `8787`        | `PUBLISH_PORT`, defaults to `8787`       | `PORT`, defaults to `8787`       |
| Data         | `superai-data` volume mounted at `/data` | `speaker-data` volume mounted at `/data` | `DATA_DIR`, defaults to `./data` |

## LAN access

An existing container deployed with `-p 127.0.0.1:8787:8787` accepts connections from the deployment host. Docker sets port mappings when it creates a container. The commands below keep the old container under another name and mount the existing `superai-data` volume. Replace `192.168.1.10` with the deployment host's LAN IP, or use `-p 8787:8787` to publish on all interfaces.

```bash
docker stop superai && docker rename superai superai-local && \
docker run -d --name superai --restart unless-stopped \
  -p 192.168.1.10:8787:8787 -v superai-data:/data \
  taokeone/superai:0.1.8
```

For the repository Compose file, set `PUBLISH_HOST` to `0.0.0.0` or the host's LAN IP in the existing project's `.env`, then run `docker compose up -d`. With the standalone Compose example in the README, edit `ports` directly. For Node.js, set `HOST` and restart the process.

Open `http://192.168.1.10:8787` on another device on the same LAN. If the connection times out, check that the host allows inbound TCP `8787` from the LAN. To cast private-library tracks, enter the same speaker-reachable address under Music Services in settings.

Append `/healthz` to the address you use to check that the service is running. For an HTTPS reverse proxy, set `COOKIE_SECURE=true`. Enable `TRUST_PROXY=true` only if a trusted proxy overwrites `X-Forwarded-For` and clients can reach the app only through that proxy.

## Persistence and backups

Back up the whole volume or `DATA_DIR`, including `state.json` and the generated `master.key`. If you set your own `MASTER_KEY`, back it up and keep the same value when migrating. Each running instance needs a separate data directory. Use `docker compose down` to stop Docker Compose. Adding `-v` removes the data volume.

When upgrading an existing Docker deployment, keep its Compose project name and `.env`. Set `COMPOSE_PROJECT_NAME` to the existing name in `.env` and run `docker compose up -d --build --remove-orphans` so the renamed `superai` service reuses the project's `speaker-data` volume.

## Cast accepted but no audio

Play the same track in the browser first. If the speaker accepts playback and stays paused at 0 seconds, such as the Xiaomi Speaker Play (L05C) with some QQ Music links, enable the song URL relay. The relay gives the speaker a temporary URL without query parameters and returns an HTTP 302 to the original audio URL with its signature intact. Each ticket expires after 30 minutes or when the app restarts. The relay port serves song tickets only.

Port `8788` is not published by default and has no effect on browser-only deployments. Add the mapping only when the relay is enabled. Replace the sample address below with the Docker host's LAN IP that the speaker can reach. Keep the relay off public interfaces and router port forwarding. `SPEAKER_RELAY_BASE_URL` must use that LAN address. Do not use `127.0.0.1`, `localhost`, or the container address.

### Docker run

For a new container, add the relay environment variables and the LAN-only port mapping when you create it. The example publishes the admin UI on loopback. Replace `192.168.1.10` with the deployment host's LAN IP and confirm that the speaker can reach it.

```bash
docker run -d --name superai --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v superai-data:/data \
  -p 192.168.1.10:8788:8788 \
  -e SPEAKER_RELAY_HOST=0.0.0.0 -e SPEAKER_RELAY_PORT=8788 \
  -e SPEAKER_RELAY_BASE_URL=http://192.168.1.10:8788 \
  taokeone/superai:0.1.8
```

For an existing container, pull the image and back up the original volume and container settings. Stop the container and rename it, for example to `superai-before-relay`. Create the replacement with the original `/data` mount, original admin port binding and environment variables, plus the relay options above. Preserve `MASTER_KEY` if you set it yourself. Docker assigns published ports at container creation, so adding the relay mapping requires recreating the container. If your relay already works, you can update SuperAI from Settings and keep the existing port mapping. [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

### Docker Compose

For a new Compose deployment, add the following environment variables and port mapping to the standard example. For an existing deployment, put them in `compose.override.yaml`, keep the same Compose project name, and run `docker compose up -d` to recreate the service with the existing volume. For an image-based service, update its image tag and pull it before starting.

```yaml
services:
  superai:
    environment:
      SPEAKER_RELAY_HOST: 0.0.0.0
      SPEAKER_RELAY_PORT: "8788"
      SPEAKER_RELAY_BASE_URL: "http://192.168.1.10:8788"
    ports:
      - "8787:8787"
      - "192.168.1.10:8788:8788"
```

### Command line

Add the settings below to `.env`, then restart. A native Node.js process can listen directly on the deployment host's LAN IP. If you use `0.0.0.0`, restrict `8788` to the LAN with the host firewall.

```dotenv
SPEAKER_RELAY_HOST=192.168.1.10
SPEAKER_RELAY_PORT=8788
SPEAKER_RELAY_BASE_URL=http://192.168.1.10:8788
```

## Forgotten administrator password

While the updated platform is running, execute in the container terminal:

```bash
npm run reset-admin-password
```

Or on the host (replace the container name):

```bash
docker exec -u node -w /app superai npm run reset-admin-password
```

The command displays a random new password and immediately invalidates the old password and existing sessions, without restarting or removing other settings. Keep the output private. Older images need an update containing this command. For command-line deployments, use the same command, system user, working directory, `.env` and `DATA_DIR` as the platform. The management channel uses a local Unix socket in the data directory, without a network endpoint.

[Other frequently asked questions](faq.en.md)
