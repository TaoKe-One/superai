/** Requests to explicitly configured administrator endpoints. Never follow credential redirects. */
export function serviceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("服务地址必须是完整的 HTTP/HTTPS 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("服务地址不能包含凭证、查询参数或片段");
  return url.toString().replace(/\/+$/, "");
}
export async function limitedBytes(
  response: Response,
  maximum = 2 * 1024 * 1024,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("服务响应超过大小限制");
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error("服务响应超过大小限制");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function serviceJson(
  fetchImpl: typeof fetch,
  url: string | URL,
  options: RequestInit = {},
): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error("服务连接失败或超时，请检查地址和网络");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("服务请求失败，HTTP " + response.status);
  }
  try {
    return JSON.parse((await limitedBytes(response)).toString("utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error("服务没有返回有效 JSON");
    throw e;
  }
}
