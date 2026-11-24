(() => {
  const page = location.pathname.startsWith("/lx/") ? "player" : "platform";
  const pending = [];
  const inFlight = new Set();
  let active = page === "player";
  let timer;
  let actionId;
  let sequence = 0;
  const session =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    while (pending.length) {
      const events = pending.splice(0, 25);
      const request = fetch("/api/system/logs/ui", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
        keepalive: true,
        signal: AbortSignal.timeout(4000),
      })
        .catch(() => undefined)
        .finally(() => inFlight.delete(request));
      inFlight.add(request);
    }
    return Promise.all(inFlight);
  }

  function append(type, fields) {
    if (!active) return;
    pending.push({
      type,
      page,
      view:
        page === "platform"
          ? document.querySelector(".view.active")?.id
          : document.querySelector("#sp-lx-catalog")?.value,
      actionId,
      at: Date.now(),
      ...fields,
    });
    if (pending.length >= 15) void flush();
    else timer ??= setTimeout(flush, 350);
  }

  function capture(event) {
    if (!active || !event.isTrusted || !(event.target instanceof Element))
      return;
    const target =
      event.target.closest(
        "button,a,summary,input,select,textarea,label,[role=button],[role=checkbox],[role=tab],[role=option],tr,[data-track-id]",
      ) ?? event.target;
    if (
      event.type === "change" &&
      target.matches("input,textarea") &&
      !target.matches(
        'input[type="checkbox"],input[type="radio"],input[type="file"],input[type="range"]',
      )
    )
      return;
    actionId = session + "-" + ++sequence;
    const label =
      target.getAttribute("aria-label") ??
      target.getAttribute("title") ??
      (target.matches("button,a,summary,[role=button],[role=tab],tr")
        ? target.textContent
        : "");
    append(event.type, {
      target: [
        target.tagName.toLowerCase(),
        target.id && "#" + target.id,
        label?.trim().replace(/\s+/gu, " ").slice(0, 140),
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 230),
    });
    // Associate requests initiated in this event's turn, never background polling.
    const current = actionId;
    setTimeout(() => {
      if (actionId === current) actionId = undefined;
    }, 0);
  }

  for (const type of ["click", "dblclick", "change", "submit"])
    document.addEventListener(type, capture, true);
  window.addEventListener(
    "error",
    (event) => {
      const resource =
        event.target instanceof Element
          ? event.target.tagName.toLowerCase()
          : undefined;
      append("error", {
        target: "browser",
        message: String(
          event.message ?? "资源加载失败 " + (resource ?? ""),
        ).slice(0, 550),
      });
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) =>
    append("error", {
      target: "promise",
      message: String(event.reason?.message ?? event.reason ?? "").slice(
        0,
        550,
      ),
    }),
  );
  window.addEventListener("pagehide", () => void flush());
  globalThis.SuperAILog = {
    enable: (enabled) => {
      active = enabled;
    },
    flush,
    headers: () => (actionId ? { "x-superai-ui-action": actionId } : {}),
    error: (message) =>
      append("error", { message: String(message ?? "").slice(0, 550) }),
  };
})();
