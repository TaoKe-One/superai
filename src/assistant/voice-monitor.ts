import type { MiotClient } from "../miot/client.ts";
import type { JsonStore, MiotDevice } from "../storage/store.ts";

type MonitorTarget = Pick<MiotDevice, "deviceId" | "hardware" | "name">;
interface DeviceMonitor {
  device: MonitorTarget;
  timer?: ReturnType<typeof setTimeout>;
  watermark: number;
  processed: Set<string>;
  primed: boolean;
  busy: boolean;
  retryDelay: number;
  idleDelay: number;
  lastError: string;
  lastSuccessAt: number;
  lastReceivedAt: number;
  receivedCount: number;
}

/** Independent cloud-record cursors; this does not capture microphones or intercept firmware. */
export class VoiceConversationMonitor {
  private readonly store: JsonStore;
  private readonly miot: MiotClient;
  private readonly onUtterance: (
    device: MonitorTarget,
    text: string,
    timestamp: number,
  ) => Promise<void>;
  private readonly intervalMs: number;
  private readonly waitingForReply: (deviceId: string) => boolean;
  private readonly onPollError?: (device: MonitorTarget, error: string) => void;
  private readonly targets = new Map<string, DeviceMonitor>();
  private activePolls = 0;
  private accountId = "";

  constructor(
    store: JsonStore,
    miot: MiotClient,
    onUtterance: (
      device: MonitorTarget,
      text: string,
      timestamp: number,
    ) => Promise<void>,
    intervalMs = 2000,
    waitingForReply: (deviceId: string) => boolean = () => false,
    onPollError?: VoiceConversationMonitor["onPollError"],
  ) {
    this.store = store;
    this.miot = miot;
    this.onUtterance = onUtterance;
    this.intervalMs = Math.max(250, intervalMs);
    this.waitingForReply = waitingForReply;
    this.onPollError = onPollError;
  }

  get isActive() {
    return this.targets.size > 0;
  }
  get deviceIds() {
    return new Set(this.targets.keys());
  }
  get status() {
    const devices = [...this.targets.values()].map((target) => ({
      deviceId: target.device.deviceId,
      name: target.device.name,
      primed: target.primed,
      lastError: target.lastError,
      lastSuccessAt: target.lastSuccessAt,
      lastReceivedAt: target.lastReceivedAt,
      receivedCount: target.receivedCount,
    }));
    return {
      active: this.isActive,
      devices,
      lastError: devices
        .filter((d) => d.lastError)
        .map((d) => d.name + "：" + d.lastError)
        .join("；"),
      lastSuccessAt: Math.max(0, ...devices.map((d) => d.lastSuccessAt)),
    };
  }

  sync() {
    const config = this.store.snapshot().config;
    const accountId = config.xiaomi?.userId ?? "";
    if (accountId !== this.accountId) {
      this.stop();
      this.accountId = accountId;
    }
    const devices =
      config.voiceMonitorEnabled && config.xiaomi
        ? config.devices.filter((device) => device.hardware).slice(0, 32)
        : [];
    const ids = new Set(devices.map((device) => device.deviceId));
    for (const [id, target] of this.targets) {
      if (
        !ids.has(id) ||
        !devices.some(
          (d) => d.deviceId === id && d.hardware === target.device.hardware,
        )
      ) {
        if (target.timer) clearTimeout(target.timer);
        this.targets.delete(id);
      }
    }
    for (const device of devices) {
      const existing = this.targets.get(device.deviceId);
      if (existing) {
        existing.device = device;
        continue;
      }
      const target: DeviceMonitor = {
        device,
        watermark: 0,
        processed: new Set(),
        primed: false,
        busy: false,
        retryDelay: 0,
        idleDelay: 0,
        lastError: "",
        lastSuccessAt: 0,
        lastReceivedAt: 0,
        receivedCount: 0,
      };
      this.targets.set(device.deviceId, target);
      this.schedule(target, 0);
    }
  }

  stop() {
    for (const target of this.targets.values())
      if (target.timer) clearTimeout(target.timer);
    this.targets.clear();
  }

  private current(target: DeviceMonitor) {
    return this.targets.get(target.device.deviceId) === target;
  }
  private schedule(target: DeviceMonitor, delay: number) {
    if (!this.current(target) || target.timer) return;
    target.timer = setTimeout(() => {
      target.timer = undefined;
      void this.poll(target);
    }, delay);
    target.timer.unref();
  }

  private async poll(target: DeviceMonitor) {
    if (!this.current(target) || target.busy) return;
    if (this.activePolls >= 3) {
      this.schedule(target, this.intervalMs);
      return;
    }
    target.busy = true;
    this.activePolls++;
    try {
      const result = await this.miot.getLatestQuestions(
        target.device.deviceId,
        target.device.hardware,
        10,
      );
      if (!this.current(target)) return;
      target.retryDelay = 0;
      target.lastError = "";
      target.lastSuccessAt = Date.now();
      const messages = [...result.messages].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      if (!target.primed) {
        target.watermark = Math.max(
          0,
          ...messages.map((message) => message.timestamp),
        );
        for (const message of messages)
          if (message.timestamp === target.watermark)
            target.processed.add(messageKey(message.timestamp, message.text));
        target.primed = true;
        return;
      }
      const fresh = messages.filter(
        (m) =>
          m.timestamp > target.watermark ||
          (m.timestamp === target.watermark &&
            !target.processed.has(messageKey(m.timestamp, m.text))),
      );
      target.idleDelay = fresh.length
        ? 0
        : Math.min(
            Math.max(2000, this.intervalMs),
            Math.max(
              this.intervalMs,
              target.idleDelay ? target.idleDelay * 2 : this.intervalMs * 2,
            ),
          );
      for (const message of fresh) {
        if (!this.current(target)) return;
        await this.onUtterance(target.device, message.text, message.timestamp);
        if (!this.current(target)) return;
        target.lastReceivedAt = Date.now();
        target.receivedCount++;
        if (message.timestamp > target.watermark) {
          target.watermark = message.timestamp;
          target.processed.clear();
        }
        target.processed.add(messageKey(message.timestamp, message.text));
      }
    } catch (error) {
      if (!this.current(target)) return;
      const message = (
        error instanceof Error ? error.message : "对话读取失败"
      ).slice(0, 160);
      if (target.lastError !== message)
        this.onPollError?.(target.device, message);
      target.lastError = message;
      target.retryDelay = Math.min(
        30_000,
        Math.max(
          this.intervalMs,
          target.retryDelay ? target.retryDelay * 2 : this.intervalMs * 2,
        ),
      );
    } finally {
      target.busy = false;
      this.activePolls--;
      this.schedule(
        target,
        target.retryDelay ||
          (this.waitingForReply(target.device.deviceId)
            ? Math.min(1000, this.intervalMs)
            : target.idleDelay || this.intervalMs),
      );
    }
  }
}

function messageKey(timestamp: number, text: string) {
  return timestamp + ":" + text;
}
