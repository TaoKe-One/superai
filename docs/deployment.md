# 部署配置

[English](deployment.en.md) · [返回项目首页](../README.md)

## Docker Compose

在项目根目录运行以下命令，从 GitHub Container Registry 拉取镜像。已有部署请在原 Compose 项目中执行，以继续使用原 `speaker-data` 卷。

```bash
SUPERAI_IMAGE=ghcr.io/taoke-one/superai:0.1.0 docker compose up -d --no-build --pull always
```

可把 `SUPERAI_IMAGE` 保存到 `.env`，需要升级时更换版本标签，再执行 `docker compose up -d --no-build --pull always`。如果要从本地源码构建，移除 `SUPERAI_IMAGE` 后执行 `docker compose up -d --build`。

## 监听地址和端口

两种快速部署方式默认只在本机提供管理页面。先完成管理员初始化，再按需要开放局域网访问。

| 设置     | Docker Compose                      | 命令行                    |
| -------- | ----------------------------------- | ------------------------- |
| 监听地址 | 在 `.env` 中设置 `PUBLISH_HOST`     | 设置 `HOST`               |
| 端口     | `PUBLISH_PORT`，默认 `8787`         | `PORT`，默认 `8787`       |
| 数据     | `speaker-data` 卷挂载到容器 `/data` | `DATA_DIR`，默认 `./data` |

要允许音箱访问私人曲库，可将对应的监听地址设为部署机器的局域网 IP，例如 `192.168.1.10`。重启后在「平台设置 → 音乐服务」填写 `http://192.168.1.10:8787`，使用实际 IP 和端口。浏览器和音箱都需要能访问播放所用的网络地址。

可用 `curl -fsS http://localhost:8787/healthz` 检查进程是否正常。使用 HTTPS 反向代理时设置 `COOKIE_SECURE=true`。只在可信反向代理覆盖 `X-Forwarded-For`，且客户端只能经该代理访问平台时启用 `TRUST_PROXY=true`。

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

## 常见问题

- **扫码后看不到音箱**。确认手机和平台使用同一个小米账号，再在音箱设备页刷新设备。需要排查时可启用 `MIOT_LOGIN_DIAGNOSTICS=true`，复现后关闭。
- **在线目录能搜索，但无法播放**。在播放器的「音乐源管理」启用支持该音乐平台的音源，并运行可用性检测。检测验证样本，播放结果随音源和曲目而变化。
- **LX 音源报 Fake-IP DNS 错误**。如果部署网络允许访问 Cloudflare HTTPS DNS，可设置 `LX_DNS_OVER_HTTPS=true` 后重启。
- **WebDAV 音频转码失败**。Docker 镜像自带 FFmpeg。命令行部署可用 `ffmpeg -version` 检查安装，也可通过 `FFMPEG_PATH` 指定可执行文件。
