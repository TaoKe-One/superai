# Deployment configuration

[简体中文](deployment.md) · [User guide](index.en.md)

## Docker

The Docker Hub image includes FFmpeg and supports Linux `amd64` and `arm64`. Docker selects the matching architecture automatically. ARM devices need a 64-bit operating system.

```bash
docker run -d --name superai --restart unless-stopped \
  -p 8787:8787 -v superai-data:/data \
  taokeone/superai:0.1.2
```

Settings, playlists, and the key live in the `superai-data` volume. Both registries provide versioned tags and `latest`. [Docker Hub](https://hub.docker.com/r/taokeone/superai) · [GitHub Container Registry](https://github.com/TaoKe-One/superai/pkgs/container/superai)

`-p 8787:8787` publishes the port on all host interfaces. For LAN access, open `http://<host-LAN-IP>:8787` from another device. For host-only access, use `-p 127.0.0.1:8787:8787`. To change the binding for an existing container, recreate it with its original data volume. [LAN access](#lan-access)

You can also pull from GitHub or use the same reference in the run command above.

```bash
docker pull ghcr.io/taoke-one/superai:0.1.2
```

## Docker Compose

Create `compose.yaml` in your deployment directory with the following contents.

```yaml
services:
  superai:
    image: taokeone/superai:0.1.2
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
PUBLISH_HOST=0.0.0.0 SUPERAI_IMAGE=taokeone/superai:0.1.2 docker compose up -d --no-build --pull always
```

You can save `SUPERAI_IMAGE` in `.env`. To upgrade, change its version tag and run `docker compose up -d --no-build --pull always`. For a local source build, remove `SUPERAI_IMAGE` and run `docker compose up -d --build`.

## Node.js command line

Download **Source code** for your chosen version from GitHub Releases, or clone the repository. Run the commands below in the project root. Install Node.js 22.6+ (a supported Node.js LTS version is recommended) and npm. For WebDAV audio that requires transcoding, install FFmpeg and add it to `PATH`. [Stable releases](https://github.com/TaoKe-One/superai/releases)

```bash
cp .env.example .env
npm ci --omit=dev
npm start
```

Data goes into `data/` by default. Set `DATA_DIR` in `.env` to choose a persistent directory. After updating the source, reinstall dependencies and restart the process.

GitHub-generated source archives include `test/` for development and CI. If you have a separately distributed `*-deploy.zip`, extract it and follow the same steps. Deployment ZIPs and Docker images exclude test files.

## One-click upgrades in Settings

Open **Settings → System Update** to check for stable GitHub releases. With a `docker run` deployment, an optional updater container enables the upgrade button. Start with an official image that includes the updater. The updater downloads the image for your architecture before switching containers and reuses the original ports and data volume. Expect a short restart and sign in again afterward. If the new container fails its health check, the updater restores the previous container and configuration.

One-click upgrades are available starting with v0.1.2. First update v0.1.1 and earlier using their deployment instructions.

Set `SUPERAI_IMAGE` to an official versioned image that includes the updater. When recreating an existing container to enable this feature, reuse its ports, data volume, environment variables, and network settings. This example uses Docker Hub, a fixed port, and the default container name.

```bash
docker volume create superai-updates

docker run -d --name superai --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v superai-data:/data \
  --label io.superai.updates=true -e SUPERAI_UPDATES=true \
  -v superai-updates:/run/superai-updates:ro \
  "$SUPERAI_IMAGE"

docker run -d --name superai-updater --restart unless-stopped --user 0 --no-healthcheck \
  -e SUPERAI_UPDATE_REPOSITORY=docker.io/taokeone/superai \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v superai-updates:/run/superai-updates \
  "$SUPERAI_IMAGE" node --experimental-strip-types src/update/worker.ts
```

For a GHCR deployment, set `SUPERAI_UPDATE_REPOSITORY` to `ghcr.io/taoke-one/superai`. To use a different app container name, set `SUPERAI_UPDATE_CONTAINER` in the updater. The updater requires Docker management access and is the only container that mounts the Docker socket. It exposes no network ports. One-click upgrades require fixed host ports and a writable named volume mounted at `/data`.

Docker Compose deployments upgrade through the Compose procedure above. For Node.js deployments, update the source and restart the process. Both deployment types can check release availability in Settings.

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
  taokeone/superai:0.1.2
```

For the repository Compose file, set `PUBLISH_HOST` to `0.0.0.0` or the host's LAN IP in the existing project's `.env`, then run `docker compose up -d`. With the standalone Compose example in the README, edit `ports` directly. For Node.js, set `HOST` and restart the process.

Open `http://192.168.1.10:8787` on another device on the same LAN. If the connection times out, check that the host allows inbound TCP `8787` from the LAN. To cast private-library tracks, enter the same speaker-reachable address under Music Services in settings.

Append `/healthz` to the address you use to check that the service is running. For an HTTPS reverse proxy, set `COOKIE_SECURE=true`. Enable `TRUST_PROXY=true` only if a trusted proxy overwrites `X-Forwarded-For` and clients can reach the app only through that proxy.

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
