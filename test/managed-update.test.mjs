import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { launch } from "../src/update/launcher.ts";
import { localRequest } from "../src/update/protocol.ts";
import { prepareBundle } from "../src/update/bundle.ts";

const workingServer = (version) =>
  `setInterval(() => {}, 1000); process.send({ready: true, version: "${version}"});`;

async function makeApp(root, version, source = workingServer(version)) {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "superai", version, type: "module" }),
  );
  await writeFile(join(root, "src/server.ts"), source);
  return root;
}

async function waitForJob(socket) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await localRequest(socket, "GET", "/");
    const status = JSON.parse(response.body);
    if (status.job && !status.busy) return status.job;
    await delay(30);
  }
  throw new Error("Update did not finish");
}

test("the launcher restores state on failed startup and persists the healthy release", async (t) => {
  t.mock.method(console, "error", (error) => {
    throw error;
  });
  const temporary = await mkdtemp(join(tmpdir(), "superai-test-update-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataDir = join(temporary, "data");
  await mkdir(dataDir);
  const state = join(dataDir, "state.json");
  await writeFile(state, '{"original":true}');
  const root = await makeApp(join(temporary, "initial"), "0.1.2");
  const options = {
    root,
    dataDir,
    prepare: (version, staging) =>
      makeApp(
        join(staging, "candidate"),
        version,
        version === "0.1.3"
          ? `import {writeFileSync} from "node:fs";
           writeFileSync(${JSON.stringify(state)}, '{"broken":true}');
           process.exit(1);`
          : workingServer(version),
      ),
  };
  let service = await launch(options);
  t.after(() => service.close());
  assert.equal(
    (await localRequest(service.socket, "POST", "/0.1.3")).status,
    202,
  );
  assert.equal((await waitForJob(service.socket)).phase, "rolled_back");
  assert.equal(await readFile(state, "utf8"), '{"original":true}');
  assert.equal(
    (await localRequest(service.socket, "POST", "/0.1.4")).status,
    202,
  );
  assert.equal((await waitForJob(service.socket)).phase, "updated");
  await service.close();
  service = await launch(options);
  assert.equal(
    (await localRequest(service.socket, "POST", "/0.1.4")).status,
    400,
  );
  assert.equal(await readFile(state, "utf8"), '{"original":true}');
});

test("a mismatched release asset digest aborts before installation", async (t) => {
  const staging = await mkdtemp(join(tmpdir(), "superai-test-bundle-"));
  t.after(() => rm(staging, { recursive: true, force: true }));
  const expected = Buffer.from("a verified zip");
  const altered = Buffer.from("a modified zip");
  const asset = {
    name: "superai-0.1.3-deploy.zip",
    browser_download_url:
      "https://github.com/TaoKe-One/superai/releases/download/v0.1.3/superai-0.1.3-deploy.zip",
    size: expected.length,
    digest: "sha256:" + createHash("sha256").update(expected).digest("hex"),
  };
  await assert.rejects(
    prepareBundle("0.1.3", staging, async (url) =>
      url === asset.browser_download_url
        ? new Response(altered)
        : Response.json({ tag_name: "v0.1.3", assets: [asset] }),
    ),
    /SHA-256/,
  );
});
