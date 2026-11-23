# 部署配置

[English](deployment.en.md) · [使用手册](index.md)

## Docker

Docker Hub 镜像内置 FFmpeg，包含 Linux `amd64` 和 `arm64` 两个版本。Docker 会根据系统架构自动选择。ARM 设备需要运行 64 位系统。

```bash
docker run -d --name superai --restart unless-stopped \
  -p 8787:8787 -v superai-data:/data \
  taokeone/superai:0.1.2
```

配置、歌单和密钥保存在 `superai-data` 数据卷。两处镜像仓库均提供版本标签和 `latest`。[Docker Hub](https://hub.docker.com/r/taokeone/superai) · [GitHub Container Registry](https://github.com/TaoKe-One/superai/pkgs/container/superai)

`-p 8787:8787` 将端口发布到宿主机的所有接口。局域网设备用 `http://<部署机局域网IP>:8787` 访问，只允许本机访问时用 `-p 127.0.0.1:8787:8787`。已有容器需要沿用原数据卷重新创建，才能更改端口绑定。[局域网访问](#局域网访问)

也可以直接拉取 GitHub 镜像，或将上面的镜像名替换为同一地址。

```bash
docker pull ghcr.io/taoke-one/superai:0.1.2
```

## Docker Compose

在部署目录创建 `compose.yaml`，填入以下内容。

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

在同一目录执行。

```bash
docker compose up -d
```

也可在源码目录使用仓库内的 Compose 文件。已有部署请沿用原 Compose 项目与数据卷。

```bash
PUBLISH_HOST=0.0.0.0 SUPERAI_IMAGE=taokeone/superai:0.1.2 docker compose up -d --no-build --pull always
```

可把 `SUPERAI_IMAGE` 保存到 `.env`，需要升级时更换版本标签，再执行 `docker compose up -d --no-build --pull always`。如果要从本地源码构建，移除 `SUPERAI_IMAGE` 后执行 `docker compose up -d --build`。

## Node.js 命令行

从 GitHub Releases 下载所需版本的 **Source code**，或克隆仓库，然后在项目根目录执行下面的命令。安装 Node.js 22.6+（建议使用受支持的 Node.js LTS 版本）和 npm。使用需要转码的 WebDAV 音频时，还需要安装 FFmpeg 并将其加入 `PATH`。[正式版本](https://github.com/TaoKe-One/superai/releases)

```bash
cp .env.example .env
npm ci --omit=dev
npm start
```

默认写入项目下的 `data/`。首次部署或更换机器时，可在 `.env` 中通过 `DATA_DIR` 指定持久化目录。更新后重新安装依赖并重启进程。

GitHub 自动生成的源码包包含供开发和 CI 使用的 `test/` 目录。若拿到单独分发的 `*-deploy.zip`，解压后也可按上面步骤部署。部署 ZIP 和 Docker 镜像均已排除测试文件。

## 后台一键升级

「平台设置 → 系统更新」可以检查 GitHub 正式版本。使用 `docker run` 部署时，可添加一个独立的升级服务，使管理员能在页面点击「立即升级」。初次启用需要使用一个已包含本功能的正式镜像。随后更新时，平台先下载对应架构的镜像，保留原端口和数据卷。切换时应用会短暂重启并要求重新登录。若新容器未通过健康检查，升级服务会恢复原容器和原配置。

一键升级自 v0.1.2 起提供。v0.1.1 及更早版本请先按原部署方式手动更新。

将 `SUPERAI_IMAGE` 设为包含本功能的正式版本镜像。已有部署请在一次性重建时沿用原有的端口、数据卷、环境变量和网络设置。以下示例使用 Docker Hub、固定端口及默认容器名称。

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

从 GHCR 部署时，将升级服务的 `SUPERAI_UPDATE_REPOSITORY` 设为 `ghcr.io/taoke-one/superai`。应用容器名可通过升级服务的 `SUPERAI_UPDATE_CONTAINER` 指定。升级服务需要 Docker 管理权限，只有升级服务挂载 Docker 套接字。升级服务没有对外端口。后台升级使用固定宿主机端口，数据使用可写的命名卷挂载至 `/data`。

Docker Compose 按上面的 Compose 流程升级，命令行部署更新源码后重启。两种部署均可在页面查看新版本。

## 监听地址和端口

README 中的 Docker 和 Docker Compose 快速部署示例将端口发布到宿主机的所有接口。仓库自带的 Compose 配置在未指定 `PUBLISH_HOST` 时绑定 `127.0.0.1`，Node.js 命令行部署可通过 `.env` 的 `HOST` 设置监听地址。

| 设置     | `docker run`                           | Docker Compose                      | Node.js 命令行            |
| -------- | -------------------------------------- | ----------------------------------- | ------------------------- |
| 监听地址 | `-p` 中的宿主机 IP，示例为 `127.0.0.1` | 在 `.env` 中设置 `PUBLISH_HOST`     | 设置 `HOST`               |
| 端口     | `-p` 中的宿主机端口，示例为 `8787`     | `PUBLISH_PORT`，默认 `8787`         | `PORT`，默认 `8787`       |
| 数据     | `superai-data` 卷挂载到容器 `/data`    | `speaker-data` 卷挂载到容器 `/data` | `DATA_DIR`，默认 `./data` |

## 局域网访问

已使用 `-p 127.0.0.1:8787:8787` 部署的容器只接受本机连接。Docker 在创建容器时确定端口映射，需要重新创建容器才能改绑定地址。以下命令把旧容器改名保留，并继续挂载原 `superai-data` 数据卷。请把 `192.168.1.10` 换成部署机的局域网 IP，或使用 `-p 8787:8787` 将端口发布到所有接口。

```bash
docker stop superai && docker rename superai superai-local && \
docker run -d --name superai --restart unless-stopped \
  -p 192.168.1.10:8787:8787 -v superai-data:/data \
  taokeone/superai:0.1.2
```

使用仓库自带的 Compose 配置时，在原项目的 `.env` 中将 `PUBLISH_HOST` 设为 `0.0.0.0` 或部署机的局域网 IP，再执行 `docker compose up -d`。使用 README 的独立 Compose 示例时，直接修改 `ports`。使用 Node.js 时，设置 `HOST` 后重启。

在同一局域网的另一台设备打开 `http://192.168.1.10:8787`。如果连接超时，检查部署机是否允许局域网入站 TCP `8787`。需要投放私人曲库时，在「平台设置 → 音乐服务」填写音箱可以访问的相同地址。

可在实际访问地址后加上 `/healthz` 检查进程是否正常。使用 HTTPS 反向代理时设置 `COOKIE_SECURE=true`。只在可信反向代理覆盖 `X-Forwarded-For`，且客户端只能经该代理访问平台时启用 `TRUST_PROXY=true`。

## 持久化和备份

备份完整的卷或 `DATA_DIR`，包括 `state.json` 和自动生成的 `master.key`。如配置自管的 `MASTER_KEY`，请同时备份该值并在迁移时保持一致。不同进程应使用独立的数据目录。Docker Compose 停止时使用 `docker compose down`，附加 `-v` 会删除数据卷。

从旧版 Docker 部署升级时，请沿用原 Compose 项目名和 `.env`。可在 `.env` 中设置原 `COMPOSE_PROJECT_NAME`，再运行 `docker compose up -d --build --remove-orphans`，让更名后的 `superai` 服务继续使用该项目的 `speaker-data` 卷。

## 音箱收到投放后没有声音

先确认同一曲目能在浏览器播放，再检查音箱是否可以访问音频地址。对于处理带签名参数 URL 有困难的固件，可启用歌曲地址转跳。转跳把音箱引导到已解析的原音频 URL，不缓存整首音乐。

**命令行**在 `.env` 设置以下参数后重启。请替换示例地址。

```dotenv
SPEAKER_RELAY_HOST=192.168.1.10
SPEAKER_RELAY_PORT=8788
```

**Docker Compose**在项目根目录放置以下 `compose.override.yaml`。将 IP 换成音箱能够访问的部署机器地址，再运行 `docker compose up -d`。

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

## 忘记管理员密码

新版平台运行时，在容器终端执行：

```bash
npm run reset-admin-password
```

或在宿主机执行（替换实际容器名）：

```bash
docker exec -u node -w /app superai npm run reset-admin-password
```

命令显示随机生成的新密码，立即使旧密码和已有登录会话失效，无需重启，保留其他配置。请妥善保存输出。旧镜像需先更新到包含此命令的版本。命令行部署使用相同命令，以及与平台相同的系统用户、工作目录、`.env` 和 `DATA_DIR`。管理通道仅监听数据目录中的本地 Unix socket，不开放网络接口。

[其他常见问题](faq.md)
