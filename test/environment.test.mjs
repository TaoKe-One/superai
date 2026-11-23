import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("local startup retains DNS and listen settings across restarts, with explicit environment taking precedence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "speaker-environment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL("../src/environment.ts", import.meta.url).href;
  const env = { ...process.env };
  for (const key of ["HOST", "PORT", "DATA_DIR", "LX_DNS_OVER_HTTPS"])
    delete env[key];
  const start = (overrides = {}) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          "import { loadLocalEnvironment } from " +
            JSON.stringify(module) +
            '; loadLocalEnvironment(); console.log(JSON.stringify(Object.fromEntries(["HOST","PORT","DATA_DIR","LX_DNS_OVER_HTTPS"].map(k=>[k,process.env[k]??null]))))',
        ],
        { cwd: directory, env: { ...env, ...overrides }, encoding: "utf8" },
      ),
    );
  assert.deepEqual(start(), {
    HOST: null,
    PORT: null,
    DATA_DIR: null,
    LX_DNS_OVER_HTTPS: null,
  });
  await writeFile(
    join(directory, ".env"),
    "HOST=127.0.0.1\nPORT=18787\nDATA_DIR=./data\nLX_DNS_OVER_HTTPS=true\n",
  );
  const saved = {
    HOST: "127.0.0.1",
    PORT: "18787",
    DATA_DIR: "./data",
    LX_DNS_OVER_HTTPS: "true",
  };
  assert.deepEqual(start(), saved);
  assert.deepEqual(start(), saved);
  assert.deepEqual(start({ PORT: "18790", LX_DNS_OVER_HTTPS: "false" }), {
    ...saved,
    PORT: "18790",
    LX_DNS_OVER_HTTPS: "false",
  });
});

test(
  "the server entrypoint loads .env before choosing its address and data directory",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "speaker-startup-"));
    let child;
    t.after(async () => {
      if (child?.exitCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, ".env"),
      "HOST=127.0.0.1\nPORT=18787\nDATA_DIR=./local-state\nLX_DNS_OVER_HTTPS=true\n",
    );
    const env = { ...process.env, PORT: "0" };
    for (const key of ["HOST", "DATA_DIR", "MASTER_KEY", "LX_DNS_OVER_HTTPS"])
      delete env[key];
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../src/server.ts", import.meta.url)),
      ],
      { cwd: directory, env },
    );
    const stdout = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => String(chunk)),
      once(child, "exit").then(([code]) => {
        throw Error("Server exited before listening: " + code);
      }),
      once(child, "error").then(([error]) => {
        throw error;
      }),
    ]);
    assert.ok(stdout.includes("listening on http://127.0.0.1:0"));
    const state = JSON.parse(
      await readFile(join(directory, "local-state", "state.json"), "utf8"),
    );
    assert.equal(state.config.lxSources.length, 0);
  },
);
