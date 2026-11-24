import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactLogText } from "./log-details.ts";

const LIMIT = 500;
type Level = "INFO" | "WARN" | "ERROR";

export class RuntimeLog {
  private lines: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private pending = Promise.resolve();
  private dirty = false;
  private writeFailed = false;
  private readonly file: string;
  private readonly secrets: () => string[];

  constructor(
    dataDir = process.env.DATA_DIR ?? "./data",
    secrets = () => [] as string[],
  ) {
    this.secrets = secrets;
    this.file = join(dataDir, "runtime.log");
  }

  async init() {
    try {
      const text = await readFile(this.file, "utf8");
      this.lines = text.trimEnd().split("\n").filter(Boolean).slice(-LIMIT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn("SuperAI could not read the existing runtime log.");
    }
  }

  detail(level: Level, event: string, fields: Record<string, unknown>) {
    const secrets = this.secrets();
    const serialized = JSON.stringify(fields, (_key, value) =>
      typeof value === "string" ? redactLogText(value, secrets) : value,
    ).replace(/[\u2028\u2029]/gu, " ");
    this.record(level, event, serialized);
  }

  // Callers provide fixed event names and selected metadata only.
  record(level: Level, event: string, fields = "") {
    this.lines.push(
      `${new Date().toISOString()} ${level} ${event}${fields ? " " + fields : ""}`,
    );
    if (this.lines.length > LIMIT) this.lines.shift();
    this.dirty = true;
    this.timer ??= setTimeout(() => void this.flush(), 100).unref();
  }

  download() {
    return this.lines.length ? this.lines.join("\n") + "\n" : "";
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return this.pending;
    this.dirty = false;
    const snapshot = this.download();
    this.pending = this.pending.then(async () => {
      const temporary = this.file + ".tmp";
      try {
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, this.file);
        this.writeFailed = false;
      } catch {
        this.dirty = true;
        if (!this.writeFailed)
          console.warn("SuperAI could not save the runtime log.");
        this.writeFailed = true;
      }
    });
    return this.pending;
  }
}
