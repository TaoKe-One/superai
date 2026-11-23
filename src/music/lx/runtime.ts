import { getQuickJS } from "quickjs-emscripten";
import { readFile } from "node:fs/promises";
import {
  createHash,
  randomBytes,
  createCipheriv,
  publicEncrypt,
  constants,
} from "node:crypto";
import { inflateSync, deflateSync } from "node:zlib";
import { abortable, publicRequest, publicUrl, responseBytes } from "./http.ts";
import { PLATFORMS } from "./catalog.ts";

export interface LxSourceMetadata {
  name: string;
  version: string;
  author: string;
  description: string;
  sources: Record<string, { actions: string[]; qualitys: string[] }>;
}
const environment = readFile(
  new URL("./runtime-env.js", import.meta.url),
  "utf8",
);
let active = 0;
const QUALITY = ["128k", "320k", "flac", "flac24bit"];
export async function runLxScript(
  script: string,
  info?: { source: string; action: string; info: unknown },
  fetchImpl?: typeof fetch,
  timeoutMs = 15000,
  outerSignal?: AbortSignal,
): Promise<any> {
  if (Buffer.byteLength(script) > 512 * 1024)
    throw new Error("音源脚本不能超过 512 KB");
  if (active >= 4) throw new Error("音源解析繁忙，请稍后再试");
  active++;
  let runtime: any, vm: any;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  outerSignal?.addEventListener("abort", cancel, { once: true });
  if (outerSignal?.aborted) cancel();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const rejectTimers = new Map<number, (error: Error) => void>();
  const tasks = new Map<number, Promise<string>>();
  const controllers = new Map<number, AbortController>();
  const deferred = new Set<any>();
  let nextId = 1,
    ready: any,
    cpuDeadline = Date.now() + 300;
  try {
    const engine = await getQuickJS();
    runtime = engine.newRuntime();
    runtime.setMemoryLimit(24 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    runtime.setInterruptHandler(() => Date.now() > cpuDeadline);
    vm = runtime.newContext();
    const evaluate = (code: string) => {
      cpuDeadline = Date.now() + 300;
      const result = vm.evalCode(code, "lx-source.js");
      if (result.error) {
        result.error.dispose();
        throw new Error("音源脚本执行失败或超出资源限制");
      }
      return result.value;
    };
    const bind = (name: string, fn: (...args: any[]) => any) => {
      const h = vm.newFunction(name, fn);
      vm.setProp(vm.global, name, h);
      h.dispose();
    };
    bind("__lxReady", (value: any) => {
      if (ready) throw new Error("重复初始化");
      ready = JSON.parse(vm.getString(value));
    });
    bind("__lxTimer", (delay: any) => {
      if (tasks.size >= 24 || nextId > 128) throw new Error("音源任务次数过多");
      const id = nextId++;
      tasks.set(
        id,
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () => {
              timers.delete(id);
              rejectTimers.delete(id);
              resolve("null");
            },
            Math.min(15000, vm.getNumber(delay)),
          );
          timers.set(id, t);
          rejectTimers.set(id, reject);
        }),
      );
      tasks.get(id)!.catch(() => {});
      return vm.newNumber(id);
    });
    bind("__lxCancelTimer", (value: any) => {
      const id = vm.getNumber(value);
      clearTimeout(timers.get(id));
      timers.delete(id);
      rejectTimers.get(id)?.(new Error("Cancelled"));
      rejectTimers.delete(id);
    });
    bind("__lxAbort", (value: any) =>
      controllers.get(vm.getNumber(value))?.abort(),
    );
    bind("__lxHttp", (urlHandle: any, optionsHandle: any) => {
      if (tasks.size >= 24 || nextId > 128) throw new Error("音源请求次数过多");
      const url = vm.getString(urlHandle);
      publicUrl(url);
      const options = JSON.parse(vm.getString(optionsHandle));
      const id = nextId++;
      const controller = new AbortController();
      controllers.set(id, controller);
      const signal = AbortSignal.any([
        abort.signal,
        controller.signal,
        AbortSignal.timeout(
          Math.min(12000, Math.max(100, Number(options.timeout) || 12000)),
        ),
      ]);
      const task = (async () => {
        if (options.formData) throw new Error("音源 multipart 上传暂不支持");
        if (fetchImpl) {
          const response = await abortable(
            fetchImpl(url, {
              method: options.method,
              headers: options.headers,
              body: options.form
                ? new URLSearchParams(options.form)
                : typeof options.body === "object"
                  ? JSON.stringify(options.body)
                  : options.body,
              signal,
              redirect: "error",
            }),
            signal,
          );
          const raw = await responseBytes(response, signal);
          let body: any = raw.toString();
          try {
            body = JSON.parse(body);
          } catch {}
          return JSON.stringify({
            statusCode: response.status,
            statusMessage: response.statusText,
            bytes: raw.length,
            headers: Object.fromEntries(response.headers),
            body,
            raw: Array.from(raw),
          });
        }
        const response = await publicRequest(url, options, signal);
        return JSON.stringify({ ...response, raw: Array.from(response.raw) });
      })();
      task.catch(() => {});
      tasks.set(id, task);
      return vm.newNumber(id);
    });
    bind("__lxWait", (value: any) => {
      const id = vm.getNumber(value);
      const promise = vm.newPromise();
      deferred.add(promise);
      (tasks.get(id) ?? Promise.reject(new Error("Missing task")))
        .then(
          (result) => {
            if (!abort.signal.aborted) {
              const h = vm.newString(result);
              promise.resolve(h);
              h.dispose();
            }
          },
          () => {
            if (!abort.signal.aborted) {
              const h = vm.newError("Music source request failed");
              promise.reject(h);
              h.dispose();
            }
          },
        )
        .finally(() => {
          tasks.delete(id);
          controllers.delete(id);
        });
      return promise.handle;
    });
    bind("__lxSync", (operation: any, json: any) => {
      const op = vm.getString(operation);
      const a = JSON.parse(vm.getString(json));
      if (JSON.stringify(a).length > 2 * 1024 * 1024)
        throw new Error("Crypto input too large");
      let value: any;
      switch (op) {
        case "bufferFrom":
          value = Array.from(Buffer.from(a[0], a[1]));
          break;
        case "bufferString":
          value = Buffer.from(a[0]).toString(a[1]);
          break;
        case "md5":
          value = createHash("md5")
            .update(typeof a[0] === "string" ? a[0] : Buffer.from(a[0]))
            .digest("hex");
          break;
        case "randomBytes":
          if (!Number.isInteger(a[0]) || a[0] < 0 || a[0] > 65536)
            throw new Error("Invalid random size");
          value = Array.from(randomBytes(a[0]));
          break;
        case "aesEncrypt": {
          if (!/^aes-(128|192|256)-(cbc|ecb)$/.test(a[1]))
            throw new Error("Unsupported cipher");
          const cipher = createCipheriv(
            a[1],
            Buffer.from(a[2]),
            a[3]?.length ? Buffer.from(a[3]) : null,
          );
          value = Array.from(
            Buffer.concat([cipher.update(Buffer.from(a[0])), cipher.final()]),
          );
          break;
        }
        case "rsaEncrypt": {
          let b = Buffer.from(a[0]);
          if (b.length > 128) throw new Error("RSA input too large");
          b = Buffer.concat([Buffer.alloc(128 - b.length), b]);
          value = Array.from(
            publicEncrypt({ key: a[1], padding: constants.RSA_NO_PADDING }, b),
          );
          break;
        }
        case "inflate":
          value = Array.from(
            inflateSync(Buffer.from(a[0]), {
              maxOutputLength: 2 * 1024 * 1024,
            }),
          );
          break;
        case "deflate":
          value = Array.from(
            deflateSync(Buffer.from(a[0]), {
              maxOutputLength: 2 * 1024 * 1024,
            }),
          );
          break;
        default:
          throw new Error("Unsupported helper");
      }
      return vm.newString(JSON.stringify(value));
    });
    evaluate(
      "globalThis.__lxInfo=" +
        JSON.stringify({
          name: scriptField(script, "name") || "LX 音源",
          description: scriptField(script, "description"),
          version: scriptField(script, "version"),
          author: scriptField(script, "author"),
          homepage: scriptField(script, "homepage"),
          rawScript: script,
        }) +
        ";",
    ).dispose();
    evaluate(await environment).dispose();
    evaluate(script).dispose();
    const deadline = Date.now() + Math.min(info ? timeoutMs : 5000, timeoutMs);
    const tick = async () => {
      if (abort.signal.aborted) throw new Error("音源解析已取消");
      if (Date.now() > deadline) throw new Error("音源脚本初始化或解析超时");
      cpuDeadline = Date.now() + 100;
      const result = runtime.executePendingJobs(100);
      if (result.error) {
        result.error.dispose();
        throw new Error("音源脚本异步执行失败");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    while (!ready) await tick();
    const metadata = normalizeMetadata(ready, script);
    if (!info) return metadata;
    const support = metadata.sources[info.source];
    if (!support?.actions.includes(info.action))
      throw new Error("音源不支持该音乐平台或动作");
    const handle = evaluate("__lxDispatch(" + JSON.stringify(info) + ")");
    try {
      while (true) {
        const state = vm.getPromiseState(handle);
        if (state.type === "fulfilled") {
          const value = vm.dump(state.value);
          state.value.dispose();
          return value;
        }
        if (state.type === "rejected") {
          state.error.dispose();
          throw new Error("音源未返回有效播放地址");
        }
        await tick();
      }
    } finally {
      handle.dispose();
    }
  } finally {
    outerSignal?.removeEventListener("abort", cancel);
    abort.abort();
    for (const timer of timers.values()) clearTimeout(timer);
    for (const reject of rejectTimers.values()) reject(new Error("Cancelled"));
    for (const controller of controllers.values()) controller.abort();
    // Let native I/O settle before disposing the WASM heap; callbacks check the abort flag.
    await Promise.allSettled([...tasks.values()]);
    try {
      for (const promise of deferred) if (promise.alive) promise.dispose();
      if (vm) vm.dispose();
      if (runtime) runtime.dispose();
    } finally {
      active--;
    }
  }
}
function normalizeMetadata(value: any, script: string): LxSourceMetadata {
  if (
    !value ||
    typeof value !== "object" ||
    !value.sources ||
    typeof value.sources !== "object"
  )
    throw new Error("音源没有声明支持的平台");
  const sources: LxSourceMetadata["sources"] = {};
  for (const platform of PLATFORMS) {
    const item = value.sources[platform];
    if (!item || typeof item !== "object") continue;
    const actions = Array.isArray(item.actions)
      ? item.actions.filter((a: any) => a === "musicUrl")
      : [];
    const qualitys = Array.isArray(item.qualitys)
      ? item.qualitys.filter((q: any) => QUALITY.includes(q))
      : [];
    if (actions.length && qualitys.length)
      sources[platform] = { actions, qualitys };
  }
  if (!Object.keys(sources).length)
    throw new Error("音源没有声明可用的 musicUrl 与 qualitys");
  const field = (name: string) => scriptField(script, name);
  return {
    name: field("name") || "LX 音源",
    version: field("version"),
    author: field("author"),
    description: field("description"),
    sources,
  };
}
function scriptField(script: string, name: string): string {
  return (
    script
      .match(new RegExp("@" + name + "[ \t]+([^\r\n]+)"))?.[1]
      ?.replace(/\*\/.*$/, "")
      .trim()
      .slice(0, 160) ?? ""
  );
}
