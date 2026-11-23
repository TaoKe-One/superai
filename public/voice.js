const labels = {
  received: "收到语音",
  queued: "排队中",
  understanding: "理解意图",
  executing: "执行任务",
  searching: "查找内容",
  interrupting: "尝试停止小爱原生音乐",
  interrupted: "停止命令已受理，静音待确认",
  interrupt_unconfirmed: "停止原生音乐未确认，继续查找",
  selected: "已选取匹配曲目",
  resolving: "解析音源并检查音频",
  paused_for_speech: "已发送音乐暂停，准备播报",
  retrying_playlist: "首选歌单无法起播，正在查找其他相关歌单",
  sending: "发送设备命令",
  accepted: "音箱已受理，发声待确认",
  native: "保留原生处理，结果未确认",
  completed: "处理完成",
  failed: "处理失败",
  no_match: "未找到合适曲目，尚未播放",
  needs_input: "需要补充信息，尚未完成",
  waiting_reply: "已发出澄清播报，等待语音补充",
  reply_received: "带入上一轮澄清上下文",
  unconfirmed: "回执未确认，不会自动重发",
  cancelled: "后续处理已取消",
  pending: "待处理",
};
export const voiceStageLabel = (name) => labels[name] ?? name;
export function voiceMonitorSummary(enabled, devices = []) {
  if (!enabled) return "语音监听已关闭。";
  if (!devices.length) return "已开启，等待连接小米账号及带型号信息的音箱。";
  const ready = devices.filter((d) => d.lastSuccessAt && !d.lastError).length;
  const count = devices.reduce((n, d) => n + d.receivedCount, 0);
  return (
    "监听 " +
    devices.length +
    " 台音箱；" +
    ready +
    " 台最近读取正常；本次启动收到 " +
    count +
    " 条新语音。"
  );
}

export function createVoicePanel({ api, toast, root = document }) {
  const find = (id) => root.querySelector("#" + id);
  const doc = find("voiceDiagnostics").ownerDocument;
  let busy = false;
  let generation = 0;
  const node = (tag, text, className) => {
    const item = doc.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const render = (data) => {
    find("voiceMonitorStatus").textContent = voiceMonitorSummary(
      data.enabled,
      data.monitor.devices,
    );
    const devices = find("voiceDevices");
    devices.replaceChildren();
    const followUps = new Map(
      (data.followUps ?? []).map((item) => [item.deviceId, item]),
    );
    for (const device of data.monitor.devices) {
      const followUp = followUps.get(device.deviceId);
      const time = device.lastSuccessAt
        ? new Date(device.lastSuccessAt).toLocaleTimeString()
        : "尚无成功读取";
      devices.append(
        node(
          "p",
          device.name +
            " · 最近读取：" +
            time +
            (device.lastError ? " · 读取失败：" + device.lastError : "") +
            " · 新语音 " +
            device.receivedCount +
            " 条" +
            (followUp
              ? followUp.replyFrom > Date.now()
                ? " · 澄清问题已提交播报"
                : " · 等待补充，可唤醒小爱后直接回答"
              : ""),
          "footnote",
        ),
      );
    }
    const events = find("voiceEvents");
    const expanded = new Set(
      [...events.querySelectorAll("details[open]")].map(
        (item) => item.dataset.eventId,
      ),
    );
    events.replaceChildren();
    if (!data.events.length)
      events.append(
        node("p", "尚未收到新语音。开启时已有的历史记录不会执行。", "muted"),
      );
    for (const event of data.events.slice(0, 20)) {
      const item = node("details");
      item.dataset.eventId = event.id;
      item.open = expanded.has(event.id);
      item.append(
        node(
          "summary",
          event.deviceName +
            " · “" +
            event.text +
            "” · " +
            voiceStageLabel(event.status),
        ),
      );
      item.append(
        node(
          "p",
          event.stages.map((s) => voiceStageLabel(s.name)).join(" → "),
          "footnote",
        ),
      );
      for (const task of event.tasks)
        item.append(
          node(
            "p",
            (task.owner === "native" ? "小爱原生" : "平台") +
              " · " +
              task.text +
              " · " +
              voiceStageLabel(task.status) +
              (task.message && event.tasks.length > 1
                ? "：" + task.message
                : ""),
            "footnote",
          ),
        );
      if (event.message) item.append(node("p", event.message, "muted"));
      events.append(item);
    }
  };
  const refresh = async () => {
    if (busy) return;
    busy = true;
    const current = generation;
    try {
      const data = await api("/api/voice/diagnostics");
      if (current === generation) render(data);
    } catch (error) {
      if (current === generation)
        find("voiceMonitorStatus").textContent =
          "语音诊断读取失败：" + error.message;
    } finally {
      busy = false;
    }
  };
  find("refreshVoice").addEventListener("click", refresh);
  find("previewVoice").addEventListener("click", async () => {
    const text = find("voicePreviewText").value.trim();
    if (!text) return toast("请填写要分析的指令", true);
    const button = find("previewVoice");
    button.disabled = true;
    const current = generation;
    try {
      const plan = await api("/api/voice/preview", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      if (current !== generation) return;
      find("voicePreviewResult").textContent = plan.tasks
        .map(
          (task, index) =>
            index +
            1 +
            ". " +
            task.text +
            " → " +
            (task.owner === "native"
              ? "保留小爱原生处理"
              : "平台 " + task.intent.action),
        )
        .join("\n");
    } catch (error) {
      if (current === generation) toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return {
    refresh,
    reset() {
      generation++;
      find("voiceEvents").replaceChildren();
      find("voiceDevices").replaceChildren();
      find("voicePreviewResult").textContent = "";
    },
  };
}
