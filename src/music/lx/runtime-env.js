// Evaluated inside QuickJS, never as a Node module. No Node objects cross this boundary.
(() => {
  const listeners = new Map();
  const parse = (value) => JSON.parse(value);
  const sync = (name, ...args) => parse(__lxSync(name, JSON.stringify(args)));
  const bytes = (value) => Uint8Array.from(value);
  let initialized = false;
  globalThis.console = Object.freeze({
    log() {},
    warn() {},
    error() {},
    info() {},
    debug() {},
  });
  globalThis.setTimeout = (callback, ms = 0, ...args) => {
    const id = __lxTimer(Math.min(Math.max(Number(ms) || 0, 0), 15000));
    __lxWait(id)
      .then(() => callback(...args))
      .catch(() => {});
    return id;
  };
  globalThis.clearTimeout = (id) => __lxCancelTimer(id);
  globalThis.lx = Object.freeze({
    EVENT_NAMES: Object.freeze({
      request: "request",
      inited: "inited",
      updateAlert: "updateAlert",
    }),
    version: "2.0.0",
    env: "desktop",
    currentScriptInfo: __lxInfo,
    on(event, callback) {
      if (event !== "request" || typeof callback !== "function")
        throw new Error("Unsupported event");
      listeners.set(event, callback);
      return Promise.resolve();
    },
    async send(event, data) {
      if (event === "updateAlert") return;
      if (event !== "inited" || initialized)
        throw new Error("Invalid initialization");
      initialized = true;
      __lxReady(JSON.stringify(data));
    },
    request(url, options, callback) {
      const id = __lxHttp(String(url), JSON.stringify(options || {}));
      __lxWait(id).then(
        (raw) => {
          const response = parse(raw);
          response.raw = bytes(response.raw);
          callback(null, response, response.body);
        },
        () => callback(new Error("Music source request failed"), null, null),
      );
      return () => __lxAbort(id);
    },
    utils: Object.freeze({
      buffer: Object.freeze({
        from(value, encoding) {
          return bytes(
            sync(
              "bufferFrom",
              ArrayBuffer.isView(value) ? Array.from(value) : value,
              encoding,
            ),
          );
        },
        bufToString(value, encoding) {
          return sync("bufferString", Array.from(value), encoding);
        },
      }),
      crypto: Object.freeze({
        md5: (value) =>
          sync("md5", ArrayBuffer.isView(value) ? Array.from(value) : value),
        randomBytes: (size) => bytes(sync("randomBytes", size)),
        aesEncrypt: (value, mode, key, iv) =>
          bytes(
            sync(
              "aesEncrypt",
              Array.from(value),
              mode,
              typeof key === "string" ? key : Array.from(key),
              typeof iv === "string" ? iv : Array.from(iv),
            ),
          ),
        rsaEncrypt: (value, key) =>
          bytes(sync("rsaEncrypt", Array.from(value), key)),
      }),
      zlib: Object.freeze({
        inflate: async (value) => bytes(sync("inflate", Array.from(value))),
        deflate: async (value) => bytes(sync("deflate", Array.from(value))),
      }),
    }),
  });
  globalThis.__lxDispatch = async (info) => {
    const listener = listeners.get("request");
    if (!listener) throw new Error("Missing request listener");
    return listener(info);
  };
})();
