import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

const context = new AsyncLocalStorage<{
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}>();
const DOH_TIMEOUT_MS = 1500;
const DOH_RETRY_DELAY_MS = 30_000;
let dohRetryAfter = 0;
const dnsCache = new Map<
  string,
  { expires: number; addresses: Array<{ address: string; family: number }> }
>();
export const withLxHttp = <T>(
  fetchImpl: typeof fetch | undefined,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> =>
  context.run(
    {
      fetchImpl,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    },
    fn,
  );
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  // Only global-unicast IPv6; reject mapped IPv4, link/local/multicast and documentation ranges.
  return (
    isIP(ip) === 6 &&
    /^[23]/.test(ip) &&
    !ip.startsWith("2001:db8:") &&
    !ip.startsWith("2002:") &&
    !ip.startsWith("2001:0:")
  );
}
export function publicUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    raw.length > 4096
  )
    throw new Error("音乐源只允许无凭证的 HTTP/HTTPS 地址");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new Error("音乐源不能访问本机或私有网络");
  return url;
}
export async function publicRequest(
  raw: string,
  options: Record<string, any> = {},
  signal: AbortSignal = AbortSignal.timeout(12_000),
  redirects = 0,
  prefixBytes = 0,
): Promise<{
  body: unknown;
  raw: Buffer;
  statusCode: number;
  statusMessage: string;
  bytes: number;
  headers: Record<string, any>;
}> {
  if (signal.aborted) throw new Error("音乐源请求超时");
  const url = publicUrl(raw);
  if (redirects > 4) throw new Error("音乐源跳转次数过多");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolvePublicAddresses(host, signal);
  let data: Buffer | undefined;
  const headers: Record<string, string> = {
    "user-agent": "SpeakerPlatform-LX/1.0",
    "accept-encoding": "gzip, deflate, br",
  };
  if (prefixBytes) {
    headers.range = "bytes=0-" + (prefixBytes - 1);
    headers["accept-encoding"] = "identity";
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (
      [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
      ].includes(key.toLowerCase())
    )
      continue;
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }
  if (options.form) {
    data = Buffer.from(new URLSearchParams(options.form).toString());
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (options.body !== undefined) {
    data = Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(
          typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body),
        );
    if (typeof options.body === "object" && !Buffer.isBuffer(options.body))
      headers["content-type"] = "application/json";
  }
  if (data && data.length > 1024 * 1024) throw new Error("音乐源请求过大");
  if (data) headers["content-length"] = String(data.length);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: options.method ?? "GET",
        headers,
        signal,
        lookup: ((_host: any, opts: any, callback: any) => {
          const a =
            addresses.find((a) => !opts.family || a.family === opts.family) ??
            addresses[0];
          callback(null, opts.all ? [a] : a.address, a.family);
        }) as any,
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          if (prefixBytes) res.destroy();
          else res.resume();
          const next = { ...options, headers: {} };
          if (
            res.statusCode === 303 ||
            ([301, 302].includes(res.statusCode) &&
              String(options.method).toUpperCase() === "POST")
          ) {
            next.method = "GET";
            delete next.body;
            delete next.form;
          }
          publicRequest(
            new URL(res.headers.location, url).toString(),
            next,
            signal,
            redirects + 1,
            prefixBytes,
          ).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (prefixBytes) {
            chunks.push(chunk.subarray(0, Math.max(0, prefixBytes - size)));
            size += chunk.length;
            if (size >= prefixBytes) {
              const raw = Buffer.concat(chunks);
              resolve({
                body: undefined,
                raw,
                statusCode: res.statusCode ?? 0,
                statusMessage: res.statusMessage ?? "",
                bytes: raw.length,
                headers: res.headers,
              });
              res.destroy();
            }
            return;
          }
          size += chunk.length;
          if (size > 2 * 1024 * 1024)
            res.destroy(new Error("音乐源响应超过 2 MB"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            let raw = Buffer.concat(chunks);
            if (prefixBytes) {
              resolve({
                body: undefined,
                raw,
                statusCode: res.statusCode ?? 0,
                statusMessage: res.statusMessage ?? "",
                bytes: raw.length,
                headers: res.headers,
              });
              return;
            }
            const enc = res.headers["content-encoding"];
            const limits = { maxOutputLength: 2 * 1024 * 1024 };
            if (enc === "gzip") raw = gunzipSync(raw, limits);
            else if (enc === "deflate") raw = inflateSync(raw, limits);
            else if (enc === "br") raw = brotliDecompressSync(raw, limits);
            let body: unknown = raw.toString();
            try {
              body = JSON.parse(body as string);
            } catch {}
            resolve({
              body,
              raw,
              statusCode: res.statusCode ?? 0,
              statusMessage: res.statusMessage ?? "",
              bytes: raw.length,
              headers: res.headers,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", () =>
      reject(
        new Error(signal.aborted ? "音乐源请求超时" : "音乐源网络请求失败"),
      ),
    );
    if (data) req.write(data);
    req.end();
  });
}

async function resolvePublicAddresses(host: string, signal: AbortSignal) {
  const family = isIP(host);
  if (family) return [{ address: host, family }]; // publicUrl already checks IP literals.

  const mode = process.env.LX_DNS_OVER_HTTPS?.trim().toLowerCase();
  let encryptedError: unknown;
  if (mode === "true") {
    try {
      return await encryptedDns(host, signal);
    } catch (error) {
      signal.throwIfAborted();
      encryptedError = error;
    }
  }

  const addresses = await abortable(lookup(host, { all: true }), signal);
  if (
    addresses.length &&
    addresses.every(({ address }) => isPublicAddress(address))
  )
    return addresses;

  // A private or mixed answer remains blocked. Only a set consisting entirely
  // of Fake-IP addresses can trigger an automatic lookup with a public resolver.
  if (
    !addresses.length ||
    !addresses.every(({ address }) => /^198\.(?:18|19)\./.test(address))
  )
    throw new Error("音乐源不能访问本机或私有网络");
  if (mode === "false")
    throw new Error(
      "系统 DNS 返回代理 Fake-IP，且加密 DNS 已关闭。请检查网络 DNS 设置",
    );

  try {
    if (mode === "true") throw encryptedError;
    return await encryptedDns(host, signal);
  } catch (error) {
    signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : "加密 DNS 解析失败";
    throw new Error(
      "系统 DNS 返回代理 Fake-IP，无法获取可用的公网地址：" + reason,
    );
  }
}

// Fixed public DoH endpoint with verified TLS. A network timeout briefly
// suppresses new DoH requests so healthy system DNS can keep working.
async function encryptedDns(host: string, outerSignal: AbortSignal) {
  outerSignal.throwIfAborted();
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  if (Date.now() < dohRetryAfter)
    throw new Error("加密 DNS 连接超时，稍后重试");
  const timeout = AbortSignal.timeout(DOH_TIMEOUT_MS);
  const signal = AbortSignal.any([outerSignal, timeout]);
  const addresses = await new Promise<
    Array<{ address: string; family: number }>
  >((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "cloudflare-dns.com",
        servername: "cloudflare-dns.com",
        rejectUnauthorized: true,
        path: "/dns-query?type=A&name=" + encodeURIComponent(host),
        headers: { accept: "application/dns-json" },
        signal,
        lookup: ((_host: any, opts: any, cb: any) =>
          cb(
            null,
            opts.all ? [{ address: "1.1.1.1", family: 4 }] : "1.1.1.1",
            4,
          )) as any,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65536) res.destroy(new Error("DNS 响应过大"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error("DNS 解析失败");
            resolve(
              parseDnsAnswers(JSON.parse(Buffer.concat(chunks).toString())),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  }).catch((error) => {
    outerSignal.throwIfAborted();
    if (!timeout.aborted)
      throw new Error("加密 DNS 解析失败", { cause: error });
    dohRetryAfter = Date.now() + DOH_RETRY_DELAY_MS;
    throw new Error("加密 DNS 连接超时", { cause: error });
  });
  if (dnsCache.size >= 256) dnsCache.delete(dnsCache.keys().next().value!);
  dnsCache.set(host, { expires: Date.now() + 60000, addresses });
  return addresses;
}
export function parseDnsAnswers(
  value: any,
): Array<{ address: string; family: number }> {
  if (value?.Status !== 0 || !Array.isArray(value.Answer))
    throw new Error("加密 DNS 没有返回有效地址");
  const addresses = value.Answer.filter((answer: any) => answer.type === 1).map(
    (answer: any) => ({ address: String(answer.data), family: 4 }),
  );
  if (
    !addresses.length ||
    addresses.some(
      (a: any) => isIP(a.address) !== 4 || !isPublicAddress(a.address),
    )
  )
    throw new Error("音乐源不能访问本机或私有网络");
  return addresses;
}

// DNS promises and injected transports may ignore cancellation. Stop waiting without
// retaining a VM or a concurrency slot; the settled promise is still observed.
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error("音乐源请求已取消或超时"));
    if (signal.aborted) {
      work.catch(() => {});
      cancelled();
      return;
    }
    signal.addEventListener("abort", cancelled, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancelled));
  });
}

export async function responseBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("音乐源响应超过 2 MB");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

// Small native replacement for LX's Electron request bridge. Per-request context avoids global fetch mutations.
export function httpFetch(url: string, options: Record<string, any> = {}) {
  const local = new AbortController();
  const active = context.getStore();
  const signal = AbortSignal.any([
    local.signal,
    active?.signal ?? AbortSignal.timeout(15_000),
  ]);
  const promise = active?.fetchImpl
    ? (async () => {
        publicUrl(url);
        const headers = { ...options.headers };
        let body = options.body;
        if (options.form) {
          body = new URLSearchParams(options.form).toString();
          headers["content-type"] = "application/x-www-form-urlencoded";
        } else if (body && typeof body === "object") {
          body = JSON.stringify(body);
          headers["content-type"] = "application/json";
        }
        const response = await abortable(
          active.fetchImpl!(url, {
            method: options.method,
            headers,
            body,
            signal,
            redirect: "error",
          }),
          signal,
        );
        const raw = await responseBytes(response, signal);
        let value: unknown = raw.toString();
        try {
          value = JSON.parse(value as string);
        } catch {}
        return {
          body: value,
          raw,
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
        };
      })()
    : publicRequest(url, options, signal);
  return { promise, cancelHttp: () => local.abort() };
}
