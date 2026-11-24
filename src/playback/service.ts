import type { RuntimeLog } from "../storage/runtime-log.ts";
import { logError } from "../storage/log-details.ts";
import type { MiotClient, PlaybackStatus } from "../miot/client.ts";
import type { MusicTrack, PlaybackResolution } from "../music/types.ts";
import type { JsonStore, StoredTrack } from "../storage/store.ts";
import { isPlaybackMode, type PlaybackMode } from "./mode.ts";
import {
  checkExecution,
  estimatedSpeechMs,
  VOICE_REPLY_WINDOW_MS,
  type ExecutionContext,
} from "../assistant/execution.ts";
import type { StoredState } from "../storage/store.ts";
import { createHash } from "node:crypto";

const queueLocks = new WeakMap<JsonStore, Map<string, Promise<void>>>();
const POLL_INTERVAL_MS = 3000;
type ResolveFirstPlayable = (
  tracks: MusicTrack[],
  signal?: AbortSignal,
) => Promise<{ index: number; resolution: PlaybackResolution }>;
type SpeechPause = {
  deviceId: string;
  track: TrackIdentity;
  accountId?: string;
  mediaId?: string;
  timer?: ReturnType<typeof setTimeout>;
};

/** Assistant and browser actions share the same per-device queue and state transitions. */
export class PlaybackService {
  private readonly store: JsonStore;
  private readonly miot: MiotClient;
  private readonly resolveTrack: (
    track: MusicTrack,
    signal?: AbortSignal,
  ) => Promise<string | PlaybackResolution>;
  private readonly scopeDeviceId?: string;
  private readonly resolveFirstPlayable?: ResolveFirstPlayable;
  private readonly logs?: RuntimeLog;
  private playbackResolution:
    | { id: string; sourceId: string; info: Omit<PlaybackResolution, "url"> }
    | undefined;
  private session:
    | {
        deviceId: string;
        track: TrackIdentity;
        startedAt: number;
        enabled: boolean;
        resumed?: boolean;
        last?: PlaybackStatus;
        estimatedEndAt?: number;
        zeroStatusSampleAt?: number;
      }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private monitoring = false;
  private checking: Promise<void> | undefined;
  private lastError = "";
  private speechPause?: SpeechPause;

  constructor(
    store: JsonStore,
    miot: MiotClient,
    resolveTrack?: (
      track: MusicTrack,
      signal?: AbortSignal,
    ) => Promise<string | PlaybackResolution>,
    scopeDeviceId?: string,
    resolveFirstPlayable?: ResolveFirstPlayable,
    logs?: RuntimeLog,
  ) {
    this.store = store;
    this.scopeDeviceId = scopeDeviceId;
    this.miot = miot;
    this.resolveFirstPlayable = resolveFirstPlayable;
    this.logs = logs;
    this.resolveTrack =
      resolveTrack ??
      (async (track) => {
        if (!track.playUrl) throw new Error("歌曲缺少播放地址");
        return track.playUrl;
      });
  }

  private config() {
    const config = this.store.snapshot().config;
    if (!this.scopeDeviceId || config.selectedDeviceId === this.scopeDeviceId)
      return config;
    return {
      ...config,
      selectedDeviceId: this.scopeDeviceId,
      playbackQueue: (Object.hasOwn(
        config.devicePlaybackQueues,
        this.scopeDeviceId,
      )
        ? config.devicePlaybackQueues[this.scopeDeviceId]
        : undefined) ?? {
        tracks: [],
        currentIndex: -1,
      },
    };
  }

  private updateStore(operation: (state: StoredState) => void) {
    return this.store.update((state) => {
      if (
        !this.scopeDeviceId ||
        state.config.selectedDeviceId === this.scopeDeviceId
      ) {
        operation(state);
        return;
      }
      const selectedQueue = state.config.playbackQueue;
      state.config.playbackQueue = Object.hasOwn(
        state.config.devicePlaybackQueues,
        this.scopeDeviceId,
      )
        ? state.config.devicePlaybackQueues[this.scopeDeviceId]
        : { tracks: [], currentIndex: -1 };
      try {
        operation(state);
        Object.defineProperty(
          state.config.devicePlaybackQueues,
          this.scopeDeviceId,
          {
            value: state.config.playbackQueue,
            enumerable: true,
            configurable: true,
            writable: true,
          },
        );
      } finally {
        state.config.playbackQueue = selectedQueue;
      }
    });
  }

  queue() {
    const queue = this.config().playbackQueue;
    return {
      currentIndex: queue.currentIndex,
      tracks: queue.tracks.map(withoutPlayUrl),
      revision: this.revision(),
    };
  }
  resolution() {
    const value = this.playbackResolution;
    const queue = this.config().playbackQueue;
    const track = queue.tracks[queue.currentIndex];
    return value && track && sameTrack(track, value)
      ? structuredClone(value.info)
      : null;
  }

  get autoPlayback() {
    return {
      active: Boolean(this.currentSession()?.enabled),
      error: this.lastError,
    };
  }

  startMonitoring() {
    this.monitoring = true;
    this.scheduleCheck();
  }

  async stopMonitoring() {
    this.cancelSpeechResume();
    this.monitoring = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.session = undefined;
    await this.checking;
  }

  private scheduleCheck() {
    if (!this.monitoring || this.timer || !this.currentSession()?.enabled)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.checkPlayback().finally(() => this.scheduleCheck());
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private currentSession() {
    const session = this.session;
    if (!session) return;
    const config = this.config();
    const track =
      config.playbackQueue.tracks[config.playbackQueue.currentIndex];
    if (
      (this.scopeDeviceId &&
        !config.devices.some(
          (device) => device.deviceId === this.scopeDeviceId,
        )) ||
      config.selectedDeviceId !== session.deviceId ||
      !track ||
      !sameTrack(track, session.track)
    ) {
      this.session = undefined;
      return;
    }
    return session;
  }

  private invalidateCheck() {
    this.cancelSpeechResume();
    if (this.session) this.session = { ...this.session };
  }

  private cancelSpeechResume() {
    if (this.speechPause?.timer) clearTimeout(this.speechPause.timer);
    this.speechPause = undefined;
  }

  async speak(
    deviceId: string,
    text: string,
    context?: ExecutionContext,
    waitForReply = false,
  ) {
    checkExecution(context);
    return this.withLock(async () => {
      checkExecution(context);
      const session = this.currentSession();
      if (
        !this.speechPause &&
        session?.enabled &&
        session.deviceId === deviceId
      ) {
        // A wake word may already have paused the decoder. The active queue
        // session records that playback was intended to continue.
        const paused = { ...session, enabled: false, last: undefined };
        this.session = paused;
        const lastSample = session.last;
        try {
          await this.miot.execute(deviceId, "pause", {});
        } catch (error) {
          if (this.session === paused) {
            this.session = session;
            this.scheduleCheck();
          }
          throw error;
        }
        if (this.session === paused) {
          this.speechPause = {
            deviceId,
            track: session.track,
            mediaId: lastSample?.mediaId,
            accountId: this.config().xiaomi?.userId,
          };
          context?.onStage?.("paused_for_speech");
        }
      }
      const pause = this.speechPause;
      if (pause?.timer) clearTimeout(pause.timer);
      // Use one reading allowance for the 1000 characters the device accepts.
      const readingMs = estimatedSpeechMs(text);
      let accepted = false;
      try {
        checkExecution(context);
        context?.onStage?.("sending");
        const result = await this.miot.execute(
          deviceId,
          "tts",
          { text },
          context?.signal,
        );
        accepted = true;
        context?.onStage?.("accepted");
        return result;
      } finally {
        if (pause && this.speechPause === pause) {
          pause.timer = setTimeout(
            () => {
              void this.resumeAfterSpeech(pause);
            },
            readingMs + (accepted && waitForReply ? VOICE_REPLY_WINDOW_MS : 0),
          );
          pause.timer.unref();
        }
      }
    });
  }

  private async resumeAfterSpeech(pause: SpeechPause) {
    await this.withLock(async () => {
      if (this.speechPause !== pause) return;
      try {
        const session = this.currentSession();
        if (
          !session ||
          !sameTrack(session.track, pause.track) ||
          this.config().xiaomi?.userId !== pause.accountId
        )
          return;
        const sample = await this.miot
          .getPlaybackStatus(pause.deviceId)
          .catch(() => null);
        if (this.speechPause !== pause || this.currentSession() !== session)
          return;
        if (
          !sample ||
          sample.status !== 2 ||
          (pause.mediaId && sample.mediaId !== pause.mediaId)
        ) {
          this.lastError = "播报后无法确认原曲可恢复，请手动继续播放";
          return;
        }
        await this.miot.execute(pause.deviceId, "resume", {});
        if (this.speechPause !== pause || this.currentSession() !== session)
          return;
        this.session = {
          ...session,
          enabled: true,
          startedAt: Date.now(),
          resumed: true,
        };
        this.lastError = "";
        this.scheduleCheck();
      } catch {
        if (this.speechPause === pause)
          this.lastError = "播报后恢复播放未确认，请查看音箱状态";
      } finally {
        if (this.speechPause === pause) this.cancelSpeechResume();
      }
    });
  }

  checkPlayback(): Promise<void> {
    if (this.checking) return this.checking;
    const pending = this.readPlayback().finally(() => {
      if (this.checking === pending) this.checking = undefined;
    });
    this.checking = pending;
    return pending;
  }

  private async readPlayback() {
    const session = this.currentSession();
    if (!session?.enabled) return;
    const sample = await this.miot
      .getPlaybackStatus(session.deviceId)
      .catch(() => null);
    if (!sample) return;
    try {
      await this.withLock(async () => {
        if (this.currentSession() !== session || !session.enabled) return;
        if (
          sample.status < 0 ||
          sample.sampledAt < session.startedAt ||
          Date.now() - sample.sampledAt > 10_000
        )
          return;
        const previous = session.last;
        if (previous && sample.sampledAt <= previous.sampledAt) return;
        if (
          previous?.mediaId &&
          sample.mediaId &&
          previous.mediaId !== sample.mediaId
        ) {
          this.session = undefined;
          return;
        }
        const config = this.config();
        const { tracks, currentIndex } = config.playbackQueue;
        let endedByDuration = false;
        if (session.estimatedEndAt !== undefined && !session.resumed) {
          // Some OH2 firmware returns idle with no progress for the entire stream.
          if (
            sample.status === 0 &&
            sample.position === 0 &&
            sample.duration === 0 &&
            !sample.mediaId &&
            !sample.title
          ) {
            if ((session.zeroStatusSampleAt ?? 0) >= sample.sampledAt) return;
            endedByDuration =
              session.zeroStatusSampleAt !== undefined &&
              sample.sampledAt >= session.estimatedEndAt;
            session.zeroStatusSampleAt = sample.sampledAt;
            if (!endedByDuration) return;
          } else {
            // Once the device reports playback evidence, trust the usual end detection.
            session.estimatedEndAt = undefined;
          }
        }
        // A play acknowledgement can precede the decoder switching away from old media.
        if (
          !endedByDuration &&
          !previous &&
          (sample.status !== 1 ||
            !sample.hasPosition ||
            (!session.resumed &&
              sample.position >
                (sample.sampledAt - session.startedAt) / 1000 + 5))
        ) {
          if (sample.sampledAt - session.startedAt > 45_000)
            this.session = undefined;
          return;
        }
        if (sample.status === 1 && !sample.hasPosition) return;
        session.last = sample;
        const duration =
          previous?.duration || tracks[currentIndex]?.durationSeconds || 0;
        if (
          !endedByDuration &&
          (!previous || !playbackEnded(previous, sample, duration))
        ) {
          if (
            (sample.status === 0 || sample.status === 3) &&
            !sample.hasPosition &&
            (previous?.status === 0 || previous?.status === 3)
          )
            this.session = undefined;
          return;
        }
        // Consume the completion before resolving or sending a command. Uncertain delivery is never retried.
        session.enabled = false;
        this.lastError = "";
        const index = nextIndex(
          config.playbackMode,
          currentIndex,
          tracks.length,
          true,
        );
        if (index < 0) {
          if (sample.status === 1 || endedByDuration)
            await this.miot.execute(session.deviceId, "stop", {});
          this.session = undefined;
          return;
        }
        await this.playIndexUnlocked(
          session.deviceId,
          index,
          undefined,
          () => this.currentSession() === session,
        );
      });
    } catch (error) {
      if (this.currentSession() === session) {
        this.logs?.detail("ERROR", "playback.advance_failed", {
          error: logError(error),
        });
        session.enabled = false;
        this.lastError = "自动续播失败，请检查音箱和音源后手动点击下一首重试";
      }
    }
  }

  async deviceControl(
    deviceId: string,
    command: Parameters<MiotClient["execute"]>[1],
    args: Parameters<MiotClient["execute"]>[2] = {},
    context?: ExecutionContext,
  ) {
    checkExecution(context);
    if (command === "tts")
      return this.speak(deviceId, args.text ?? "", context);
    if (command !== "volume") this.cancelSpeechResume();
    // Cancel a pending automatic resolution immediately, before waiting on the queue lock.
    const pendingSession = this.currentSession();
    if (command !== "volume" && pendingSession?.deviceId === deviceId) {
      this.session = { ...pendingSession, enabled: false, last: undefined };
    }
    return this.withLock(async () => {
      const session = this.currentSession();
      if (command !== "volume" && session?.deviceId === deviceId) {
        this.session =
          command === "pause" || command === "resume"
            ? { ...session, enabled: false, last: undefined }
            : undefined;
      }
      checkExecution(context);
      context?.onStage?.("sending");
      const result = await this.miot.execute(deviceId, command, args);
      context?.onStage?.("accepted");
      const paused = this.currentSession();
      if (command === "resume" && paused?.deviceId === deviceId) {
        this.session = {
          ...paused,
          enabled: true,
          startedAt: Date.now(),
          resumed: true,
        };
        this.lastError = "";
        this.scheduleCheck();
      }
      return result;
    });
  }

  async detach(deviceId: string, revision: string, isCurrent: () => boolean) {
    return this.withLock(async () => {
      if (this.revision() !== revision || !isCurrent())
        throw new Error("音箱播放已变化，请重新断开连接");
      const result = await this.miot.execute(deviceId, "stop", {});
      this.cancelSpeechResume();
      this.session = undefined;
      this.lastError = "";
      return result;
    });
  }

  async replaceAndPlay(
    deviceId: string,
    tracks: MusicTrack[],
    index = 0,
    context?: ExecutionContext,
    alternates?: MusicTrack[],
  ) {
    checkExecution(context);
    this.invalidateCheck();
    return this.withLock(() =>
      this.playIndexUnlocked(
        deviceId,
        index,
        this.prepareQueue(tracks),
        undefined,
        context,
        alternates && this.prepareQueue(alternates),
      ),
    );
  }

  async replaceQueue(tracks: MusicTrack[]) {
    this.invalidateCheck();
    await this.withLock(() => this.saveQueue(tracks));
    return this.queue();
  }

  async playIndex(deviceId: string, index: number, expected: TrackIdentity) {
    this.invalidateCheck();
    return this.withLock(() => {
      const track = this.config().playbackQueue.tracks[index];
      if (!track || !sameTrack(track, expected))
        throw new Error("播放队列已更新，请重新选择歌曲");
      return this.playIndexUnlocked(deviceId, index);
    });
  }

  async enqueue(tracks: MusicTrack[]) {
    return this.withLock(async () => {
      const additions = tracks.filter(
        (track) => track.playUrl || track.lx || track.library,
      );
      await this.updateStore((state) => {
        state.config.playbackQueue.tracks.push(
          ...additions.map((track) => ({
            ...track,
            playUrl: track.playUrl ? this.store.encrypt(track.playUrl) : "",
          })),
        );
      });
      return { added: additions.length, playbackQueue: this.queue() };
    });
  }

  async clearQueue() {
    this.invalidateCheck();
    return this.withLock(async () => {
      this.session = undefined;
      this.lastError = "";
      await this.updateStore((state) => {
        state.config.playbackQueue = { tracks: [], currentIndex: -1 };
      });
      return this.queue();
    });
  }

  async control(
    deviceId: string,
    command: "next" | "previous",
    context?: ExecutionContext,
  ) {
    checkExecution(context);
    this.invalidateCheck();
    return this.withLock(async () => {
      checkExecution(context);
      const sendNative = async () => {
        checkExecution(context);
        context?.onStage?.("sending");
        const result = await this.miot.execute(deviceId, command, {});
        context?.onStage?.("accepted");
        return result;
      };
      const { tracks, currentIndex } = this.config().playbackQueue;
      if (!tracks.length) return sendNative();
      if (currentIndex < 0)
        return command === "next"
          ? this.playIndexUnlocked(deviceId, 0, undefined, undefined, context)
          : sendNative();
      const { playbackMode } = this.config();
      let index = currentIndex;
      if (command === "previous") {
        index =
          playbackMode === "random" && tracks.length > 1
            ? randomIndex(tracks.length, currentIndex)
            : currentIndex > 0
              ? currentIndex - 1
              : playbackMode === "loop" || playbackMode === "single"
                ? tracks.length - 1
                : currentIndex;
      } else {
        index = nextIndex(playbackMode, currentIndex, tracks.length, false);
        if (index < 0)
          return { success: true, message: "播放列表已结束", completed: true };
      }
      return this.playIndexUnlocked(
        deviceId,
        index,
        undefined,
        undefined,
        context,
      );
    });
  }

  async setMode(mode: unknown) {
    if (!isPlaybackMode(mode)) throw new Error("不支持的播放模式");
    await this.updateStore((state) => {
      state.config.playbackMode = mode;
    });
    this.logs?.detail("INFO", "playback.mode_changed", { mode });
    return mode;
  }

  async toggleFavorite(track: MusicTrack) {
    if (!track.playUrl && !track.lx && !track.library)
      throw new Error("歌曲缺少播放地址");
    let favorited = false;
    await this.updateStore((state) => {
      const existing = state.config.favorites.findIndex((item) =>
        sameTrack(item, track),
      );
      if (existing >= 0) state.config.favorites.splice(existing, 1);
      else {
        state.config.favorites.unshift({
          ...track,
          playUrl: track.playUrl ? this.store.encrypt(track.playUrl) : "",
        });
        state.config.favorites = state.config.favorites.slice(0, 5000);
        favorited = true;
      }
    });
    return { favorited, favorites: this.favorites() };
  }

  async playSavedTrack(
    kind: "favorites" | "history",
    identity: TrackIdentity,
    deviceId: string,
  ) {
    this.invalidateCheck();
    return this.withLock(() => {
      const config = this.config();
      const tracks =
        kind === "favorites"
          ? config.favorites
          : config.playbackHistory.map((entry) => entry.track);
      const item = tracks.find((track) => sameTrack(track, identity));
      if (!item) throw new Error("找不到这首已保存的歌曲，请刷新列表");
      return this.playIndexUnlocked(deviceId, 0, [item]);
    });
  }

  favorites() {
    return this.config().favorites.map(withoutPlayUrl);
  }

  history() {
    return this.config().playbackHistory.map((entry) => ({
      ...entry,
      track: withoutPlayUrl(entry.track),
    }));
  }

  private async saveQueue(tracks: MusicTrack[]) {
    const prepared = this.prepareQueue(tracks);
    await this.updateStore((state) => {
      state.config.playbackQueue = { tracks: prepared, currentIndex: -1 };
    });
    this.session = undefined;
    this.lastError = "";
  }

  private prepareQueue(tracks: MusicTrack[]): StoredTrack[] {
    return tracks
      .filter((track) => track.playUrl || track.lx || track.library)
      .map((track) => ({
        ...track,
        playUrl: track.playUrl ? this.store.encrypt(track.playUrl) : "",
      }));
  }

  private async playIndexUnlocked(
    deviceId: string,
    index: number,
    replacement?: StoredTrack[],
    isCurrent?: () => boolean,
    context?: ExecutionContext,
    alternates?: StoredTrack[],
  ) {
    const tracks = replacement ?? this.config().playbackQueue.tracks;
    if (!Number.isInteger(index) || index < 0 || index >= tracks.length)
      throw new Error("队列中没有这首歌曲");
    checkExecution(context);
    let track = tracks[index];
    let resolved: string | PlaybackResolution;
    if (track.lx && alternates && this.resolveFirstPlayable) {
      context?.onStage?.("probing_song_sources");
      const candidates = [track, ...alternates];
      const winner = await this.resolveFirstPlayable(
        candidates,
        context?.signal,
      );
      track = candidates[winner.index];
      resolved = winner.resolution;
      tracks[index] = track;
    } else {
      context?.onStage?.("resolving");
      resolved = await this.resolveTrack(
        {
          ...track,
          playUrl: track.playUrl
            ? this.store.decrypt(track.playUrl)
            : undefined,
        },
        context?.signal,
      );
    }
    if (isCurrent && !isCurrent()) return;
    checkExecution(context);
    if (this.session && !isCurrent)
      this.session = { ...this.session, enabled: false, last: undefined };
    context?.onStage?.("sending");
    await this.miot.execute(
      deviceId,
      "play",
      { url: typeof resolved === "string" ? resolved : resolved.url },
      context?.signal,
      isCurrent,
    );
    const startedAt = Date.now();
    context?.onStage?.("accepted");
    await this.updateStore((state) => {
      state.config.playbackQueue = { tracks, currentIndex: index };
      state.config.playbackHistory.unshift({
        track: { ...track },
        playedAt: Date.now(),
      });
      state.config.playbackHistory = state.config.playbackHistory.slice(0, 200);
    });
    const device = this.config().devices.find(
      (item) => item.deviceId === deviceId,
    );
    const hardware = (device?.hardware || device?.model || "")
      .trim()
      .toUpperCase();
    const duration = track.durationSeconds ?? 0;
    this.session = {
      deviceId,
      track,
      startedAt,
      enabled: true,
      estimatedEndAt:
        hardware === "OH2" && Number.isFinite(duration) && duration > 0
          ? startedAt + duration * 1000
          : undefined,
    };
    this.lastError = "";
    this.scheduleCheck();
    if (typeof resolved !== "string" && resolved.sourceId) {
      const { url: _url, ...info } = resolved;
      this.playbackResolution = {
        id: track.id,
        sourceId: track.sourceId,
        info,
      };
    } else this.playbackResolution = undefined;
    this.logs?.detail("INFO", "playback.accepted", {
      title: track.title,
      artist: track.artist,
      index,
      queueLength: tracks.length,
      mode: this.config().playbackMode,
      automatic: Boolean(isCurrent),
      resolution: this.resolution(),
    });
    return {
      success: true,
      message: "正在播放《" + track.title + "》",
      track: withoutPlayUrl(track),
      resolution: this.resolution(),
    };
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let locks = queueLocks.get(this.store);
    if (!locks) {
      locks = new Map();
      queueLocks.set(this.store, locks);
    }
    const key =
      this.scopeDeviceId ?? this.store.snapshot().config.selectedDeviceId;
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    locks.set(key, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(key) === chain) locks.delete(key);
    }
  }

  revision(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.config().playbackQueue))
      .digest("hex")
      .slice(0, 24);
  }

  async editQueue(
    operation: "remove" | "move",
    index: number,
    to: number,
    revision: string,
  ) {
    return this.withLock(async () => {
      if (revision !== this.revision())
        throw new Error("播放队列已更新，请刷新后重试");
      const queue = this.config().playbackQueue;
      if (!Number.isInteger(index) || index < 0 || index >= queue.tracks.length)
        throw new Error("队列项目无效");
      if (
        operation === "move" &&
        (!Number.isInteger(to) || to < 0 || to >= queue.tracks.length)
      )
        throw new Error("队列目标位置无效");
      const current =
        queue.currentIndex >= 0 ? queue.tracks[queue.currentIndex] : null;
      if (operation === "remove" && index === queue.currentIndex)
        throw new Error("请先切换歌曲，再移除当前正在播放的曲目");
      const [item] = queue.tracks.splice(index, 1);
      if (operation === "move") queue.tracks.splice(to, 0, item);
      queue.currentIndex = current ? queue.tracks.indexOf(current) : -1;
      await this.updateStore((state) => {
        state.config.playbackQueue = queue;
      });
      return this.queue();
    });
  }
}

function withoutPlayUrl(track: StoredTrack | MusicTrack) {
  const { playUrl: _playUrl, ...publicTrack } = track;
  return publicTrack;
}

type TrackIdentity = Pick<StoredTrack, "id" | "sourceId">;

function sameTrack(left: TrackIdentity, right: TrackIdentity): boolean {
  return left.sourceId === right.sourceId && left.id === right.id;
}

function randomIndex(length: number, except: number): number {
  const candidate = Math.floor(Math.random() * (length - 1));
  return candidate >= except ? candidate + 1 : candidate;
}

function nextIndex(
  mode: PlaybackMode,
  current: number,
  length: number,
  automatic: boolean,
) {
  if (automatic && mode === "single") return current;
  if (mode === "random")
    return length > 1 ? randomIndex(length, current) : current;
  if (current + 1 < length) return current + 1;
  return mode === "loop" || mode === "single" ? 0 : -1;
}

function playbackEnded(
  previous: PlaybackStatus,
  sample: PlaybackStatus,
  duration: number,
) {
  const elapsed = (sample.sampledAt - previous.sampledAt) / 1000;
  if (
    previous.status !== 1 ||
    !previous.hasPosition ||
    previous.position <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    elapsed <= 0
  )
    return false;
  const remaining = duration - previous.position;

  // Sparse status polls can miss the last seconds. A rewound position near
  // the time predicted for a full play is evidence of a firmware repeat.
  if (elapsed > 15) {
    const timeAcrossEnd = remaining + sample.position;
    return (
      sample.status === 1 &&
      sample.hasPosition &&
      sample.position < previous.position - 1 &&
      remaining > 0 &&
      Math.abs(timeAcrossEnd - elapsed) <= 2
    );
  }
  const reachedEnd =
    remaining <= elapsed + 1 && previous.position >= Math.max(0, duration - 16);
  // Detect firmware repeating the single pushed item as well as a normal stopped-at-end report.
  const restarted =
    sample.status === 1 &&
    previous.position > sample.position + 1 &&
    sample.position <= elapsed + 1;
  const stopped =
    (sample.status === 0 || sample.status === 3) &&
    (sample.position === 0 || sample.position >= duration - 0.5);
  // L05C may reset the position and report paused at natural completion.
  const resetToPaused =
    sample.status === 2 && sample.hasPosition && sample.position === 0;
  const heldAtEnd =
    sample.status === 1 &&
    sample.hasPosition &&
    previous.position >= duration &&
    sample.position >= duration;
  return reachedEnd && (restarted || stopped || resetToPaused || heldAtEnd);
}
