export function createSettings({ api, toast }) {
  const $ = (s) => document.querySelector(s);
  let providers = [],
    generation = 0;
  const result = (text, error = false) => {
    $("#aiTestResult").textContent = text;
    $("#aiTestResult").classList.toggle("player-status-error", error);
  };
  const option = (value, text) => {
    const e = document.createElement("option");
    e.value = value;
    e.textContent = text;
    return e;
  };
  const aiValue = () => ({
    provider: $("#aiProvider").value,
    baseUrl: $("#aiBaseUrl").value.trim(),
    model: $("#aiModel").value.trim(),
    apiKey: $("#aiKey").value,
    clearApiKey: $("#clearAiKey").checked,
  });
  const invalidate = () => {
    generation++;
    result("");
    $("#aiModelList").replaceChildren(
      option("", "获取后选择模型，也可手动填写"),
    );
  };
  $("#aiProvider").addEventListener("change", () => {
    const preset = providers.find((p) => p.id === $("#aiProvider").value);
    $("#aiBaseUrl").value = preset?.baseUrl || "";
    $("#aiKey").value = "";
    $("#aiKey").placeholder = "服务已切换，请填写对应密钥";
    $("#aiModel").value = preset?.defaultModel || "";
    $("#clearAiKey").checked = false;
    invalidate();
  });
  for (const id of ["aiBaseUrl", "aiKey", "aiModel", "clearAiKey"])
    $("#" + id).addEventListener("input", () => {
      generation++;
      result("");
    });
  $("#aiModelList").addEventListener("change", () => {
    if ($("#aiModelList").value) $("#aiModel").value = $("#aiModelList").value;
    generation++;
    result("");
  });
  async function run(button, kind) {
    const current = ++generation;
    button.disabled = true;
    result(kind === "models" ? "正在获取模型列表…" : "正在测试，请稍候…");
    try {
      const data = await api(
        "/api/ai/" + (kind === "models" ? "models" : "test"),
        {
          method: "POST",
          body: JSON.stringify({ ai: aiValue(), search: kind === "search" }),
        },
      );
      if (current !== generation) return;
      if (kind === "models") {
        $("#aiModelList").replaceChildren(
          option("", "请选择可用模型"),
          ...data.models.map((m) => option(m, m)),
        );
        result(
          "取得 " +
            data.models.length +
            " 个模型。选择后请测试；列表不代表模型都能调用。",
        );
      } else result(data.message + "（" + data.latencyMs + " ms）");
    } catch (error) {
      if (current === generation) result(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
  $("#fetchModels").addEventListener("click", (e) =>
    run(e.currentTarget, "models"),
  );
  $("#testModel").addEventListener("click", (e) =>
    run(e.currentTarget, "intent"),
  );
  $("#testModelSearch").addEventListener("click", (e) =>
    run(e.currentTarget, "search"),
  );
  const field = (root, key, label, value = "", type = "text") => {
    const wrap = document.createElement("label");
    wrap.className = "library-field";
    const title = document.createElement("span");
    title.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.dataset.field = key;
    if (type === "password") input.autocomplete = "new-password";
    wrap.append(title, input);
    root.append(wrap);
    return input;
  };
  function addLibrary(c = {}) {
    const root = document.createElement("section");
    root.className = "library-config";
    root.dataset.id = c.id || "";
    const grid = document.createElement("div");
    grid.className = "library-fields";
    field(grid, "name", "音乐库名称", c.name || "");
    const wrap = document.createElement("label");
    wrap.className = "library-field";
    wrap.textContent = "服务类型";
    const type = document.createElement("select");
    type.dataset.field = "type";
    type.setAttribute("aria-label", "服务类型");
    type.append(
      option("subsonic", "Subsonic / Navidrome"),
      option("webdav", "WebDAV 文件音乐库"),
      option("feiniu", "飞牛音乐（兼容适配）"),
    );
    type.value = c.type || "subsonic";
    wrap.append(type);
    grid.append(wrap);
    const address = field(
      grid,
      "baseUrl",
      "服务地址 / WebDAV 音乐根目录",
      c.baseUrl || "",
      "url",
    );
    address.placeholder = "http://192.168.1.10:4533";
    field(grid, "username", "用户名", c.username || "");
    const password = field(grid, "password", "密码", "", "password");
    password.placeholder = c.passwordSet
      ? "已保存；留空保留，同服务同账号时有效"
      : "服务密码";
    const access = field(
      grid,
      "accessCode",
      "飞牛网关访问码（可选）",
      "",
      "password",
    );
    access.placeholder = c.accessCodeSet
      ? "已保存；留空保留"
      : "局域网一般无需填写";
    access.parentElement.hidden = type.value !== "feiniu";
    type.addEventListener("change", () => {
      access.parentElement.hidden = type.value !== "feiniu";
      password.value = "";
      access.value = "";
    });
    const controls = document.createElement("div");
    controls.className = "row";
    const enabled = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = c.enabled !== false;
    checkbox.dataset.field = "enabled";
    enabled.append(checkbox, " 启用");
    controls.append(enabled);
    const note = document.createElement("p");
    note.className = "footnote";
    note.setAttribute("role", "status");
    const scanNote = document.createElement("p");
    scanNote.className = "footnote";
    scanNote.setAttribute("role", "status");
    scanNote.dataset.scanStatus = "true";
    let revision = 0;
    grid.addEventListener("input", () => {
      revision++;
      note.textContent = "";
    });
    grid.addEventListener("change", () => {
      revision++;
      note.textContent = "";
    });
    const button = (label, action) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = label;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await action();
        } catch (e) {
          note.textContent = e.message;
        } finally {
          b.disabled = false;
        }
      });
      controls.append(b);
      return b;
    };
    button("测试连接", async () => {
      const current = revision;
      note.textContent = "正在测试…";
      const r = await api("/api/music/services/test", {
        method: "POST",
        body: JSON.stringify({ library: readLibrary(root) }),
      });
      if (current === revision) note.textContent = r.message;
    });
    const scanButton = button("扫描 WebDAV", async () => {
      if (!root.dataset.id || type.value !== "webdav")
        throw new Error("请先保存 WebDAV 配置，再开始扫描");
      const draft = readLibrary(root);
      if (
        draft.type !== c.type ||
        draft.baseUrl !== c.baseUrl ||
        draft.username !== c.username ||
        draft.password ||
        draft.accessCode ||
        draft.enabled !== c.enabled
      )
        throw new Error("音乐库配置已修改，请先保存再扫描");
      await api("/api/music/services/scan", {
        method: "POST",
        body: JSON.stringify({ id: root.dataset.id }),
      });
      scanNote.textContent = "扫描已开始，索引完整后替换旧版本。";
    });
    const stopButton = button("停止扫描", async () => {
      if (!root.dataset.id) return;
      await api("/api/music/services/scan/stop", {
        method: "POST",
        body: JSON.stringify({ id: root.dataset.id }),
      });
      scanNote.textContent = "已请求停止，旧索引保留。";
    });
    button("移除", async () => root.remove());
    const showScanButtons = () => {
      scanButton.hidden = stopButton.hidden = type.value !== "webdav";
    };
    type.addEventListener("change", showScanButtons);
    showScanButtons();
    root.append(grid, controls, note, scanNote);
    $("#libraryConfigs").append(root);
  }
  function readLibrary(root) {
    const get = (key) => root.querySelector('[data-field="' + key + '"]');
    return {
      id: root.dataset.id,
      name: get("name").value,
      type: get("type").value,
      baseUrl: get("baseUrl").value,
      username: get("username").value,
      password: get("password").value,
      accessCode: get("accessCode").value,
      enabled: get("enabled").checked,
    };
  }
  $("#addLibrary").addEventListener("click", () => {
    addLibrary();
    if (!["private", "hybrid"].includes($("#musicServiceMode").value))
      $("#musicServiceMode").value = "private";
  });
  let polling = false;
  setInterval(async () => {
    if (
      polling ||
      !document.querySelector("#view-settings.active") ||
      document.querySelector("#appView.hidden")
    )
      return;
    polling = true;
    try {
      const statuses = await api("/api/music/services/scan/status");
      for (const entry of statuses) {
        const row = [...$("#libraryConfigs").children].find(
          (r) => r.dataset.id === entry.id,
        );
        if (!row || (entry.state === "idle" && !entry.scannedAt)) continue;
        row.querySelector("[data-scan-status]").textContent =
          entry.error ||
          ({
            running: "正在扫描",
            done: "扫描完成",
            cancelled: "扫描已停止",
            failed: "扫描失败",
            idle: "已有索引",
          }[entry.state] || entry.state) +
            " · " +
            entry.count +
            " 首" +
            (entry.warnings
              ? "；" + entry.warnings + " 首使用文件名或未完整读取标签"
              : "");
      }
    } catch {
    } finally {
      polling = false;
    }
  }, 2500);
  return {
    async render(status) {
      generation++;
      if (!providers.length)
        try {
          providers = (await api("/api/ai/providers")).providers;
        } catch (e) {
          toast(e.message, true);
        }
      $("#aiProvider").replaceChildren(
        ...providers.map((p) => option(p.id, p.name)),
      );
      $("#aiProvider").value = status.ai.provider || "custom";
      $("#searchMode").value = status.webSearch.mode || "auto";
      $("#musicServiceMode").value = status.musicServices.mode;
      $("#gatewayBaseUrl").value = status.musicServices.gatewayBaseUrl;
      $("#libraryConfigs").replaceChildren();
      status.musicServices.libraries.forEach(addLibrary);
      result("");
    },
    values() {
      return {
        ai: aiValue(),
        webSearch: {
          mode: $("#searchMode").value,
          apiKey: $("#searchKey").value,
          clearApiKey: $("#clearSearchKey").checked,
        },
        musicServices: {
          mode: $("#musicServiceMode").value,
          gatewayBaseUrl: $("#gatewayBaseUrl").value,
          libraries: [...$("#libraryConfigs").children].map(readLibrary),
        },
      };
    },
  };
}
