// One generation owns its requests, timer, and UI callbacks. Late responses are ignored.
export function createQrLogin({ request, onState, onConnected, onError, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0;
  let loginId = null;
  let controller = null;
  let timer = null;

  const stop = () => {
    generation++;
    controller?.abort();
    controller = null;
    if (timer !== null) clearTimer(timer);
    timer = null;
    const previousId = loginId;
    loginId = null;
    if (previousId) {
      void request("/api/miot/qrcode/cancel", {
        method: "POST", body: JSON.stringify({ loginId: previousId }),
      }).catch(() => {});
    }
  };

  const poll = async (owner, id, signal) => {
    if (owner !== generation) return;
    let retryAfterMs = 900;
    try {
      const data = await request("/api/miot/qrcode/poll", {
        method: "POST", body: JSON.stringify({ loginId: id }), signal,
      });
      if (owner !== generation) return;
      if (Number.isFinite(data.retryAfterMs)) retryAfterMs = Math.max(900, Math.min(15_000, data.retryAfterMs));
      onState(data);
      if (data.state === "connected") {
        loginId = null;
        try { await onConnected(() => owner === generation); }
        catch (error) { if (owner === generation) onError(error); }
        return;
      }
      if (data.state === "expired") { loginId = null; return; }
    } catch (error) {
      if (owner !== generation) return;
      if (error.status === 401) {
        stop();
        onState({ state: "expired", message: "管理会话已过期，请重新登录后扫码" });
        onError(error);
        return;
      }
      onState({ state: "waiting", message: "扫码状态读取失败，正在重试：" + error.message });
      retryAfterMs = 2000;
    }
    if (owner === generation) timer = setTimer(() => { timer = null; return poll(owner, id, signal); }, retryAfterMs);
  };

  return {
    async start() {
      stop();
      const owner = generation;
      controller = new AbortController();
      const signal = controller.signal;
      onState({ state: "creating", message: "正在生成二维码…" });
      try {
        const data = await request("/api/miot/qrcode", { method: "POST", body: "{}", signal });
        if (owner !== generation) {
          // The server may have finished creation despite the browser aborting.
          if (data.loginId) void request("/api/miot/qrcode/cancel", { method: "POST", body: JSON.stringify({ loginId: data.loginId }) }).catch(() => {});
          return;
        }
        loginId = data.loginId;
        onState({ ...data, state: "waiting", message: "请使用小米手机扫码，并在手机上确认登录。" });
        void poll(owner, loginId, signal);
      } catch (error) {
        if (owner !== generation) return;
        onState({ state: "expired", message: "二维码生成失败：" + error.message });
        onError(error);
      }
    },
    cancel() {
      stop();
      onState({ state: "cancelled" });
    },
  };
}
