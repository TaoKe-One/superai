import { createHash } from "node:crypto";
import type { MiotActionDelivery } from "../miot/speech.ts";
import { UnderstandingAgent, type PlannedTask } from "./planner.ts";
import {
  ExecutionAgent,
  estimatedSpeechMs,
  VOICE_REPLY_WINDOW_MS,
  type ExecutionStage,
} from "./execution.ts";
import type { ConversationTurn } from "./types.ts";
import { DeviceCommandError } from "../miot/client.ts";
import { LxResolutionError } from "../music/lx/health.ts";

const HISTORY_MS = 2 * 60_000;
type ListenStatus = MiotActionDelivery | "pending" | "unavailable";
type VoiceHistory = {
  turns: ConversationTurn[];
  expiresAt: number;
  replyFrom?: number;
  listenStatus?: ListenStatus;
  wakeController?: AbortController;
};

export interface VoiceEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  text: string;
  timestamp: number;
  status:
    | "queued"
    | "understanding"
    | "executing"
    | "native"
    | "completed"
    | "accepted"
    | "failed"
    | "unconfirmed"
    | "no_match"
    | "needs_input"
    | "cancelled";
  tasks: Array<PlannedTask & { status: string; message?: string }>;
  stages: Array<{ name: string; at: number; task?: number }>;
  message: string;
}

export class VoiceCoordinator {
  private readonly understand: (deviceId: string) => UnderstandingAgent;
  private readonly executor: ExecutionAgent;
  private readonly onResult?: (status: VoiceEvent["status"]) => void;
  private readonly events: VoiceEvent[] = [];
  private readonly jobs = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly histories = new Map<string, VoiceHistory>();
  private readonly wakeForReply?: (
    deviceId: string,
    signal: AbortSignal,
  ) => Promise<MiotActionDelivery | "unavailable">;
  private readonly seen = new Set<string>();
  private stopped = false;

  constructor(
    understand: (deviceId: string) => UnderstandingAgent,
    executor: ExecutionAgent,
    onResult?: (status: VoiceEvent["status"]) => void,
    wakeForReply?: VoiceCoordinator["wakeForReply"],
  ) {
    this.understand = understand;
    this.executor = executor;
    this.onResult = onResult;
    this.wakeForReply = wakeForReply;
  }

  snapshot() {
    return structuredClone(this.events);
  }

  waitingForReplies() {
    return [...this.histories].flatMap(([deviceId, history]) =>
      this.isWaitingForReply(deviceId)
        ? [
            {
              deviceId,
              replyFrom: history.replyFrom,
              expiresAt: history.expiresAt,
              listenStatus: history.listenStatus,
            },
          ]
        : [],
    );
  }

  isWaitingForReply(deviceId: string) {
    const history = this.histories.get(deviceId);
    return history?.replyFrom !== undefined && history.expiresAt > Date.now();
  }

  submit(
    device: { deviceId: string; name: string },
    text: string,
    timestamp: number,
  ) {
    if (this.stopped) return;
    const id = createHash("sha256")
      .update(JSON.stringify([device.deviceId, timestamp, text]))
      .digest("hex")
      .slice(0, 32);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 2000)
      this.seen.delete(this.seen.values().next().value!);
    const event: VoiceEvent = {
      id,
      deviceId: device.deviceId,
      deviceName: device.name,
      text,
      timestamp,
      status: "queued",
      tasks: [],
      stages: [{ name: "received", at: Date.now() }],
      message: "已收到语音文本",
    };
    this.events.unshift(event);
    this.events.length = Math.min(this.events.length, 100);
    this.histories.get(device.deviceId)?.wakeController?.abort();
    const previous = this.jobs.get(device.deviceId);
    previous?.controller.abort();
    const controller = new AbortController();
    // Wait for an already submitted device operation before the next device task.
    const done = (previous?.done ?? Promise.resolve())
      .then(() => this.run(event, controller.signal))
      .catch(() => {
        event.status = "failed";
        event.message = "语音任务未完成";
      })
      .finally(() => {
        this.onResult?.(event.status);
        if (this.jobs.get(device.deviceId)?.controller === controller)
          this.jobs.delete(device.deviceId);
      });
    this.jobs.set(device.deviceId, { controller, done });
  }

  cancelAll(clearRecords = false) {
    if (clearRecords) {
      this.events.length = 0;
      this.seen.clear();
    }
    for (const job of this.jobs.values()) job.controller.abort();
    for (const history of this.histories.values())
      history.wakeController?.abort();
    this.histories.clear();
  }

  retainDevices(ids: Set<string>) {
    for (const [id, job] of this.jobs) if (!ids.has(id)) job.controller.abort();
    for (const [id, history] of this.histories)
      if (!ids.has(id)) {
        history.wakeController?.abort();
        this.histories.delete(id);
      }
  }

  async stop() {
    this.stopped = true;
    this.cancelAll();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }

  private wakeAfterPrompt(
    deviceId: string,
    history: VoiceHistory,
    stage: (name: string) => void,
  ) {
    const wake = this.wakeForReply;
    if (!wake || history.replyFrom === undefined) return;
    const controller = new AbortController();
    history.wakeController = controller;
    history.listenStatus = "pending";
    const timer = setTimeout(
      async () => {
        const remaining = history.expiresAt - Date.now();
        if (controller.signal.aborted || remaining <= 0) return;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(remaining),
        ]);
        const status = await wake(deviceId, signal).catch(
          () => "unconfirmed" as const,
        );
        if (signal.aborted || this.histories.get(deviceId) !== history) return;
        history.listenStatus = status;
        stage(
          status === "accepted" ? "reply_wake_accepted" : "reply_manual_wake",
        );
      },
      Math.max(0, history.replyFrom - Date.now()),
    );
    timer.unref();
    controller.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
  }

  private async run(event: VoiceEvent, signal: AbortSignal) {
    let sending = false;
    let accepted = false;
    let index = -1;
    const stage = (name: string, task = index) => {
      event.stages.push({
        name,
        at: Date.now(),
        ...(task >= 0 ? { task } : {}),
      });
      if (event.stages.length > 40) event.stages.shift();
    };
    try {
      signal.throwIfAborted();
      event.status = "understanding";
      stage("understanding");
      const prior = this.histories.get(event.deviceId);
      const history =
        prior && prior.expiresAt > Date.now() ? [...prior.turns] : [];
      if (prior?.replyFrom !== undefined) {
        delete prior.replyFrom;
        if (history.length) stage("reply_received");
      }
      const plan = await this.understand(event.deviceId).plan(
        event.text,
        history,
        signal,
      );
      signal.throwIfAborted();
      event.tasks = plan.tasks.map((task) => ({ ...task, status: "pending" }));
      for (index = 0; index < event.tasks.length; index++) {
        signal.throwIfAborted();
        const task = event.tasks[index];
        if (task.owner === "native") {
          task.status = "native";
          task.message = "保留原生处理；平台未确认原生执行结果";
          stage("native");
          continue;
        }
        sending = false;
        accepted = false;
        event.status = "executing";
        task.status = "executing";
        stage("executing");
        const result = await this.executor.run(task.intent, task.text, {
          deviceId: event.deviceId,
          origin: "voice",
          signal,
          onStage: (name: ExecutionStage) => {
            if (name === "sending") sending = true;
            if (name === "accepted") accepted = true;
            task.status = name;
            stage(name);
          },
        });
        task.message =
          typeof result.message === "string"
            ? result.message.slice(0, 1000)
            : "处理完成";
        task.status =
          result.executionStatus === "no_match" ||
          result.executionStatus === "needs_input" ||
          result.executionStatus === "failed"
            ? result.executionStatus
            : result.speechError
              ? "unconfirmed"
              : task.intent.action === "clarify"
                ? "needs_input"
                : accepted
                  ? "accepted"
                  : "completed";
        if (!signal.aborted && !result.speechError && !result.modelError) {
          history.push(
            { role: "user", content: task.text },
            { role: "assistant", content: task.message },
          );
          const now = Date.now();
          let replyFrom: number | undefined;
          if (
            accepted &&
            typeof result.spokenPrompt === "string" &&
            task.status === "needs_input"
          ) {
            // Cloud receipt has no speech-completion callback. Include a reading
            // allowance so that waiting time is available after a longer prompt.
            replyFrom = now + estimatedSpeechMs(result.spokenPrompt);
            stage("waiting_reply");
          }
          this.histories.get(event.deviceId)?.wakeController?.abort();
          const currentHistory = {
            turns: history.slice(-12),
            expiresAt:
              replyFrom === undefined
                ? now + HISTORY_MS
                : replyFrom + VOICE_REPLY_WINDOW_MS,
            replyFrom,
          };
          this.histories.set(event.deviceId, currentHistory);
        }
      }
      const followUp = this.histories.get(event.deviceId);
      if (!signal.aborted && followUp?.replyFrom !== undefined) {
        const promptTask = event.tasks.findLastIndex(
          (task) => task.status === "needs_input",
        );
        this.wakeAfterPrompt(event.deviceId, followUp, (name) =>
          stage(name, promptTask),
        );
      }
      event.status = event.tasks.some((task) => task.status === "failed")
        ? "failed"
        : event.tasks.some((task) => task.status === "no_match")
          ? "no_match"
          : event.tasks.some((task) => task.status === "needs_input")
            ? "needs_input"
            : event.tasks.some((task) => task.status === "unconfirmed")
              ? "unconfirmed"
              : event.tasks.some((task) => task.status === "accepted")
                ? "accepted"
                : event.tasks.every((task) => task.owner === "native")
                  ? "native"
                  : "completed";
      event.message = event.tasks
        .map((task) => task.message)
        .filter(Boolean)
        .join("；");
      if (event.stages.at(-1)?.name !== event.status) stage(event.status);
    } catch (error) {
      event.status =
        error instanceof DeviceCommandError && error.delivery === "rejected"
          ? "failed"
          : sending && !accepted
            ? "unconfirmed"
            : signal.aborted
              ? "cancelled"
              : "failed";
      event.message =
        event.status === "unconfirmed"
          ? "设备命令已发送，结果未确认；不会自动重发"
          : event.status === "cancelled"
            ? "已取消后续处理；已经受理的设备动作无法撤销"
            : error instanceof DeviceCommandError &&
                error.delivery === "rejected"
              ? "音箱明确拒绝该操作；不会自动重发"
              : error instanceof LxResolutionError
                ? "已找到曲目，但音源未通过播放前检查，尚未投放音箱"
                : "处理失败，请检查模型、音乐源和设备连接";
      if (event.tasks[index]) {
        event.tasks[index].status = event.status;
        event.tasks[index].message = event.message;
      }
      for (const task of event.tasks)
        if (task.status === "pending") task.status = "cancelled";
      stage(event.status);
    }
  }
}
