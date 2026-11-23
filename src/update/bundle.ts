import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { latestRelease } from "./protocol.ts";

const run = promisify(execFile);
const maxBundleSize = 32 * 1024 * 1024;

export async function prepareBundle(
  version: string,
  staging: string,
  fetchImpl = fetch,
) {
  const release = await latestRelease(fetchImpl);
  const directory = "superai-" + version + "-deploy";
  const name = directory + ".zip";
  const download =
    "https://github.com/TaoKe-One/superai/releases/download/v" +
    version +
    "/" +
    name;
  const asset = release.assets.find(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).name === name,
  );
  if (
    release.version !== version ||
    asset?.browser_download_url !== download ||
    typeof asset.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(asset.digest) ||
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > maxBundleSize
  )
    throw new Error("正式版本的部署包或 SHA-256 校验信息暂不可用。");
  const response = await fetchImpl(download, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw new Error("部署包下载失败。");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > asset.size) throw new Error("部署包大小校验失败。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks);
  if (
    size !== asset.size ||
    "sha256:" + createHash("sha256").update(bytes).digest("hex") !==
      asset.digest
  )
    throw new Error("部署包 SHA-256 校验失败。");
  const archive = join(staging, name);
  await writeFile(archive, bytes, { mode: 0o600 });
  const root = join(staging, directory);
  try {
    const { stdout } = await run("unzip", ["-Z1", archive], {
      timeout: 30_000,
    });
    for (const entry of stdout.trimEnd().split("\n")) {
      const parts = entry.replace(/\/$/, "").split("/");
      if (
        parts[0] !== directory ||
        /[\\\x00-\x1f]/.test(entry) ||
        parts.some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Invalid archive path");
    }
    const { stdout: details } = await run("unzip", ["-Z", "-l", archive], {
      timeout: 30_000,
    });
    if (/^[lbcdps][rwxstST-]{9}\s/m.test(details))
      throw new Error("Unexpected archive entry");
    await run("unzip", ["-q", archive, "-d", staging], { timeout: 30_000 });
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    if (entries.some((entry) => !entry.isFile() && !entry.isDirectory()))
      throw new Error("Unexpected extracted entry");
    const metadata = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    if (
      metadata.name !== "superai" ||
      metadata.version !== version ||
      !(await lstat(join(root, "src", "server.ts"))).isFile()
    )
      throw new Error("Unexpected package version");
  } catch {
    throw new Error("部署包解压或版本验证失败。请确认部署机已安装 unzip。");
  }
  try {
    await run(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: root,
        timeout: 240_000,
      },
    );
  } catch {
    throw new Error("安装新版运行依赖失败。请检查 npm 和网络连接。");
  }
  return root;
}
