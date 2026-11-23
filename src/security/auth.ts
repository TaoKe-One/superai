import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonStore } from "../storage/store.ts";

const SESSION_COOKIE = "speaker_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 5;
const MAX_PASSWORD_LENGTH = 200;

function validatePasswordLength(password: string): void {
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  )
    throw new Error(
      `管理员密码需要 ${MIN_PASSWORD_LENGTH} 至 ${MAX_PASSWORD_LENGTH} 个字符`,
    );
}

export class AdminAuth {
  private readonly store: JsonStore;
  private readonly sessions = new Map<string, number>();
  private readonly loginFailures = new Map<
    string,
    { failures: number; windowExpiresAt: number; lockedUntil: number }
  >();

  constructor(store: JsonStore) {
    this.store = store;
  }

  needsSetup(): boolean {
    return this.store.snapshot().admin === null;
  }

  async setup(password: string): Promise<string> {
    if (!this.needsSetup()) throw new Error("管理员已初始化");
    validatePasswordLength(password);
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    await this.store.update((state) => {
      if (state.admin) throw new Error("管理员已初始化");
      state.admin = { salt, hash };
    });
    return this.createSession();
  }

  async resetPassword(): Promise<string> {
    const password = randomBytes(24).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    await this.store.update((state) => {
      state.admin = { salt, hash };
    });
    this.sessions.clear();
    this.loginFailures.clear();
    return password;
  }

  login(password: string, clientKey = "unknown"): string | null {
    return this.verifyPassword(password, clientKey)
      ? this.createSession()
      : null;
  }

  async changePassword(
    currentPassword: string,
    newPassword: string,
    clientKey: string,
  ): Promise<boolean> {
    validatePasswordLength(newPassword);
    const admin = this.verifyPassword(currentPassword, clientKey);
    if (!admin) return false;

    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(newPassword, salt, 64).toString("hex");
    await this.store.update((state) => {
      if (state.admin?.salt !== admin.salt || state.admin.hash !== admin.hash)
        throw new Error("管理员密码已更新，请重新登录");
      state.admin = { salt, hash };
    });
    this.sessions.clear();
    this.loginFailures.clear();
    return true;
  }

  private verifyPassword(password: string, clientKey: string) {
    const now = Date.now();
    for (const [key, failure] of this.loginFailures)
      if (failure.windowExpiresAt <= now && failure.lockedUntil <= now)
        this.loginFailures.delete(key);
    if (
      this.loginFailures.size >= 10_000 &&
      !this.loginFailures.has(clientKey)
    ) {
      const oldest = this.loginFailures.keys().next().value as
        string | undefined;
      if (oldest) this.loginFailures.delete(oldest);
    }
    let failure = this.loginFailures.get(clientKey);
    if (failure && now < failure.lockedUntil) return null;
    if (!failure || failure.windowExpiresAt <= now)
      failure = {
        failures: 0,
        windowExpiresAt: now + 15 * 60 * 1000,
        lockedUntil: 0,
      };
    if (password.length > MAX_PASSWORD_LENGTH) return null;
    const admin = this.store.snapshot().admin;
    if (!admin) return null;
    const candidate = Buffer.from(
      scryptSync(password, admin.salt, 64).toString("hex"),
      "hex",
    );
    const expected = Buffer.from(admin.hash, "hex");
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    ) {
      failure.failures++;
      if (failure.failures >= 8) {
        failure.failures = 0;
        failure.lockedUntil = now + 15 * 60 * 1000;
      }
      this.loginFailures.set(clientKey, failure);
      return null;
    }
    this.loginFailures.delete(clientKey);
    return admin;
  }

  isAuthenticated(request: IncomingMessage): boolean {
    const cookieHeader = request.headers.cookie ?? "";
    const token = cookieHeader
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(SESSION_COOKIE + "="))
      ?.slice(SESSION_COOKIE.length + 1);
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt || expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const token = request.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(SESSION_COOKIE + "="))
      ?.slice(SESSION_COOKIE.length + 1);
    if (token) this.sessions.delete(token);
    const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
    response.setHeader(
      "set-cookie",
      SESSION_COOKIE +
        "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" +
        secure,
    );
  }

  setCookie(response: ServerResponse, token: string): void {
    const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
    response.setHeader(
      "set-cookie",
      SESSION_COOKIE +
        "=" +
        token +
        "; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200" +
        secure,
    );
  }

  private createSession(): string {
    for (const [session, expiresAt] of this.sessions)
      if (expiresAt <= Date.now()) this.sessions.delete(session);
    while (this.sessions.size >= 100) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }
}
