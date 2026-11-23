import { createConnection } from "node:net";
import { createServer, request } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import type { AdminAuth } from "./auth.ts";

const socketPath = (dataDir = process.env.DATA_DIR ?? "./data") => {
  const absolute = join(resolve(dataDir), "admin-control.sock");
  const local = relative(process.cwd(), absolute);
  return local.length < absolute.length ? local : absolute;
};

/** Local filesystem permissions protect this endpoint; it is never exposed over TCP. */
export async function startAdminControl(auth: AdminAuth, dataDir?: string) {
  const path = socketPath(dataDir);
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("该数据目录已有平台管理进程运行"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  await rm(path, { force: true });
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "POST" || req.url !== "/reset-admin-password") {
      res.writeHead(404).end();
      return;
    }
    try {
      const password = await auth.resetPassword();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ password }));
    } catch {
      res.writeHead(500).end("Password reset failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  try {
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}

export function resetAdminPassword(dataDir?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socketPath(dataDir),
        path: "/reset-admin-password",
        method: "POST",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error("密码重置失败");
            resolve(JSON.parse(body).password);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("密码重置超时")));
    req.on("error", reject);
    req.end();
  });
}
