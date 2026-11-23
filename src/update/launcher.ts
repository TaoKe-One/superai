import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../environment.ts";
import { prepareBundle } from "./bundle.ts";
import { localRequest, newerVersion, stableVersion } from "./protocol.ts";

interface Job {
  id: string;
  version: string;
  phase:
    | "pulling"
    | "switching"
    | "verifying"
    | "rolling_back"
    | "updated"
    | "rolled_back"
    | "failed";
  message?: string;
}

async function optionalText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

async function writeAtomic(path: string, data: string | Buffer) {
  const temporary = path + ".tmp";
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, path);
}

async function stop(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((done) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.once("exit", () => {
      clearTimeout(timeout);
      done();
    });
    child.kill("SIGTERM");
  });
}

export async function launch({
  root = fileURLToPath(new URL("../../", import.meta.url)),
  dataDir = process.env.DATA_DIR ?? "./data",
  prepare = prepareBundle,
  startupTimeout = 30_000,
} = {}) {
  const bootstrap = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).version as string;
  const managed = process.env.SUPERAI_UPDATES !== "true";
  const enabled = process.env.SUPERAI_UPDATES !== "false";
  const data = resolve(dataDir);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const storage = join(data, ".superai-update");
  const activeFile = join(storage, "active");
  const pendingFile = join(storage, "pending");
  const backup = join(storage, "state.backup");
  const state = join(data, "state.json");
  const releaseRoot = (version: string) => join(storage, version);
  let current = bootstrap;
  let currentRoot = root;
  let socket = "";
  let child: ChildProcess | undefined;
  let job: Job | null = null;
  let stopping = false;
  let ready = false;
  let operation: Promise<void> | undefined;

  const spawnApp = async (folder: string, version: string) => {
    const entry = await realpath(join(folder, "src", "server.ts"));
    if (stopping) throw new Error("应用正在退出。");
    const app = spawn(process.execPath, ["--experimental-strip-types", entry], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        DATA_DIR: data,
        SUPERAI_MANAGED_UPDATE_SOCKET: enabled ? socket : "",
      },
    });
    child = app;
    app.once("exit", (code) => {
      if (ready && !stopping && !operation && child === app)
        process.exit(code || 1);
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => finish(new Error("应用启动超时。")),
        startupTimeout,
      );
      const onMessage = (message: unknown) => {
        const reply = message as { ready?: boolean; version?: string };
        if (reply?.ready && reply.version === version) finish();
      };
      const onExit = () => finish(new Error("应用未通过启动检查。"));
      function finish(error?: Error) {
        clearTimeout(timer);
        app.off("message", onMessage);
        app.off("exit", onExit);
        app.off("error", finish);
        if (error) reject(error);
        else done();
      }
      app.on("message", onMessage);
      app.once("exit", onExit);
      app.once("error", finish);
    });
  };

  const restore = async () => {
    await copyFile(backup, state + ".restore");
    await rename(state + ".restore", state);
    await rm(pendingFile);
  };

  const upgrade = async (next: Job) => {
    let stage: string | undefined;
    let switched = false;
    const candidate = releaseRoot(next.version);
    const report = (phase: Job["phase"], message?: string) => {
      job = { ...next, phase, ...(message && { message }) };
    };
    try {
      stage = await mkdtemp(join(storage, "download-"));
      const incoming = await prepare(next.version, stage);
      if (stopping) return;
      await rm(candidate, { recursive: true, force: true });
      await rename(incoming, candidate);
      report("switching");
      switched = true;
      await stop(child);
      if (stopping) return;
      await copyFile(state, backup);
      await chmod(backup, 0o600);
      await writeAtomic(pendingFile, next.version);
      if (stopping) return;
      report("verifying");
      await spawnApp(candidate, next.version);
      if (stopping) return;
      if (!child || child.exitCode !== null || child.signalCode !== null)
        throw new Error("新版进程在启动检查后退出。");
      await writeAtomic(activeFile, next.version);
      current = next.version;
      currentRoot = candidate;
      report("updated");
      await rm(pendingFile, { force: true }).catch(console.error);
      await rm(backup, { force: true }).catch(console.error);
    } catch (error) {
      const message = error instanceof Error ? error.message : "升级未完成。";
      if (stopping) return;
      if (!switched) {
        report("failed", message);
        return;
      }
      report("rolling_back");
      await stop(child);
      if (await optionalText(pendingFile)) await restore();
      await spawnApp(currentRoot, current);
      report("rolled_back", message + " 已恢复原版本。");
    } finally {
      if (stage)
        await rm(stage, { recursive: true, force: true }).catch(console.error);
    }
  };

  const control = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/") {
      res.end(JSON.stringify({ busy: Boolean(operation), job }));
      return;
    }
    const version = req.method === "POST" ? req.url?.slice(1) : undefined;
    const busy = !enabled || !ready || operation || stopping;
    if (!stableVersion(version) || !newerVersion(version, current) || busy) {
      res.writeHead(busy ? 409 : 400).end(
        JSON.stringify({
          error: busy ? "升级服务正忙。" : "请选择更新的正式版本。",
        }),
      );
      return;
    }
    job = { id: randomUUID(), version, phase: "pulling" };
    operation = upgrade(job)
      .catch((error) => {
        console.error("SuperAI upgrade recovery:", error);
        process.exit(1);
      })
      .finally(() => {
        operation = undefined;
      });
    res.writeHead(202).end(JSON.stringify({ id: job.id }));
  });

  const close = async () => {
    stopping = true;
    await stop(child);
    if (control.listening)
      await new Promise<void>((done) => control.close(() => done()));
  };

  if (managed) {
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(await realpath(data))
      .digest("hex")
      .slice(0, 20);
    // macOS user-specific temp paths can exceed the Unix socket length limit.
    const socketDir = join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "superai-" + (process.getuid?.() ?? "user") + "-" + key,
    );
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    const info = await lstat(socketDir);
    if (
      !info.isDirectory() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("升级服务的本地目录权限无效。");
    socket = join(socketDir, "update.sock");
    try {
      await localRequest(socket, "GET", "/");
      throw new Error("此数据目录的超级爱已经启动。");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      if (code === "ECONNREFUSED") await rm(socket, { force: true });
    }
    await new Promise<void>((done, reject) => {
      control.once("error", reject);
      control.listen(socket, done);
    });
    try {
      await chmod(socket, 0o600);
      const active = await optionalText(activeFile);
      const pending = await optionalText(pendingFile);
      if (pending && pending !== active) await restore();
      else if (pending) await rm(pendingFile, { force: true });
      if (stableVersion(active) && newerVersion(active, bootstrap)) {
        current = active;
        currentRoot = releaseRoot(active);
      }
    } catch (error) {
      await close();
      throw error;
    }
  }
  try {
    await spawnApp(currentRoot, current);
    ready = true;
  } catch (error) {
    await close();
    throw error;
  }
  return { close, socket };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  loadLocalEnvironment();
  const launcher = await launch();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(
      signal,
      () => void launcher.close().finally(() => process.exit(0)),
    );
  }
}
