import { request } from "node:http";
import { readFile } from "node:fs/promises";

export const UPDATE_SOCKET = "/run/superai-updates/update.sock";
const RELEASES_URL =
  "https://api.github.com/repos/TaoKe-One/superai/releases/latest";
export const appVersion = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

export function stableVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)
  );
}

export function newerVersion(candidate: string, current: string): boolean {
  const before = current.split(".").map(Number);
  for (const [index, part] of candidate.split(".").map(Number).entries()) {
    if (part !== before[index]) return part > before[index];
  }
  return false;
}

export async function latestRelease(fetchImpl = fetch): Promise<{
  version: string;
  assets: unknown[];
}> {
  const response = await fetchImpl(RELEASES_URL, {
    headers: { accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error("暂时无法读取 GitHub 发布信息，请稍后重试。");
  const release = await response.json();
  const version =
    typeof release?.tag_name === "string" && release.tag_name.startsWith("v")
      ? release.tag_name.slice(1)
      : null;
  if (!stableVersion(version) || release.prerelease || release.draft) {
    throw new Error("GitHub 未返回有效的正式版本。");
  }
  return {
    version,
    assets: Array.isArray(release.assets) ? release.assets : [],
  };
}

export async function latestVersion(fetchImpl = fetch): Promise<string> {
  return (await latestRelease(fetchImpl)).version;
}

export async function localRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: Buffer,
  timeout = 5000,
  contentType = "application/json",
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        agent: false,
        signal: AbortSignal.timeout(timeout),
        headers: body
          ? { "content-type": contentType, "content-length": body.length }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1024 * 1024) {
            response.destroy(new Error("Update response exceeds 64 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 502,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
