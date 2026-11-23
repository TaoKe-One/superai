import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

interface RelayOptions {
  host: string;
  port: number;
  baseUrl?: string;
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
}

/** A song-only redirect listener: the administration server stays on its original address. */
export class SpeakerUrlRelay {
  private readonly tickets = new Map<
    string,
    { target: string; expiresAt: number }
  >();
  private readonly server = createServer((request, response) => {
    const path = request.url ?? "";
    const ticket = this.tickets.get(path);
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    if (!ticket || ticket.expiresAt <= this.now()) {
      this.tickets.delete(path);
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    // Keep signed query parameters byte-for-byte intact, outside the Mina message.
    response.writeHead(302, { location: ticket.target }).end();
  });
  private baseUrl = "";
  private readonly now: () => number;
  private readonly options: RelayOptions;

  constructor(options: RelayOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 5000;
    this.server.maxHeadersCount = 32;
    if (
      !options.host ||
      !Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535
    )
      throw new Error("音箱转跳监听地址或端口无效");
    if (
      !Number.isInteger(options.ttlMs ?? 1) ||
      (options.ttlMs ?? 1) <= 0 ||
      !Number.isInteger(options.capacity ?? 1) ||
      (options.capacity ?? 1) <= 0
    )
      throw new Error("音箱转跳有效期或容量无效");
    if (options.baseUrl) this.validateBase(options.baseUrl);
    else if (["0.0.0.0", "::"].includes(options.host))
      throw new Error("音箱转跳监听全部地址时必须配置 SPEAKER_RELAY_BASE_URL");
  }

  private validateBase(raw: string) {
    const url = httpUrl(raw);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      ["0.0.0.0", "[::]"].includes(url.hostname)
    )
      throw new Error("音箱转跳基址必须是不含路径和查询参数的可达地址");
    return url.origin;
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("音箱转跳未启动");
    const host = this.options.host.includes(":")
      ? "[" + this.options.host + "]"
      : this.options.host;
    this.baseUrl = this.options.baseUrl
      ? this.validateBase(this.options.baseUrl)
      : "http://" + host + ":" + address.port;
    return this;
  }

  issue(target: string) {
    const url = httpUrl(target);
    if (!this.baseUrl || !this.server.listening)
      throw new Error("音箱转跳未启动");
    for (const [path, ticket] of this.tickets)
      if (ticket.expiresAt <= this.now()) this.tickets.delete(path);
    // Never evict a still-playing song to make room for a new command.
    if (this.tickets.size >= (this.options.capacity ?? 256))
      throw new Error("音箱临时播放地址数量已达上限，请稍后重试");
    const extension =
      url.pathname.match(/\.(mp3|flac|m4a|aac|ogg|wav)$/i)?.[0] ?? "";
    const path = "/audio/" + randomBytes(32).toString("base64url") + extension;
    this.tickets.set(path, {
      target: url.href,
      expiresAt: this.now() + (this.options.ttlMs ?? 30 * 60_000),
    });
    return this.baseUrl + path;
  }

  async close() {
    this.baseUrl = "";
    this.tickets.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

function httpUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("音箱播放地址无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    raw.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(raw)
  )
    throw new Error("音箱播放地址必须是无凭证的 HTTP 或 HTTPS URL");
  return url;
}
