import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  latestVersion,
  localRequest,
  newerVersion,
  stableVersion,
  UPDATE_SOCKET,
} from "./protocol.ts";

const IMAGE_VERSION = "org.opencontainers.image.version";
const IMAGE_SOURCE = "org.opencontainers.image.source";
const PROJECT = "https://github.com/TaoKe-One/superai";
const ENABLED_LABEL = "io.superai.updates";
const STATE_PATH = "/data/state.json";

type Phase =
  | "pulling"
  | "switching"
  | "verifying"
  | "rolling_back"
  | "updated"
  | "rolled_back"
  | "failed";

interface Job {
  id: string;
  phase: Phase;
  version: string;
  previousId?: string;
  replacementId?: string;
  message?: string;
}

interface ImageConfig {
  Labels?: Record<string, string>;
  Env?: string[];
  Entrypoint?: string[];
  Cmd?: string[];
  Healthcheck?: { Test?: string[] };
}

interface Image {
  Id: string;
  Config: ImageConfig;
}

interface Container {
  Id: string;
  Image: string;
  Name: string;
  Config: ImageConfig;
  HostConfig: {
    NetworkMode: string;
    AutoRemove: boolean;
    PublishAllPorts: boolean;
    PortBindings?: Record<string, Array<{ HostPort: string }> | null>;
    RestartPolicy: unknown;
  };
  Mounts: Array<{
    Destination: string;
    Type: string;
    Name?: string;
    RW: boolean;
  }>;
  NetworkSettings: {
    Networks: Record<string, { Aliases?: string[]; IPAMConfig?: unknown }>;
  };
  State: { Running: boolean; Status: string; Health?: { Status: string } };
}

interface WorkerOptions {
  socketPath?: string;
  dockerSocket?: string;
  target?: string;
  repository?: string;
  release?: () => Promise<string>;
  pull?: (version: string) => Promise<Image>;
  healthTimeoutMs?: number;
}

export async function startUpdateWorker(options: WorkerOptions = {}) {
  const socketPath = options.socketPath ?? UPDATE_SOCKET;
  const dockerSocket = options.dockerSocket ?? "/var/run/docker.sock";
  const target = options.target ?? "superai";
  const repository = options.repository ?? "ghcr.io/taoke-one/superai";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(target))
    throw new Error("Invalid SUPERAI_UPDATE_CONTAINER");
  if (
    !["ghcr.io/taoke-one/superai", "docker.io/taokeone/superai"].includes(
      repository,
    )
  )
    throw new Error("Invalid SUPERAI_UPDATE_REPOSITORY");
  const release = options.release ?? latestVersion;
  const stateFile = socketPath + ".json";
  const archiveFile = socketPath + ".tar";
  await mkdir(dirname(socketPath), { recursive: true });
  const listening = await localRequest(socketPath, "GET", "/").then(
    () => true,
    (error) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
        return false;
      throw error;
    },
  );
  if (listening) throw new Error("已有升级服务正在使用此数据卷。");

  let job: Job | null;
  try {
    job = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    job = null;
  }
  let busy =
    job !== null &&
    ["pulling", "switching", "verifying", "rolling_back"].includes(job.phase);

  const docker = async (
    method: string,
    path: string,
    body?: Buffer,
    timeout?: number,
    type?: string,
  ) => {
    const result = await localRequest(
      dockerSocket,
      method,
      path,
      body,
      timeout,
      type,
    );
    if (result.status >= 400)
      throw new Error(`Docker 请求失败（HTTP ${result.status}）。`);
    return result.body;
  };
  const inspect = async (name: string): Promise<Container> =>
    JSON.parse(
      (await docker("GET", "/containers/" + name + "/json")).toString("utf8"),
    );
  const image = async (name: string): Promise<Image> =>
    JSON.parse(
      (await docker("GET", "/images/" + name + "/json")).toString("utf8"),
    );
  const container = (id: string, action = "") => "/containers/" + id + action;
  const archive = (id: string, path: string) =>
    container(id, "/archive?path=" + encodeURIComponent(path));
  const save = async (next: Job) => {
    await writeFile(stateFile + ".tmp", JSON.stringify(next), { mode: 0o600 });
    await rename(stateFile + ".tmp", stateFile);
    job = next;
  };
  const remove = async (id: string) => {
    const result = await localRequest(
      dockerSocket,
      "DELETE",
      container(id, "?force=true"),
    );
    if (result.status >= 400 && result.status !== 404)
      throw new Error("Docker 无法移除升级容器。");
  };
  const waitForHealth = async (id: string) => {
    const deadline = Date.now() + (options.healthTimeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      const current = await inspect(id);
      if (current.State.Running && current.State.Health?.Status === "healthy")
        return;
      if (
        current.State.Health?.Status === "unhealthy" ||
        ["exited", "dead"].includes(current.State.Status)
      )
        break;
      await delay(1000);
    }
    throw new Error("容器未通过健康检查。");
  };
  const stagedName = (current: Job) => target + "-update-" + current.id;
  const rollback = async (current: Job, message: string) => {
    if (current.phase === "pulling") {
      await remove(current.replacementId ?? stagedName(current));
      await save({ ...current, phase: "failed", message });
      return;
    }
    if (!current.previousId) throw new Error("缺少旧容器记录。");
    await save({ ...current, phase: "rolling_back", message });
    const previous = await inspect(current.previousId);
    await remove(current.replacementId ?? stagedName(current));
    if (!previous.State.Running) {
      const snapshot = await readFile(archiveFile).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (snapshot) {
        await docker(
          "PUT",
          archive(previous.Id, "/data") + "&copyUIDGID=true",
          snapshot,
          30_000,
          "application/x-tar",
        );
      }
      if (previous.Name !== "/" + target)
        await docker("POST", container(previous.Id, "/rename?name=" + target));
      await docker("POST", container(previous.Id, "/start"));
    }
    await waitForHealth(previous.Id);
    await save({
      ...current,
      phase: "rolled_back",
      message: message + " 已恢复原版本。",
    });
    await rm(archiveFile, { force: true });
  };
  const pull =
    options.pull ??
    (async (version: string) => {
      const tag = repository + ":" + version;
      const progress = await docker(
        "POST",
        "/images/create?fromImage=" +
          encodeURIComponent(repository) +
          "&tag=" +
          version,
        undefined,
        300_000,
      );
      for (const line of progress.toString("utf8").trim().split("\n")) {
        if (line && JSON.parse(line).error)
          throw new Error("镜像暂未发布或下载失败，请稍后重试。");
      }
      return image(tag);
    });
  const run = async (current: Job) => {
    const previous = await inspect(target);
    const previousImage = await image(previous.Image);
    const currentVersion = previousImage.Config.Labels?.[IMAGE_VERSION];
    if (
      !previous.State.Running ||
      previous.Config.Labels?.[ENABLED_LABEL] !== "true" ||
      previousImage.Config.Labels?.[IMAGE_SOURCE]?.toLowerCase() !==
        PROJECT.toLowerCase() ||
      !stableVersion(currentVersion) ||
      !newerVersion(current.version, currentVersion) ||
      previous.HostConfig.AutoRemove ||
      previous.HostConfig.NetworkMode.startsWith("container:") ||
      !previous.Mounts.some(
        (mount) =>
          mount.Destination === "/data" && mount.Type === "volume" && mount.RW,
      ) ||
      !previous.Mounts.some(
        (mount) =>
          mount.Destination === dirname(UPDATE_SOCKET) &&
          mount.Type === "volume" &&
          !mount.RW,
      )
    ) {
      throw new Error("当前容器不符合后台升级的部署条件。");
    }
    if (current.version !== (await release()))
      throw new Error("正式版本已变化，请重新检查更新。");
    if (
      previous.HostConfig.PublishAllPorts ||
      Object.values(previous.HostConfig.PortBindings ?? {}).some((bindings) =>
        bindings?.some(
          ({ HostPort }) => !/^\d+$/.test(HostPort) || Number(HostPort) === 0,
        ),
      )
    ) {
      throw new Error(
        "请使用固定的宿主机端口。Docker 重启时会重新分配动态端口。",
      );
    }
    const next = await pull(current.version);
    if (
      next.Config.Labels?.[IMAGE_VERSION] !== current.version ||
      next.Config.Labels?.[IMAGE_SOURCE]?.toLowerCase() !==
        PROJECT.toLowerCase() ||
      !next.Config.Healthcheck?.Test?.length ||
      next.Config.Healthcheck.Test[0] === "NONE"
    )
      throw new Error("镜像未通过版本和健康检查配置验证。");

    const { Config, HostConfig, NetworkSettings } = previous;
    const { Cmd, Entrypoint, Healthcheck, Labels, ...settings } = Config;
    if (
      JSON.stringify(Cmd) !== JSON.stringify(previousImage.Config.Cmd) ||
      JSON.stringify(Entrypoint) !==
        JSON.stringify(previousImage.Config.Entrypoint)
    )
      throw new Error("后台升级需要使用镜像的默认启动命令。");
    const replacementLabels = {
      ...Labels,
      ...next.Config.Labels,
      [ENABLED_LABEL]: "true",
    };
    const endpoints = Object.fromEntries(
      Object.entries(NetworkSettings.Networks).map(
        ([network, { Aliases, IPAMConfig }]) => [
          network,
          { Aliases, IPAMConfig },
        ],
      ),
    );
    const { Id: replacementId } = JSON.parse(
      (
        await docker(
          "POST",
          "/containers/create?name=" + stagedName(current),
          Buffer.from(
            JSON.stringify({
              ...settings,
              Image: next.Id,
              Labels: replacementLabels,
              HostConfig,
              NetworkingConfig: { EndpointsConfig: endpoints },
            }),
          ),
          30_000,
        )
      ).toString("utf8"),
    );
    if ((await inspect(target)).Id !== previous.Id)
      throw new Error("升级期间容器已被其他操作替换。");
    await rm(archiveFile, { force: true });
    await save({
      ...current,
      phase: "switching",
      previousId: previous.Id,
      replacementId,
    });
    await docker(
      "POST",
      container(previous.Id, "/stop?t=15"),
      undefined,
      25_000,
    );
    const snapshot = await docker(
      "GET",
      archive(previous.Id, STATE_PATH),
      undefined,
      30_000,
    );
    await writeFile(archiveFile + ".tmp", snapshot, { mode: 0o600 });
    await rename(archiveFile + ".tmp", archiveFile);
    await docker(
      "POST",
      container(
        previous.Id,
        "/rename?name=" + target + "-previous-" + current.id,
      ),
    );
    await docker("POST", container(replacementId, "/rename?name=" + target));
    await save({ ...job!, phase: "verifying" });
    await docker("POST", container(replacementId, "/start"));
    await waitForHealth(replacementId);
    await save({ ...job!, phase: "updated" });
    await remove(previous.Id).catch(console.error);
    await rm(archiveFile, { force: true }).catch(console.error);
  };
  const recover = async (current: Job, error: unknown) => {
    const message = error instanceof Error ? error.message : "升级未完成。";
    try {
      await rollback(current, message);
    } catch (failure) {
      console.error("SuperAI rollback:", failure);
      await save({
        ...current,
        phase: "rolling_back",
        message: "自动恢复未完成，升级服务重启后会继续尝试。",
      });
    }
  };

  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/") {
      res.end(
        JSON.stringify({
          busy,
          job: job && {
            id: job.id,
            phase: job.phase,
            version: job.version,
            message: job.message,
          },
        }),
      );
      return;
    }
    const version =
      req.method === "POST" && req.url?.startsWith("/") ? req.url.slice(1) : "";
    if (!stableVersion(version) || busy) {
      res.writeHead(busy ? 409 : 400).end(
        JSON.stringify({
          error: busy ? "已有升级任务正在处理。" : "版本无效。",
        }),
      );
      return;
    }
    busy = true;
    const current: Job = { id: randomUUID(), phase: "pulling", version };
    try {
      await save(current);
      res.writeHead(202).end(JSON.stringify({ id: current.id }));
      void run(current)
        .catch((error) => recover(job ?? current, error))
        .catch(console.error)
        .finally(() => {
          busy = job?.phase === "rolling_back";
        });
    } catch {
      busy = false;
      res.writeHead(500).end(JSON.stringify({ error: "无法保存升级任务。" }));
    }
  });
  // This socket belongs to a single supervisor container and is mounted read-only in the app.
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o666);
  if (busy && job)
    void recover(job, new Error("升级服务曾中断。"))
      .catch(console.error)
      .finally(() => {
        busy = job?.phase === "rolling_back";
      });
  return server;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await startUpdateWorker({
    target: process.env.SUPERAI_UPDATE_CONTAINER,
    repository: process.env.SUPERAI_UPDATE_REPOSITORY,
  });
}
