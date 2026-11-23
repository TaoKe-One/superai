import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdminAuth } from "../src/security/auth.ts";
import { JsonStore } from "../src/storage/store.ts";
import { MiotClient } from "../src/miot/client.ts";
import { HttpJsonMusicSource } from "../src/music/http-source.ts";

async function createStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "speaker-platform-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.init();
  return { store, directory };
}

const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    ...init,
  });

function qrFixture(overrides = {}) {
  const calls = { polls: 0, exchanges: 0 };
  return {
    calls,
    fetch: async (input, options) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/pass/serviceLogin" &&
        url.searchParams.get("sid") === "mijia"
      )
        return json({ _sign: "sign", qs: "qs", callback: "callback" });
      if (url.pathname === "/longPolling/loginUrl")
        return json({
          code: 0,
          lp: "https://account.xiaomi.com/qr/poll",
          qr: "https://account.xiaomi.com/qr.png",
        });
      if (url.pathname === "/qr/poll") {
        calls.polls++;
        return overrides.poll
          ? overrides.poll()
          : json({ code: 0, passToken: "pass-token", userId: "user-1" });
      }
      if (
        url.pathname === "/pass/serviceLogin" &&
        url.searchParams.get("sid") === "micoapi"
      ) {
        calls.exchanges++;
        const exchange = overrides.exchange
          ? await overrides.exchange(calls.exchanges, options)
          : undefined;
        return json(
          exchange ?? {
            location: "https://account.xiaomi.com/sts/start",
            ssecurity: "security",
            nonce: "nonce",
          },
        );
      }
      if (url.pathname === "/sts/start") {
        if (overrides.sts) return overrides.sts(url);
        return new Response(null, {
          status: 302,
          headers: {
            location: "/sts/finish",
            "set-cookie": "serviceToken=service-token; Path=/; Secure",
          },
        });
      }
      if (url.pathname === "/sts/finish") return new Response("ok");
      throw new Error("unexpected QR fixture request");
    },
  };
}

test("concurrent QR polls share confirmation and service authorization; successful polls are repeatable", async (t) => {
  const { store } = await createStore(t);
  const poll = Promise.withResolvers();
  const fixture = qrFixture({ poll: () => poll.promise });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  const first = client.pollQrLogin(qr.loginId);
  const second = client.pollQrLogin(qr.loginId);
  poll.resolve(json({ code: 0, passToken: "pass-token", userId: "user-1" }));
  assert.deepEqual(
    (await Promise.all([first, second])).map((value) => value.state),
    ["connected", "connected"],
  );
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "connected");
  assert.deepEqual(fixture.calls, { polls: 1, exchanges: 1 });
});

test("authorization retries preserve phone confirmation instead of polling a consumed QR", async (t) => {
  const { store } = await createStore(t);
  const fixture = qrFixture({
    exchange: (attempt) => {
      if (attempt === 1) throw new TypeError("fetch failed");
    },
  });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  const first = await client.pollQrLogin(qr.loginId);
  assert.equal(first.state, "waiting");
  assert.match(first.message, /手机已确认.*授权失败/u);
  assert.equal(first.retryAfterMs, 2000);
  assert.equal(store.snapshot().config.xiaomi, null);
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "connected");
  assert.deepEqual(fixture.calls, { polls: 1, exchanges: 2 });
});

test("ticket-only Xiaomi authorization follows the issued location without requiring signing fields", async (t) => {
  const { store } = await createStore(t);
  const fixture = qrFixture({
    exchange: () => ({
      code: 0,
      location: "https://account.xiaomi.com/sts/start?ticket=issued-ticket",
    }),
    sts(url) {
      assert.equal(url.search, "?ticket=issued-ticket");
      return new Response("ok", {
        headers: {
          "set-cookie": "serviceToken=ticket-service; Path=/; Secure",
        },
      });
    },
  });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "connected");
  assert.equal(
    store.decrypt(store.snapshot().config.xiaomi.serviceToken),
    "ticket-service",
  );
});

test("ticket-only authorization is not connected unless the STS actually issues a service token", async (t) => {
  const { store } = await createStore(t);
  const client = new MiotClient(
    store,
    qrFixture({
      exchange: () => ({
        code: 0,
        location: "https://account.xiaomi.com/sts/start?ticket=issued-ticket",
      }),
      sts: () => new Response("no token"),
    }).fetch,
  );
  const qr = await client.startQrLogin();
  const result = await client.pollQrLogin(qr.loginId);
  assert.equal(result.state, "waiting");
  assert.match(result.message, /没有取得音箱服务令牌/u);
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("an explicit service authorization rejection is not followed even when a location is present", async (t) => {
  const { store } = await createStore(t);
  const client = new MiotClient(
    store,
    qrFixture({
      exchange: () => ({
        code: 70016,
        location: "https://account.xiaomi.com/sts/start",
      }),
      sts: () => {
        throw new Error("must not follow rejected authorization");
      },
    }).fetch,
  );
  const qr = await client.startQrLogin();
  const rejected = await client.pollQrLogin(qr.loginId);
  assert.match(rejected.message, /状态码 70016/u);
  assert.equal(rejected.state, "expired");
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "expired");
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("QR confirmation credentials can be delivered in response cookies", async (t) => {
  const { store } = await createStore(t);
  const fixture = qrFixture({
    poll() {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "passToken=cookie-pass; Path=/; Secure");
      headers.append("set-cookie", "userId=user-1; Path=/; Secure");
      return new Response('{"code":0}', { headers });
    },
    exchange(_attempt, options) {
      assert.match(options.headers.cookie, /passToken=cookie-pass/u);
    },
  });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "connected");
  assert.equal(
    store.decrypt(store.snapshot().config.xiaomi.passToken),
    "cookie-pass",
  );
});

test("Xiaomi passToken and cUserId retain cookie-safe special characters without URL encoding", async (t) => {
  const { store } = await createStore(t);
  const passToken = "V1:opaque/token+value==%25";
  const cUserId = "encrypted/user+id=";
  const fixture = qrFixture({
    poll: () => json({ code: 0, passToken, userId: "user-1", cUserId }),
    exchange(_attempt, options) {
      const cookies = options.headers.cookie.split("; ");
      assert.ok(cookies.includes("passToken=" + passToken));
      assert.ok(cookies.includes("cUserId=" + cUserId));
    },
  });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "connected");
});

test("speaker API cookies retain serviceToken bytes rather than URL-encoding them", async (t) => {
  const { store } = await createStore(t);
  const serviceToken = "V1:service/token+value==%25";
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt(serviceToken),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  const client = new MiotClient(store, async (_input, options) => {
    assert.ok(
      options.headers.cookie
        .split("; ")
        .includes("serviceToken=" + serviceToken),
    );
    return json({ code: 0, data: [] });
  });
  assert.deepEqual(await client.refreshDevices(), []);
});

test("invalid cookie delimiters in Xiaomi credentials cannot inject another cookie", async (t) => {
  const { store } = await createStore(t);
  const fixture = qrFixture({
    poll: () =>
      json({ code: 0, passToken: "pass; injected=value", userId: "user-1" }),
  });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  assert.match(
    (await client.pollQrLogin(qr.loginId)).message,
    /Cookie 格式无效/u,
  );
  assert.equal(fixture.calls.exchanges, 0);
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("cancelling a QR during authorization prevents account persistence", async (t) => {
  const { store } = await createStore(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const fixture = qrFixture({
    async exchange() {
      entered.resolve();
      await release.promise;
    },
  });
  const client = new MiotClient(store, fixture.fetch);
  const qr = await client.startQrLogin();
  const pending = client.pollQrLogin(qr.loginId);
  await entered.promise;
  client.cancelQrLogin(qr.loginId);
  release.resolve();
  assert.equal((await pending).state, "expired");
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("QR invalidation while its store write waits in the queue cannot reconnect", async (t) => {
  const { store } = await createStore(t);
  const originalUpdate = store.update.bind(store);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  store.update = async (mutator) => {
    entered.resolve();
    await release.promise;
    return originalUpdate(mutator);
  };
  const client = new MiotClient(store, qrFixture().fetch);
  const qr = await client.startQrLogin();
  const pending = client.pollQrLogin(qr.loginId);
  await entered.promise;
  client.cancelQrLogin(qr.loginId);
  release.resolve();
  assert.equal((await pending).state, "expired");
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("admin setup stores a password hash and creates an expiring session", async (t) => {
  const { store } = await createStore(t);
  const auth = new AdminAuth(store);
  assert.equal(auth.needsSetup(), true);
  await assert.rejects(() => auth.setup("four"), /5 至 200/);
  const password = "T7#qw";
  const token = await auth.setup(password);
  assert.equal(auth.needsSetup(), false);
  assert.notEqual(store.snapshot().admin.hash, password);
  assert.equal(
    auth.isAuthenticated({ headers: { cookie: "speaker_session=" + token } }),
    true,
  );
  assert.equal(auth.login("wrong password"), null);
  assert.ok(auth.login(password));
});

test("admin login throttling is isolated per client", async (t) => {
  const { store } = await createStore(t);
  const auth = new AdminAuth(store);
  await auth.setup("correct horse battery staple");
  for (let attempt = 0; attempt < 8; attempt++)
    assert.equal(auth.login("wrong password", "client-a"), null);
  assert.equal(auth.login("correct horse battery staple", "client-a"), null);
  assert.ok(auth.login("correct horse battery staple", "client-b"));
});

test("secret settings are encrypted at rest and survive a restart", async (t) => {
  const { store, directory } = await createStore(t);
  await store.update((state) => {
    state.config.ai.apiKey = store.encrypt("api-secret-123");
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass-token"),
      serviceToken: store.encrypt("service-token"),
      serviceTokenExpiresAt: Date.now() + 10000,
    };
  });
  const raw = await readFile(join(directory, "state.json"), "utf8");
  assert.equal(raw.includes("api-secret-123"), false);
  assert.equal(raw.includes("pass-token"), false);
  const restarted = new JsonStore(directory);
  await restarted.init();
  assert.equal(
    restarted.decrypt(restarted.snapshot().config.ai.apiKey),
    "api-secret-123",
  );
  assert.equal(
    restarted.decrypt(restarted.snapshot().config.xiaomi.serviceToken),
    "service-token",
  );
});

test("store rejects malformed persisted queue state before serving requests", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "speaker-platform-invalid-state-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      version: 1,
      admin: null,
      config: {
        musicSources: [],
        playbackQueue: { tracks: [{}], currentIndex: 0 },
      },
    }),
  );
  const store = new JsonStore(directory);
  await assert.rejects(() => store.init(), /播放队列格式无效/u);
});

test("store fails during startup when MASTER_KEY cannot decrypt saved secrets", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "speaker-platform-key-mismatch-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new JsonStore(
    directory,
    "first-key-0123456789-0123456789-0123456789",
  );
  await first.init();
  await first.update((state) => {
    state.config.ai.apiKey = first.encrypt("secret");
  });
  const restarted = new JsonStore(
    directory,
    "wrong-key-0123456789-0123456789-0123456789",
  );
  await assert.rejects(() => restarted.init(), /检查 MASTER_KEY/u);
});

test("Miot QR login exchanges tokens, discovers devices and sends playback control", async (t) => {
  const { store, directory } = await createStore(t);
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (
      url.pathname === "/pass/serviceLogin" &&
      url.searchParams.get("sid") === "mijia"
    ) {
      return new Response(
        "&&&START&&&" +
          JSON.stringify({ _sign: "sign", qs: "qs", callback: "callback" }),
        { status: 200 },
      );
    }
    if (url.pathname === "/longPolling/loginUrl") {
      return json({
        code: 0,
        lp: "https://account.xiaomi.com/qr/poll",
        qr: "https://account.xiaomi.com/qr.png",
        loginUrl: "https://account.xiaomi.com/qr/login",
      });
    }
    if (url.pathname === "/qr/poll")
      return json({
        code: 0,
        passToken: "pass-token",
        userId: "user-1",
        cUserId: "cookie-user",
      });
    if (
      url.pathname === "/pass/serviceLogin" &&
      url.searchParams.get("sid") === "micoapi"
    ) {
      assert.match(options.headers.cookie, /cUserId=cookie-user/u);
      return new Response(
        '{"location":"https://account.xiaomi.com/sts/start","ssecurity":"security","nonce":90071992547409931234,"userId":"user-1"}',
        { status: 200 },
      );
    }
    if (url.pathname === "/sts/start") {
      assert.equal(
        url.searchParams.get("clientSign"),
        createHash("sha1")
          .update("nonce=90071992547409931234&security")
          .digest("base64"),
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: "/sts/finish",
          "set-cookie": "serviceToken=service-token; Path=/; Secure",
        },
      });
    }
    if (url.pathname === "/sts/finish")
      return new Response("ok", { status: 200 });
    if (url.pathname === "/admin/v2/device_list") {
      return json({
        code: 0,
        data: [
          {
            deviceID: "speaker-1",
            alias: "客厅音箱",
            model: "X08A",
            hardware: "X08A",
            presence: "online",
          },
        ],
      });
    }
    if (url.pathname === "/remote/ubus") {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("method"), "player_play_music");
      const message = JSON.parse(form.get("message"));
      assert.equal(
        JSON.parse(message.music).payload.audio_items[0].stream.url,
        "https://media.example/song.mp3",
      );
      return json({
        code: 0,
        data: { device_data: JSON.stringify({ code: 0 }) },
      });
    }
    throw new Error("unexpected fixture request: " + url);
  };
  const client = new MiotClient(store, fetchImpl);
  const qr = await client.startQrLogin();
  assert.equal(qr.qrImageUrl, "https://account.xiaomi.com/qr.png");
  assert.equal((await client.pollQrLogin(qr.loginId)).state, "connected");
  assert.equal(
    store.decrypt(store.snapshot().config.xiaomi.passToken),
    "pass-token",
  );
  assert.equal(
    store.decrypt(store.snapshot().config.xiaomi.cUserId),
    "cookie-user",
  );
  assert.deepEqual(await client.refreshDevices(), [
    {
      deviceId: "speaker-1",
      name: "客厅音箱",
      model: "X08A",
      hardware: "X08A",
      presence: "online",
    },
  ]);
  await client.execute("speaker-1", "play", {
    url: "https://media.example/song.mp3",
  });
  assert.equal(
    calls.filter((call) => call.url.pathname === "/remote/ubus").length,
    1,
  );
  assert.ok(
    (await readFile(join(directory, "state.json"), "utf8")).includes(
      "serviceToken",
    ),
  );
});

test("expired-token refresh cannot restore a Xiaomi account after disconnect", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("expired"),
      serviceTokenExpiresAt: Date.now() - 1,
    };
  });
  let enteredResolve;
  let release;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const client = new MiotClient(store, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/pass/serviceLogin") {
      enteredResolve();
      await blocked;
      return new Response(
        JSON.stringify({
          location: "https://account.xiaomi.com/sts/start",
          ssecurity: "security",
          nonce: "nonce",
        }),
        { status: 200 },
      );
    }
    if (url.pathname === "/sts/start")
      return new Response(null, {
        status: 302,
        headers: {
          location: "/sts/finish",
          "set-cookie": "serviceToken=refreshed; Path=/; Secure",
        },
      });
    if (url.pathname === "/sts/finish")
      return new Response("ok", { status: 200 });
    throw new Error("unexpected request: " + url);
  });
  const refreshing = client.refreshDevices();
  await entered;
  await client.disconnect();
  release();
  await assert.rejects(() => refreshing, /账号已变更/u);
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("device discovery refreshes an expired service token after HTTP 401", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("old-service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  let deviceCalls = 0;
  const client = new MiotClient(store, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/admin/v2/device_list") {
      deviceCalls++;
      if (deviceCalls === 1) return new Response("expired", { status: 401 });
      return json({
        code: 0,
        data: [
          {
            deviceID: "speaker-1",
            alias: "客厅",
            model: "X08A",
            hardware: "X08A",
            presence: "online",
          },
        ],
      });
    }
    if (url.pathname === "/pass/serviceLogin")
      return new Response(
        JSON.stringify({
          location: "https://account.xiaomi.com/sts/start",
          ssecurity: "security",
          nonce: "nonce",
        }),
        { status: 200 },
      );
    if (url.pathname === "/sts/start")
      return new Response(null, {
        status: 302,
        headers: {
          location: "/sts/finish",
          "set-cookie": "serviceToken=new-service; Path=/; Secure",
        },
      });
    if (url.pathname === "/sts/finish")
      return new Response("ok", { status: 200 });
    throw new Error("unexpected request: " + url);
  });
  assert.deepEqual(await client.refreshDevices(), [
    {
      deviceId: "speaker-1",
      name: "客厅",
      model: "X08A",
      hardware: "X08A",
      presence: "online",
    },
  ]);
  assert.equal(deviceCalls, 2);
});

test("MIoT TTS uses the primary command once when it succeeds", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  const methods = [];
  const client = new MiotClient(store, async (_input, options) => {
    const form = new URLSearchParams(options.body);
    methods.push(form.get("method"));
    return json({
      code: 0,
      data: { device_data: JSON.stringify({ code: 0 }) },
    });
  });
  const result = await client.execute("speaker-1", "tts", { text: "你好" });
  assert.equal(result.success, true);
  assert.deepEqual(methods, ["text_to_speech"]);
});

test("MIoT TTS falls back only after an explicit primary rejection", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  const methods = [];
  const client = new MiotClient(store, async (_input, options) => {
    const form = new URLSearchParams(options.body);
    const method = form.get("method");
    methods.push(method);
    return method === "text_to_speech"
      ? json({ code: -1, message: "unsupported" })
      : json({ code: 0, data: { device_data: JSON.stringify({ code: 0 }) } });
  });
  const result = await client.execute("speaker-1", "tts", { text: "你好" });
  assert.equal(result.success, true);
  assert.deepEqual(methods, ["text_to_speech", "player_play_tts"]);
});

test("MIoT TTS does not fall back on unconfirmed delivery", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  const methods = [];
  const client = new MiotClient(store, async (_input, options) => {
    const form = new URLSearchParams(options.body);
    methods.push(form.get("method"));
    return json({
      code: 0,
      data: { device_data: JSON.stringify({ code: 3012 }) },
    });
  });
  await assert.rejects(() =>
    client.execute("speaker-1", "tts", { text: "你好" }),
  );
  assert.deepEqual(methods, ["text_to_speech"]);
});

test("MIoT conversation polling parses user questions and includes the selected device", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  const client = new MiotClient(store, async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "userprofile.mina.mi.com");
    assert.equal(url.searchParams.get("hardware"), "LX06");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.match(options.headers.cookie, /deviceId=speaker-1/u);
    return json(
      {
        data: JSON.stringify({
          records: [
            { time: 1760000000000, query: "周杰伦的晴天", answers: [] },
          ],
        }),
      },
      { headers: { date: new Date(1760000001000).toUTCString() } },
    );
  });
  const result = await client.getLatestQuestions("speaker-1", "LX06");
  assert.deepEqual(result.messages, [
    { timestamp: 1760000000000, text: "周杰伦的晴天" },
  ]);
});

test("MIoT playback status normalizes speaker metadata and caches reads until a control command", async (t) => {
  const { store } = await createStore(t);
  await store.update((state) => {
    state.config.xiaomi = {
      userId: "user-1",
      passToken: store.encrypt("pass"),
      serviceToken: store.encrypt("service"),
      serviceTokenExpiresAt: Date.now() + 600_000,
    };
  });
  let statusReads = 0;
  const client = new MiotClient(store, async (_input, options) => {
    const form = new URLSearchParams(options.body);
    if (form.get("method") === "player_get_play_status") {
      statusReads++;
      return json({
        code: 0,
        data: {
          device_data: JSON.stringify({
            code: 0,
            info: JSON.stringify({
              status: 1,
              volume: 42,
              play_song_detail: {
                position: 61_000,
                duration: 240_000,
                title: "晴天",
                singer: "周杰伦",
                album: "叶惠美",
              },
            }),
          }),
        },
      });
    }
    return json({
      code: 0,
      data: { device_data: JSON.stringify({ code: 0 }) },
    });
  });

  const first = await client.getPlaybackStatus("speaker-1");
  assert.equal(first.position, 61);
  assert.equal(first.duration, 240);
  assert.equal(first.volume, 42);
  assert.deepEqual(
    [first.title, first.artist, first.album],
    ["晴天", "周杰伦", "叶惠美"],
  );
  await client.getPlaybackStatus("speaker-1");
  assert.equal(statusReads, 1);

  await client.execute("speaker-1", "pause", {});
  await client.getPlaybackStatus("speaker-1");
  assert.equal(statusReads, 2);
});

test("MIoT QR login expires abandoned sessions when the session limit is reached", async (t) => {
  const { store } = await createStore(t);
  let calls = 0;
  const client = new MiotClient(store, async (input) => {
    calls++;
    const url = new URL(String(input));
    if (url.pathname === "/pass/serviceLogin")
      return new Response(
        "&&&START&&&" +
          JSON.stringify({ _sign: "sign", qs: "qs", callback: "callback" }),
        { status: 200 },
      );
    if (url.pathname === "/longPolling/loginUrl")
      return json({
        code: 0,
        lp: "https://account.xiaomi.com/qr/poll",
        qr: "https://account.xiaomi.com/qr.png",
      });
    throw new Error("unexpected request");
  });
  const sessions = [];
  for (let index = 0; index < 9; index++)
    sessions.push(await client.startQrLogin());
  assert.equal(calls, 18);
  assert.equal(
    (await client.pollQrLogin(sessions[0].loginId)).state,
    "expired",
  );
});

test("QR login already in flight cannot reconnect an account after disconnect", async (t) => {
  const { store } = await createStore(t);
  let resolvePoll;
  let enteredPoll;
  const pollStarted = new Promise((resolve) => {
    enteredPoll = resolve;
  });
  const pollResponse = new Promise((resolve) => {
    resolvePoll = resolve;
  });
  const client = new MiotClient(store, async (input) => {
    const url = new URL(String(input));
    if (
      url.pathname === "/pass/serviceLogin" &&
      url.searchParams.get("sid") === "mijia"
    ) {
      return new Response(
        "&&&START&&&" +
          JSON.stringify({ _sign: "sign", qs: "qs", callback: "callback" }),
        { status: 200 },
      );
    }
    if (url.pathname === "/longPolling/loginUrl")
      return json({
        code: 0,
        lp: "https://account.xiaomi.com/qr/poll",
        qr: "https://account.xiaomi.com/qr.png",
      });
    if (url.pathname === "/qr/poll") {
      enteredPoll();
      return pollResponse;
    }
    if (
      url.pathname === "/pass/serviceLogin" &&
      url.searchParams.get("sid") === "micoapi"
    ) {
      return new Response(
        JSON.stringify({
          location: "https://account.xiaomi.com/sts/start",
          ssecurity: "security",
          nonce: "nonce",
        }),
        { status: 200 },
      );
    }
    if (url.pathname === "/sts/start")
      return new Response(null, {
        status: 302,
        headers: {
          location: "/sts/finish",
          "set-cookie": "serviceToken=service; Path=/; Secure",
        },
      });
    if (url.pathname === "/sts/finish")
      return new Response("ok", { status: 200 });
    throw new Error("unexpected request: " + url);
  });
  const qr = await client.startQrLogin();
  const pending = client.pollQrLogin(qr.loginId);
  await pollStarted;
  await client.disconnect();
  resolvePoll(json({ code: 0, passToken: "pass", userId: "user-1" }));
  assert.equal((await pending).state, "expired");
  assert.equal(store.snapshot().config.xiaomi, null);
});

test("HTTP JSON music source normalizes common field names", async () => {
  let requestUrl;
  const source = new HttpJsonMusicSource(
    {
      id: "test",
      name: "test",
      endpoint: "https://music.example/search",
      enabled: true,
      apiKey: "token",
    },
    async (input, options) => {
      requestUrl = new URL(String(input));
      assert.equal(options.headers.authorization, "Bearer token");
      return json({
        results: [
          {
            id: 4,
            name: "晴天",
            singer: "周杰伦",
            url: "https://media.example/track.mp3",
            duration: 240,
          },
        ],
      });
    },
  );
  const tracks = await source.search({ title: "晴天", artist: "周杰伦" });
  assert.equal(requestUrl.searchParams.get("q"), "周杰伦 晴天");
  assert.deepEqual(tracks[0], {
    id: "4",
    sourceId: "test",
    title: "晴天",
    artist: "周杰伦",
    durationSeconds: 240,
    playUrl: "https://media.example/track.mp3",
  });
});

test("HTTP JSON music source reads a named playlist and normalizes its tracks", async () => {
  let requestUrl;
  const source = new HttpJsonMusicSource(
    {
      id: "test",
      name: "test",
      endpoint: "https://music.example/search",
      playlistEndpoint: "https://music.example/playlists",
      enabled: true,
      apiKey: "",
    },
    async (input) => {
      requestUrl = new URL(String(input));
      return json({
        playlists: [
          {
            name: "通勤",
            tracks: [
              {
                id: "one",
                title: "晴天",
                artist: "周杰伦",
                url: "https://media.example/one.mp3",
              },
              {
                id: "two",
                name: "稻香",
                singer: "周杰伦",
                src: "https://media.example/two.mp3",
              },
            ],
          },
        ],
      });
    },
  );
  const tracks = await source.searchPlaylist("通勤");
  assert.equal(requestUrl.searchParams.get("playlist"), "通勤");
  assert.deepEqual(
    tracks.map((item) => item.title),
    ["晴天", "稻香"],
  );
  assert.equal(tracks[1].playUrl, "https://media.example/two.mp3");
});

test("HTTP JSON music source accepts an empty direct playlist", async () => {
  const source = new HttpJsonMusicSource(
    {
      id: "test",
      name: "test",
      endpoint: "https://music.example/search",
      playlistEndpoint: "https://music.example/playlists",
      enabled: true,
      apiKey: "",
    },
    async () => json({ tracks: [] }),
  );
  assert.deepEqual(await source.searchPlaylist("空歌单"), []);
});

test("MIoT topone source sends its request contract and normalizes a direct audio URL", async () => {
  const source = new HttpJsonMusicSource(
    {
      id: "topone",
      name: "topone",
      protocol: "topone",
      endpoint: "https://music.example/api/search/topone",
      enabled: true,
      apiKey: "token",
    },
    async (input, options) => {
      assert.equal(String(input), "https://music.example/api/search/topone");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer token");
      assert.deepEqual(JSON.parse(options.body), {
        keyword: "周杰伦 晴天",
        hint: { title: "晴天", artist: "周杰伦" },
        quality: "320k",
      });
      return json({
        code: 0,
        msg: "ok",
        data: {
          title: "晴天",
          artist: "周杰伦",
          album: "叶惠美",
          duration: 269,
          url: "https://media.example/sunny.mp3",
        },
      });
    },
  );
  const tracks = await source.search({ title: "晴天", artist: "周杰伦" });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].playUrl, "https://media.example/sunny.mp3");
  assert.equal(tracks[0].durationSeconds, 269);
});
