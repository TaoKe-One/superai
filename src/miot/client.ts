import { createHash, randomBytes } from "node:crypto";
import type { JsonStore, MiotDevice, StoredState } from "../storage/store.ts";
import { musicPlaybackRequest } from "./playback.ts";
import {
  miotSpeechAction,
  playMiotText,
  type SpeechCredentials,
} from "./speech.ts";

const ACCOUNT = "https://account.xiaomi.com";
const MINA = "https://api2.mina.mi.com";
const USERPROFILE = "https://userprofile.mina.mi.com";
const USER_AGENT =
  "Android-7.1.1-1.0.0-ONEPLUS A3010-136-SpeakerPlatform APP/xiaomi.smarthome APPV/62830";
const QR_TTL_MS = 5 * 60 * 1000;
const MAX_LOGIN_SESSIONS = 8;

export class DeviceCommandError extends Error {
  readonly delivery: "rejected" | "unconfirmed";
  constructor(message: string, delivery: "rejected" | "unconfirmed") {
    super(message);
    this.name = "DeviceCommandError";
    this.delivery = delivery;
  }
}

interface LoginSession {
  deviceId: string;
  pollUrl: string;
  cookies: Map<string, string>;
  expiresAt: number;
  pollPromise?: Promise<LoginPollResult>;
  confirmed?: { passToken: string; userId: string; cUserId: string };
  connected?: boolean;
  failures?: number;
}

interface LoginPollResult {
  state: "waiting" | "connected" | "expired";
  message: string;
  retryAfterMs?: number;
}

interface XiaomiCredentials {
  userId: string;
  passToken: string;
  cUserId: string;
  serviceToken: string;
  serviceTokenExpiresAt: number;
}

interface SpeechAuthorization {
  accountKey: string;
  credentials: SpeechCredentials;
  devices: Map<string, string>;
  preparedAt: number;
}

export interface PlaybackStatus {
  status: number;
  position: number;
  duration: number;
  volume?: number;
  sampledAt: number;
  hasPosition?: boolean;
  mediaId?: string;
  title?: string;
  artist?: string;
  album?: string;
}

export class MiotClient {
  private readonly store: JsonStore;
  private readonly fetchImpl: typeof fetch;
  private readonly playbackUrl?: (url: string) => string;
  private readonly logins = new Map<string, LoginSession>();
  private readonly playbackStatusCache = new Map<
    string,
    { sampledAt: number; revision: number; value: PlaybackStatus }
  >();
  private readonly playbackStatusRequests = new Map<
    string,
    { revision: number; promise: Promise<PlaybackStatus> }
  >();
  private readonly playbackRevisions = new Map<string, number>();
  private readonly useMiotSpeech: boolean;
  private speechAuthorization?: SpeechAuthorization;
  private speechPreparation?: {
    accountKey: string;
    pending: Promise<SpeechAuthorization | undefined>;
  };

  constructor(
    store: JsonStore,
    fetchImpl: typeof fetch = fetch,
    playbackUrl?: (url: string) => string,
    useMiotSpeech = fetchImpl === fetch,
  ) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.playbackUrl = playbackUrl;
    this.useMiotSpeech = useMiotSpeech;
  }

  async startQrLogin(): Promise<{
    loginId: string;
    qrImageUrl: string;
    loginUrl: string;
  }> {
    const deviceId = randomBytes(16).toString("hex");
    const cookies = new Map<string, string>();
    const serviceUrl = new URL("/pass/serviceLogin", ACCOUNT);
    serviceUrl.searchParams.set("sid", "mijia");
    serviceUrl.searchParams.set("_json", "true");
    const firstCookie = "sdkVersion=3.8.6; deviceId=" + deviceId;
    const first = await this.getJson(
      serviceUrl.toString(),
      cookies,
      firstCookie,
    );
    const sign = required(first._sign, "小米登录服务没有返回签名");
    const qs = required(first.qs, "小米登录服务没有返回二维码参数");
    const callback = required(first.callback, "小米登录服务没有返回回调参数");

    const qrUrl = new URL("/longPolling/loginUrl", ACCOUNT);
    qrUrl.search = new URLSearchParams({
      _qrsize: "240",
      qs,
      sid: "mijia",
      _sign: sign,
      callback,
      _json: "true",
      _dc: String(Date.now()),
    }).toString();
    const qr = await this.getJson(qrUrl.toString(), cookies);
    if (Number(qr.code ?? 0) !== 0) throw new Error("小米二维码获取失败");
    const pollUrl = required(qr.lp, "小米登录服务没有返回轮询地址");
    this.assertXiaomiUrl(pollUrl);

    const loginId = randomBytes(24).toString("base64url");
    for (const [id, login] of this.logins)
      if (login.expiresAt <= Date.now()) this.logins.delete(id);
    while (this.logins.size >= MAX_LOGIN_SESSIONS) {
      const oldest = this.logins.keys().next().value as string | undefined;
      if (!oldest) break;
      this.logins.delete(oldest);
    }
    this.logins.set(loginId, {
      deviceId,
      pollUrl,
      cookies,
      expiresAt: Date.now() + QR_TTL_MS,
    });
    loginDiagnostic({ stage: "qr", event: "created" });
    return {
      loginId,
      qrImageUrl: asString(qr.qr) || asString(qr.loginUrl),
      loginUrl: asString(qr.loginUrl),
    };
  }

  async pollQrLogin(loginId: string): Promise<LoginPollResult> {
    const session = this.logins.get(loginId);
    if (!session || session.expiresAt <= Date.now()) {
      this.logins.delete(loginId);
      return { state: "expired", message: "二维码已过期，请重新生成" };
    }
    if (session.connected)
      return { state: "connected", message: "小米账号已连接" };
    if (session.pollPromise) return session.pollPromise;
    const pending = this.advanceQrLogin(loginId, session);
    session.pollPromise = pending;
    try {
      return await pending;
    } finally {
      if (session.pollPromise === pending) session.pollPromise = undefined;
    }
  }

  private async advanceQrLogin(
    loginId: string,
    session: LoginSession,
  ): Promise<LoginPollResult> {
    try {
      if (!session.confirmed) {
        loginDiagnostic({ stage: "scan", event: "poll_started" });
        const poll = await this.getJson(
          session.pollUrl,
          session.cookies,
          "",
          28_000,
        );
        const code = Number(poll.code ?? 0);
        const passToken =
          asString(poll.passToken) || session.cookies.get("passToken") || "";
        const userId =
          asString(poll.userId) || session.cookies.get("userId") || "";
        const cUserId =
          asString(poll.cUserId) || session.cookies.get("cUserId") || "";
        loginDiagnostic({
          stage: "scan",
          event: "poll_returned",
          code: Number.isFinite(code) ? code : undefined,
          hasPassToken: Boolean(passToken),
          hasUserId: Boolean(userId),
        });
        if (code !== 0)
          return {
            state: "waiting",
            message:
              "小米扫码状态码 " +
              (Number.isFinite(code) ? code : "未知") +
              "，正在重试；若手机已确认，请重新生成二维码",
          };
        if (!passToken || !userId)
          return { state: "waiting", message: "等待手机扫码并确认登录" };
        session.confirmed = { passToken, userId, cUserId };
      }
      if (
        this.logins.get(loginId) !== session ||
        session.expiresAt <= Date.now()
      ) {
        return { state: "expired", message: "二维码会话已失效，请重新生成" };
      }
      loginDiagnostic({ stage: "authorization", event: "exchange_started" });
      const { passToken, userId, cUserId } = session.confirmed;
      const auth = await this.exchangeServiceToken(
        passToken,
        userId,
        session.deviceId,
        cUserId,
      );
      await this.store.update((state) => {
        if (
          this.logins.get(loginId) !== session ||
          session.expiresAt <= Date.now()
        )
          throw new Error("二维码会话已失效，请重新生成");
        state.config.xiaomi = auth;
        state.config.devices = [];
        changeSelectedDevice(state.config, "");
      });
      if (this.logins.get(loginId) !== session)
        return { state: "expired", message: "二维码会话已失效，请重新生成" };
      for (const id of this.logins.keys())
        if (id !== loginId) this.logins.delete(id);
      session.connected = true;
      session.confirmed = undefined;
      session.cookies.clear();
      loginDiagnostic({ stage: "authorization", event: "connected" });
      return { state: "connected", message: "小米账号已连接" };
    } catch (error) {
      const stage = session.confirmed ? "authorization" : "scan";
      loginDiagnostic({
        stage,
        event: "request_failed",
        ...(error instanceof XiaomiHttpError
          ? { code: error.status }
          : error instanceof XiaomiAuthorizationError
            ? { code: error.code }
            : {}),
        reason: loginFailureReason(error),
      });
      if (
        this.logins.get(loginId) !== session ||
        session.expiresAt <= Date.now()
      )
        return { state: "expired", message: "二维码会话已失效，请重新生成" };
      if (error instanceof XiaomiAuthorizationError) {
        this.logins.delete(loginId);
        return {
          state: "expired",
          message:
            error.message +
            "，请重新生成二维码；若持续失败，请检查小米账号授权状态",
        };
      }
      if (
        !session.confirmed &&
        error instanceof XiaomiHttpError &&
        [403, 410].includes(error.status)
      ) {
        this.logins.delete(loginId);
        return {
          state: "expired",
          message: "小米二维码已失效，请重新生成并扫码",
        };
      }
      if (
        !session.confirmed &&
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
      )
        return { state: "waiting", message: "等待手机扫码并确认登录" };
      session.failures = (session.failures ?? 0) + 1;
      return {
        state: "waiting",
        message:
          (session.confirmed
            ? "手机已确认，音箱服务授权失败，正在重试："
            : "扫码状态读取失败，正在重试：") + safeError(error),
        retryAfterMs: Math.min(
          15_000,
          1000 * 2 ** Math.min(session.failures, 4),
        ),
      };
    }
  }

  cancelQrLogin(loginId: string): void {
    this.logins.delete(loginId);
  }

  async disconnect(): Promise<void> {
    this.logins.clear();
    await this.store.update((state) => {
      state.config.xiaomi = null;
      state.config.devices = [];
      changeSelectedDevice(state.config, "");
    });
  }

  async refreshDevices(): Promise<MiotDevice[]> {
    let auth = await this.getCredentials();
    const url = MINA + "/admin/v2/device_list?master=1";
    let response = await this.fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, cookie: this.apiCookie(auth) },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401) {
      auth = await this.getCredentials(true);
      response = await this.fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, cookie: this.apiCookie(auth) },
        signal: AbortSignal.timeout(12_000),
      });
    }
    if (!response.ok)
      throw new Error("读取小米设备失败，HTTP " + response.status);
    const payload = (await response.json()) as {
      code?: unknown;
      data?: unknown;
    };
    if (Number(payload.code) !== 0 || !Array.isArray(payload.data))
      throw new Error("小米设备接口返回无效数据");
    const devices = payload.data.flatMap((raw): MiotDevice[] => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      const deviceId = asString(item.deviceID);
      if (!deviceId) return [];
      return [
        {
          deviceId,
          name: asString(item.alias) || asString(item.name) || deviceId,
          model: asString(item.model),
          hardware: asString(item.hardware) || asString(item.model),
          presence: asString(item.presence),
        },
      ];
    });
    await this.store.update((state) => {
      if (
        !state.config.xiaomi ||
        state.config.xiaomi.userId !== auth.userId ||
        this.store.decrypt(state.config.xiaomi.passToken) !== auth.passToken
      ) {
        throw new Error("小米账号已变更，请重新读取设备");
      }
      state.config.devices = devices;
      if (
        !devices.some(
          (device) => device.deviceId === state.config.selectedDeviceId,
        )
      ) {
        changeSelectedDevice(state.config, devices[0]?.deviceId ?? "");
      }
    });
    return devices;
  }

  async selectDevice(deviceId: string): Promise<void> {
    await this.store.update((state) => {
      if (!state.config.devices.some((device) => device.deviceId === deviceId))
        throw new Error("找不到所选音箱");
      changeSelectedDevice(state.config, deviceId);
    });
  }

  async getPlaybackStatus(deviceId: string): Promise<PlaybackStatus> {
    const revision = this.playbackRevisions.get(deviceId) ?? 0;
    const cached = this.playbackStatusCache.get(deviceId);
    if (
      cached &&
      cached.revision === revision &&
      Date.now() - cached.sampledAt < 2500
    )
      return cached.value;
    const pending = this.playbackStatusRequests.get(deviceId);
    if (pending?.revision === revision) return pending.promise;
    const promise = this.readPlaybackStatus(deviceId)
      .then((value) => {
        if ((this.playbackRevisions.get(deviceId) ?? 0) === revision)
          this.playbackStatusCache.set(deviceId, {
            sampledAt: value.sampledAt,
            revision,
            value,
          });
        return value;
      })
      .finally(() => {
        if (this.playbackStatusRequests.get(deviceId)?.promise === promise)
          this.playbackStatusRequests.delete(deviceId);
      });
    this.playbackStatusRequests.set(deviceId, { revision, promise });
    return promise;
  }

  private async readPlaybackStatus(deviceId: string): Promise<PlaybackStatus> {
    const auth = await this.getCredentials();
    const payload = await this.ubus(
      deviceId,
      "player_get_play_status",
      "mediaplayer",
      {},
      auth,
    );
    const outerCode = payload.code === undefined ? 0 : Number(payload.code);
    if (!Number.isFinite(outerCode) || outerCode !== 0)
      throw new Error(asString(payload.message) || "读取音箱播放状态失败");
    const data = parseNested(payload.data);
    if (data.code !== undefined && Number(data.code) !== 0)
      throw new Error("读取音箱播放状态失败");
    const rawInfo = data.info;
    let info: Record<string, unknown> = {};
    if (typeof rawInfo === "string") {
      try {
        const parsed: unknown = JSON.parse(rawInfo);
        info = isRecord(parsed) ? parsed : {};
      } catch {
        throw new Error("音箱播放状态格式无效");
      }
    } else if (isRecord(rawInfo)) info = rawInfo;
    const detail = isRecord(info.play_song_detail) ? info.play_song_detail : {};
    const seconds = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value / 1000
        : 0;
    const status =
      typeof info.status === "number" && Number.isInteger(info.status)
        ? info.status
        : -1;
    const volume =
      typeof info.volume === "number" && Number.isFinite(info.volume)
        ? Math.max(0, Math.min(100, info.volume))
        : undefined;
    const textField = (value: unknown) =>
      typeof value === "string" ? value.slice(0, 300) : undefined;
    const mediaId = textField(detail.audio_id ?? detail.audioId);
    return {
      status,
      position: seconds(detail.position),
      hasPosition:
        typeof detail.position === "number" &&
        Number.isFinite(detail.position) &&
        detail.position >= 0,
      duration: seconds(detail.duration),
      ...(volume === undefined ? {} : { volume }),
      sampledAt: Date.now(),
      ...(mediaId ? { mediaId } : {}),
      ...(textField(detail.title ?? detail.song_name)
        ? { title: textField(detail.title ?? detail.song_name) }
        : {}),
      ...(textField(detail.artist ?? detail.singer)
        ? { artist: textField(detail.artist ?? detail.singer) }
        : {}),
      ...(textField(detail.album) ? { album: textField(detail.album) } : {}),
    };
  }

  async getLatestQuestions(
    deviceId: string,
    hardware: string,
    limit = 10,
  ): Promise<{
    serverTime: number;
    messages: Array<{ timestamp: number; text: string }>;
  }> {
    if (!deviceId || !hardware)
      throw new Error("音箱缺少对话查询所需的设备型号");
    let auth = await this.getCredentials();
    if (hardware.trim().toUpperCase() === "M01") {
      const response = await this.ubus(
        deviceId,
        "nlp_result_get",
        "mibrain",
        {},
        auth,
      );
      const result = parseNested(response.data);
      if (Number(response.code) !== 0 || Number(result.code) !== 0)
        throw new Error("音箱对话查询失败");
      if (!result.info) return { serverTime: Date.now(), messages: [] };
      let info: unknown;
      try {
        info =
          typeof result.info === "string"
            ? JSON.parse(result.info)
            : result.info;
      } catch {
        throw new Error("音箱对话记录格式无效");
      }
      const entries =
        info && typeof info === "object"
          ? (info as Record<string, unknown>).result
          : undefined;
      if (entries !== undefined && !Array.isArray(entries))
        throw new Error("音箱对话记录格式无效");
      const messages = (Array.isArray(entries) ? entries : [])
        .flatMap((raw): Array<{ timestamp: number; text: string }> => {
          if (!raw || typeof raw !== "object") return [];
          const nlpRaw = (raw as Record<string, unknown>).nlp;
          let nlp: unknown;
          try {
            nlp = typeof nlpRaw === "string" ? JSON.parse(nlpRaw) : nlpRaw;
          } catch {
            return [];
          }
          if (!nlp || typeof nlp !== "object") return [];
          const record = nlp as Record<string, unknown>;
          const meta =
            record.meta && typeof record.meta === "object"
              ? (record.meta as Record<string, unknown>)
              : {};
          const timestamp = Number(meta.timestamp);
          const responseData =
            record.response && typeof record.response === "object"
              ? (record.response as Record<string, unknown>)
              : {};
          const answers = Array.isArray(responseData.answer)
            ? responseData.answer
            : [];
          const first =
            answers[0] && typeof answers[0] === "object"
              ? (answers[0] as Record<string, unknown>)
              : {};
          const intention =
            first.intention && typeof first.intention === "object"
              ? (first.intention as Record<string, unknown>)
              : {};
          const text = asString(intention.query ?? first.question)
            .trim()
            .slice(0, 2000);
          return Number.isFinite(timestamp) && timestamp > 0 && text
            ? [{ timestamp, text }]
            : [];
        })
        .sort((left, right) => left.timestamp - right.timestamp);
      return { serverTime: Date.now(), messages };
    }
    const url = new URL("/device_profile/v2/conversation", USERPROFILE);
    url.search = new URLSearchParams({
      source: "dialogu",
      hardware,
      timestamp: String(Date.now()),
      limit: String(Math.max(1, Math.min(20, limit))),
    }).toString();
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await this.fetchImpl(url, {
        headers: {
          "user-agent": USER_AGENT,
          cookie:
            this.apiCookie(auth) + "; " + xiaomiCookie("deviceId", deviceId),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 401 || attempt === 1) break;
      auth = await this.getCredentials(true);
    }
    if (!response) throw new Error("小爱对话查询失败");
    if (!response.ok)
      throw new Error("小爱对话查询失败，HTTP " + response.status);
    const payload = (await response.json()) as {
      code?: unknown;
      data?: unknown;
    };
    if (payload.code !== undefined && Number(payload.code) !== 0)
      throw new Error("小爱对话查询被拒绝，请重新连接账号或检查设备授权");
    let data: unknown = payload.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        throw new Error("小爱对话记录格式无效");
      }
    }
    const records =
      data && typeof data === "object"
        ? (data as Record<string, unknown>).records
        : undefined;
    if (!Array.isArray(records)) throw new Error("小爱对话记录格式无效");
    const messages = (Array.isArray(records) ? records : [])
      .flatMap((raw): Array<{ timestamp: number; text: string }> => {
        if (!raw || typeof raw !== "object") return [];
        const record = raw as Record<string, unknown>;
        const timestamp = Number(record.time);
        const text = asString(record.query).trim().slice(0, 2000);
        return Number.isFinite(timestamp) && timestamp > 0 && text
          ? [{ timestamp, text }]
          : [];
      })
      .sort((left, right) => left.timestamp - right.timestamp);
    const headerTime = Date.parse(response.headers.get("date") ?? "");
    return {
      serverTime: Number.isFinite(headerTime) ? headerTime : Date.now(),
      messages,
    };
  }

  async execute(
    deviceId: string,
    command:
      | "pause"
      | "resume"
      | "next"
      | "previous"
      | "stop"
      | "play"
      | "tts"
      | "volume",
    args: { url?: string; text?: string; volume?: number },
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<unknown> {
    const checkCurrent = () => {
      signal?.throwIfAborted();
      if (isCurrent?.() === false) throw new Error("音箱播放已变更");
    };
    checkCurrent();
    this.playbackRevisions.set(
      deviceId,
      (this.playbackRevisions.get(deviceId) ?? 0) + 1,
    );
    this.playbackStatusCache.delete(deviceId);
    let calls: Array<{
      method: string;
      path: string;
      message: Record<string, unknown>;
    }>;
    switch (command) {
      case "play": {
        if (!args.url) throw new Error("缺少播放地址");
        try {
          const playUrl = new URL(args.url);
          if (
            !["http:", "https:"].includes(playUrl.protocol) ||
            playUrl.username ||
            playUrl.password
          )
            throw new Error();
        } catch {
          throw new Error("播放地址必须是有效的 HTTP 或 HTTPS URL");
        }
        const device = this.store
          .snapshot()
          .config.devices.find((item) => item.deviceId === deviceId);
        calls = [
          musicPlaybackRequest(
            device?.hardware || device?.model || "",
            this.playbackUrl ? this.playbackUrl(args.url) : args.url,
          ),
        ];
        break;
      }
      case "tts": {
        if (!args.text?.trim()) throw new Error("播报内容不能为空");
        const text = args.text.slice(0, 1000);
        const target = this.speechTarget(deviceId);
        if (target) {
          const authorization = await this.prepareMiotSpeech(
            target.accountKey,
            deviceId,
          );
          signal?.throwIfAborted();
          const current = this.speechTarget(deviceId);
          if (
            current?.accountKey !== target.accountKey ||
            current.hardware !== target.hardware
          )
            throw new Error("播报设备或小米账号已变更");
          const did = authorization?.devices.get(deviceId);
          if (authorization && did) {
            const delivery = await playMiotText(
              authorization.credentials,
              did,
              current.action,
              text,
              this.fetchImpl,
              signal,
            ).catch(() => "unconfirmed");
            if (delivery === "unconfirmed")
              throw new DeviceCommandError(
                "米家播报回执无法确认",
                "unconfirmed",
              );
            if (delivery === "accepted")
              return { success: true, command, transport: "miot" };
          }
        }
        calls = [
          {
            method: "text_to_speech",
            path: "mibrain",
            message: { text },
          },
          {
            method: "player_play_tts",
            path: "mediaplayer",
            message: { text },
          },
        ];
        break;
      }
      case "volume":
        if (
          !Number.isInteger(args.volume) ||
          (args.volume ?? -1) < 0 ||
          (args.volume ?? 101) > 100
        )
          throw new Error("音量必须为 0 到 100");
        calls = [
          {
            method: "player_set_volume",
            path: "mediaplayer",
            message: { volume: args.volume },
          },
        ];
        break;
      default: {
        const action = command === "resume" ? "play" : command;
        calls = [
          {
            method: "player_play_operation",
            path: "mediaplayer",
            message: { action, media: "app_ios" },
          },
        ];
      }
    }

    checkCurrent();
    const auth = await this.getCredentials();
    if (calls[0].method === "player_play_url") {
      // Direct playback cannot replace the old media context via REPLACE_ALL.
      for (const action of ["pause", "stop"]) {
        checkCurrent();
        await this.ubus(
          deviceId,
          "player_play_operation",
          "mediaplayer",
          { action, media: "app_ios" },
          auth,
          checkCurrent,
        ).catch(() => undefined);
      }
    }
    let lastError = "音箱没有确认执行该操作";
    for (let index = 0; index < calls.length; index++) {
      checkCurrent();
      const call = calls[index];
      let payload: Record<string, unknown>;
      try {
        payload = await this.ubus(
          deviceId,
          call.method,
          call.path,
          call.message,
          auth,
          checkCurrent,
        );
      } catch (error) {
        lastError = safeError(error);
        // A network timeout may happen after the speaker accepted the primary TTS.
        // Only an explicit negative device response is safe to retry through the fallback.
        throw new DeviceCommandError(lastError, "unconfirmed");
      }
      const deviceData = parseNested(payload.data);
      const nested = parseNested(deviceData.device_data);
      const codes = [deviceData.code, nested.code]
        .filter((code) => code !== undefined)
        .map(Number);
      const deviceCode = codes.includes(3012)
        ? 3012
        : codes.find((code) => code !== 0);
      const hasOuterCode =
        payload.code !== undefined && Number.isFinite(Number(payload.code));
      const outerCode = hasOuterCode ? Number(payload.code) : undefined;
      if (outerCode === 0 && (deviceCode === undefined || deviceCode === 0))
        return { success: true, command, response: payload };
      lastError =
        asString(payload.message) || asString(deviceData.message) || lastError;
      // Device code 3012 means delivery is unconfirmed; do not risk speaking twice.
      const explicitRejection =
        (outerCode !== undefined && outerCode !== 0) ||
        (deviceCode !== undefined && deviceCode !== 0);
      if (
        command !== "tts" ||
        index !== 0 ||
        !explicitRejection ||
        deviceCode === 3012
      )
        throw new DeviceCommandError(
          lastError,
          explicitRejection && deviceCode !== 3012 ? "rejected" : "unconfirmed",
        );
    }
    throw new DeviceCommandError(lastError, "unconfirmed");
  }

  private async getCredentials(
    forceRefresh = false,
  ): Promise<XiaomiCredentials> {
    const saved = this.store.snapshot().config.xiaomi;
    if (!saved) throw new Error("请先连接小米账号");
    const passToken = this.store.decrypt(saved.passToken);
    const cUserId = saved.cUserId ? this.store.decrypt(saved.cUserId) : "";
    const serviceToken =
      !forceRefresh && Date.now() + 60_000 < saved.serviceTokenExpiresAt
        ? this.store.decrypt(saved.serviceToken)
        : "";
    if (serviceToken) return { ...saved, passToken, cUserId, serviceToken };
    const exchanged = await this.exchangeServiceToken(
      passToken,
      saved.userId,
      randomBytes(16).toString("hex"),
      cUserId,
    );
    const refreshed = {
      ...exchanged,
      passToken: saved.passToken,
      cUserId: saved.cUserId ?? "",
    };
    await this.store.update((state) => {
      if (
        !state.config.xiaomi ||
        state.config.xiaomi.userId !== saved.userId ||
        state.config.xiaomi.passToken !== saved.passToken
      ) {
        throw new Error("小米账号已变更，授权刷新已取消");
      }
      state.config.xiaomi = refreshed;
    });
    return {
      ...refreshed,
      passToken: this.store.decrypt(refreshed.passToken),
      cUserId,
      serviceToken: this.store.decrypt(refreshed.serviceToken),
    };
  }

  private async exchangeServiceToken(
    passToken: string,
    userId: string,
    deviceId: string,
    cUserId = "",
  ): Promise<XiaomiCredentials> {
    const ticket = await this.exchangeTicket(
      "micoapi",
      passToken,
      userId,
      deviceId,
      cUserId,
    );
    return {
      userId: ticket.userId,
      passToken: this.store.encrypt(passToken),
      cUserId: cUserId ? this.store.encrypt(cUserId) : "",
      serviceToken: this.store.encrypt(ticket.serviceToken),
      serviceTokenExpiresAt: Date.now() + 11 * 60 * 60 * 1000,
    };
  }

  /** Prepare credentials while the intent is resolved. This never sends audio. */
  async warmSpeech(deviceId: string) {
    const target = this.speechTarget(deviceId);
    if (target) await this.prepareMiotSpeech(target.accountKey, deviceId);
  }

  private speechTarget(deviceId: string) {
    if (!this.useMiotSpeech) return;
    const { xiaomi, devices } = this.store.snapshot().config;
    const device = devices.find((item) => item.deviceId === deviceId);
    const hardware = device?.hardware || device?.model || "";
    const action = miotSpeechAction(hardware);
    if (xiaomi && action)
      return {
        accountKey: JSON.stringify([xiaomi.userId, xiaomi.passToken]),
        hardware,
        action,
      };
  }

  private prepareMiotSpeech(accountKey: string, deviceId: string) {
    const cached = this.speechAuthorization;
    if (
      cached?.accountKey === accountKey &&
      Date.now() - cached.preparedAt <
        (cached.devices.has(deviceId) ? 60 * 60_000 : 60_000)
    )
      return cached;
    if (this.speechPreparation?.accountKey === accountKey)
      return this.speechPreparation.pending;
    const pending = this.loadMiotSpeech(accountKey, deviceId)
      .then((authorization) => {
        if (authorization && this.speechPreparation?.pending === pending)
          this.speechAuthorization = authorization;
        return authorization;
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.speechPreparation?.pending === pending)
          this.speechPreparation = undefined;
      });
    this.speechPreparation = { accountKey, pending };
    return pending;
  }

  private async loadMiotSpeech(accountKey: string, deviceId: string) {
    const auth = await this.getCredentials();
    if (this.speechTarget(deviceId)?.accountKey !== accountKey) return;
    const [devices, credentials] = await Promise.all([
      this.loadMiotSpeechDevices(auth),
      this.exchangeTicket(
        "xiaomiio",
        auth.passToken,
        auth.userId,
        randomBytes(16).toString("hex"),
        auth.cUserId,
      ),
    ]);
    if (
      !credentials.ssecurity ||
      this.speechTarget(deviceId)?.accountKey !== accountKey
    )
      return;
    xiaomiCookie("serviceToken", credentials.serviceToken);
    xiaomiCookie("userId", credentials.userId);
    return {
      accountKey,
      credentials,
      devices,
      preparedAt: Date.now(),
    };
  }

  private async loadMiotSpeechDevices(auth: XiaomiCredentials) {
    const response = await this.fetchImpl(
      MINA + "/admin/v2/device_list?master=1",
      {
        headers: { "user-agent": USER_AGENT, cookie: this.apiCookie(auth) },
        signal: AbortSignal.timeout(6000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("读取播报设备失败");
    const payload = await response.json();
    if (Number(payload.code) !== 0 || !Array.isArray(payload.data))
      throw new Error("播报设备列表无效");
    const devices = new Map<string, string>();
    for (const item of payload.data) {
      const did = String(item?.miotDID ?? "");
      if (typeof item?.deviceID === "string" && /^[0-9]+$/u.test(did))
        devices.set(item.deviceID, did);
    }
    return devices;
  }

  private async exchangeTicket(
    service: "micoapi" | "xiaomiio",
    passToken: string,
    userId: string,
    deviceId: string,
    cUserId: string,
  ): Promise<SpeechCredentials> {
    const url = new URL("/pass/serviceLogin", ACCOUNT);
    url.searchParams.set("sid", service);
    url.searchParams.set("_json", "true");
    const cookie = [
      xiaomiCookie("passToken", passToken),
      xiaomiCookie("userId", userId),
      xiaomiCookie("deviceId", deviceId),
      "sdkVersion=3.8.6",
      ...(cUserId ? [xiaomiCookie("cUserId", cUserId)] : []),
    ].join("; ");
    const loginCookies = new Map<string, string>();
    const login = await this.getJson(url.toString(), loginCookies, cookie);
    const code = Number(login.code ?? 0);
    if (!Number.isFinite(code)) throw new Error("小米音箱服务返回无效授权状态");
    if (code !== 0) throw new XiaomiAuthorizationError(code);
    if (login.notificationUrl || login.captchaUrl)
      throw new Error("小米要求额外身份验证，请在官方页面完成后重新扫码");
    const location = required(login.location, "小米账号未能获取音箱服务授权");
    this.assertXiaomiUrl(location);
    const ssecurity =
      asString(login.ssecurity) || loginCookies.get("ssecurity") || "";
    const nonce = asString(login.nonce);
    const target = new URL(location);
    // Some passToken responses provide a ready-to-use STS ticket without signing fields.
    // Keep that URL intact; only the legacy challenge response needs clientSign.
    if (ssecurity && nonce) {
      const signature = createHash("sha1")
        .update("nonce=" + nonce + "&" + ssecurity)
        .digest("base64");
      target.searchParams.set("_userIdNeedEncrypt", "true");
      target.searchParams.set("clientSign", signature);
    }
    loginDiagnostic({
      stage: "authorization",
      event: "redirect_started",
      mode: ssecurity && nonce ? "signed" : "ticket",
      hasSecurity: Boolean(ssecurity),
      hasNonce: Boolean(nonce),
    });
    const response = await this.getResponseFollowing(
      target.toString(),
      new Map(),
    );
    const serviceToken = response.cookies.get("serviceToken");
    if (!serviceToken) throw new Error("小米登录完成，但没有取得音箱服务令牌");
    return {
      userId: asString(login.userId) || userId,
      deviceId,
      ssecurity,
      serviceToken,
    };
  }

  private async ubus(
    deviceId: string,
    method: string,
    path: string,
    message: Record<string, unknown>,
    auth: XiaomiCredentials,
    checkCurrent?: () => void,
  ): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({
      deviceId,
      method,
      path,
      message: JSON.stringify(message),
      requestId: "app_ios_" + randomBytes(15).toString("hex"),
    });
    const request = (credentials: XiaomiCredentials) => {
      checkCurrent?.();
      return this.fetchImpl(MINA + "/remote/ubus", {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          "content-type": "application/x-www-form-urlencoded",
          cookie: this.apiCookie(credentials),
        },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    };
    let response = await request(auth);
    if (response.status === 401)
      response = await request(await this.getCredentials(true));
    if (!response.ok)
      throw new Error("音箱控制请求失败，HTTP " + response.status);
    return (await response.json()) as Record<string, unknown>;
  }

  private apiCookie(auth: XiaomiCredentials): string {
    return (
      xiaomiCookie("userId", auth.userId) +
      "; " +
      xiaomiCookie("serviceToken", auth.serviceToken) +
      "; channel=MI_APP_STORE"
    );
  }

  private async getJson(
    url: string,
    cookies: Map<string, string>,
    extraCookie = "",
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const result = await this.getResponseFollowing(
      url,
      cookies,
      extraCookie,
      timeoutMs,
    );
    const text = await result.response.text();
    let value: unknown;
    const jsonText = text.replace(/^&&&START&&&/, "").trim();
    try {
      value = JSON.parse(jsonText);
    } catch {
      throw new Error("小米登录服务返回了无法识别的数据");
    }
    if (!value || typeof value !== "object")
      throw new Error("小米登录服务返回了无效数据");
    const record = value as Record<string, unknown>;
    const nonce = extractJsonScalar(jsonText, "nonce");
    const userId = extractJsonScalar(jsonText, "userId");
    if (nonce) record.nonce = nonce;
    if (userId) record.userId = userId;
    return record;
  }

  private async getResponseFollowing(
    url: string,
    cookies: Map<string, string>,
    extraCookie = "",
    timeoutMs = 10_000,
  ): Promise<{ response: Response; cookies: Map<string, string> }> {
    let current = new URL(url);
    for (let redirect = 0; redirect <= 8; redirect++) {
      this.assertXiaomiUrl(current.toString());
      const scoped = [...cookies.entries()]
        .map(([name, value]) => name + "=" + value)
        .join("; ");
      const cookie = [scoped, redirect === 0 ? extraCookie : ""]
        .filter(Boolean)
        .join("; ");
      const response = await this.fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";", 1)[0] ?? "";
        const separator = pair.indexOf("=");
        if (separator > 0)
          cookies.set(
            pair.slice(0, separator).trim(),
            pair.slice(separator + 1).trim(),
          );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("小米登录重定向缺少目标地址");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new XiaomiHttpError(response.status);
      return { response, cookies };
    }
    throw new Error("小米登录重定向次数过多");
  }

  private assertXiaomiUrl(value: string): void {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(
        host === "xiaomi.com" ||
        host.endsWith(".xiaomi.com") ||
        host === "mi.com" ||
        host.endsWith(".mi.com")
      )
    ) {
      throw new Error("拒绝访问非小米登录地址");
    }
  }
}

class XiaomiHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("小米登录请求失败，HTTP " + status);
    this.status = status;
  }
}

class XiaomiAuthorizationError extends Error {
  readonly code: number;

  constructor(code: number) {
    super("小米音箱服务授权被拒绝，状态码 " + code);
    this.code = code;
  }
}

function xiaomiCookie(name: string, value: string): string {
  // Cookie values are opaque, not URL query parameters. Preserve Xiaomi's bytes.
  // Reject separators and controls instead of changing an invalid credential.
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(value))
    throw new Error("小米认证 Cookie 格式无效，请重新扫码");
  return name + "=" + value;
}

function loginDiagnostic(event: {
  stage: "qr" | "scan" | "authorization";
  event: string;
  code?: number;
  hasPassToken?: boolean;
  hasUserId?: boolean;
  reason?: string;
  mode?: "signed" | "ticket";
  hasSecurity?: boolean;
  hasNonce?: boolean;
}): void {
  if (process.env.MIOT_LOGIN_DIAGNOSTICS === "true")
    process.stderr.write(
      JSON.stringify({ eventType: "miot_login", ...event }) + "\n",
    );
}

function loginFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const cause = error.cause as { code?: unknown } | undefined;
  return typeof cause?.code === "string" && /^[A-Z_0-9]+$/u.test(cause.code)
    ? cause.code
    : error.name;
}

function parseNested(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object") return {};
  const data = (value as Record<string, unknown>).device_data;
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : (value as Record<string, unknown>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function required(value: unknown, message: string): string {
  const result = asString(value).trim();
  if (!result) throw new Error(message);
  return result;
}

function extractJsonScalar(source: string, field: string): string | undefined {
  const fieldPosition = source.indexOf(JSON.stringify(field));
  if (fieldPosition < 0) return undefined;
  const colonPosition = source.indexOf(":", fieldPosition + field.length + 2);
  if (colonPosition < 0) return undefined;
  let start = colonPosition + 1;
  while (/\s/u.test(source[start] ?? "")) start++;
  if (source[start] === '"') {
    let end = start + 1;
    while (end < source.length) {
      if (source[end] === '"' && source[end - 1] !== "\\") break;
      end++;
    }
    try {
      return JSON.parse(source.slice(start, end + 1)) as string;
    } catch {
      return undefined;
    }
  }
  let end = start;
  while (
    end < source.length &&
    ![",", "}", "]"].includes(source[end]) &&
    !/\s/u.test(source[end])
  )
    end++;
  return end > start ? source.slice(start, end) : undefined;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "小米登录请求失败";
  return message.slice(0, 160);
}

function changeSelectedDevice(config: StoredState["config"], deviceId: string) {
  if (config.selectedDeviceId === deviceId) return;
  const old = config.selectedDeviceId;
  if (old)
    Object.defineProperty(config.devicePlaybackQueues, old, {
      value: config.playbackQueue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  // Preserve the legacy unassigned queue on first connection; later switches use the device queue.
  config.playbackQueue = Object.hasOwn(config.devicePlaybackQueues, deviceId)
    ? config.devicePlaybackQueues[deviceId]
    : !old && !Object.keys(config.devicePlaybackQueues).length
      ? config.playbackQueue
      : { tracks: [], currentIndex: -1 };
  delete config.devicePlaybackQueues[deviceId];
  config.selectedDeviceId = deviceId;
}
