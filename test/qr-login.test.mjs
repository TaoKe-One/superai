import assert from "node:assert/strict";
import test from "node:test";
import { createQrLogin } from "../public/qr-login.js";

const deferred = () => Promise.withResolvers();
const settled = () => new Promise((resolve) => setImmediate(resolve));

function harness(request) {
  const states = [];
  const errors = [];
  const timers = new Set();
  let connected = 0;
  const controller = createQrLogin({
    request,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    onConnected: async () => {
      connected++;
    },
    setTimer(callback) {
      timers.add(callback);
      return callback;
    },
    clearTimer(callback) {
      timers.delete(callback);
    },
  });
  return {
    controller,
    states,
    errors,
    timers,
    get connected() {
      return connected;
    },
  };
}

test("QR replacement aborts the old poll and ignores its late connected response", async () => {
  const oldPoll = deferred();
  const newPoll = deferred();
  const signals = [];
  const cancelled = [];
  let created = 0;
  const h = harness(async (path, options) => {
    if (path.endsWith("/cancel")) {
      cancelled.push(JSON.parse(options.body).loginId);
      return {};
    }
    if (path.endsWith("/poll")) {
      signals.push(options.signal);
      return JSON.parse(options.body).loginId === "old"
        ? oldPoll.promise
        : newPoll.promise;
    }
    return {
      loginId: ++created === 1 ? "old" : "new",
      qrImageUrl: "https://account.xiaomi.com/image",
    };
  });
  await h.controller.start();
  await h.controller.start();
  assert.equal(signals[0].aborted, true);
  oldPoll.resolve({ state: "connected", message: "old connected" });
  await settled();
  assert.equal(h.connected, 0);
  assert.equal(h.states.at(-1).loginId, "new");
  assert.deepEqual(cancelled, ["old"]);
  newPoll.resolve({ state: "connected", message: "new connected" });
  await settled();
  assert.equal(h.connected, 1);
  assert.equal(h.states.at(-1).message, "new connected");
  assert.equal(h.timers.size, 0);
});

test("cancelling QR login cancels its timer and prevents further polling", async () => {
  let polls = 0;
  const h = harness(async (path) => {
    if (path.endsWith("/cancel")) return {};
    if (path.endsWith("/poll")) {
      polls++;
      return { state: "waiting", message: "waiting" };
    }
    return { loginId: "one" };
  });
  await h.controller.start();
  await settled();
  assert.equal(h.timers.size, 1);
  const staleTimer = [...h.timers][0];
  h.controller.cancel();
  assert.equal(h.timers.size, 0);
  await staleTimer();
  assert.equal(polls, 1);
  assert.equal(h.states.at(-1).state, "cancelled");
});

test("a QR creation response arriving after cancellation never displays a QR", async () => {
  const creation = deferred();
  const cancelled = [];
  const h = harness(async (path, options) => {
    if (path.endsWith("/cancel")) {
      cancelled.push(JSON.parse(options.body).loginId);
      return {};
    }
    assert.equal(path, "/api/miot/qrcode");
    return creation.promise;
  });
  const starting = h.controller.start();
  h.controller.cancel();
  creation.resolve({
    loginId: "late",
    qrImageUrl: "https://account.xiaomi.com/late",
  });
  await starting;
  assert.equal(h.states.at(-1).state, "cancelled");
  assert.deepEqual(cancelled, ["late"]);
  assert.equal(h.timers.size, 0);
});

test("QR polling stops on admin session expiry instead of retrying forever", async () => {
  const h = harness(async (path) => {
    if (path.endsWith("/cancel")) return {};
    if (path.endsWith("/poll"))
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    return { loginId: "one" };
  });
  await h.controller.start();
  await settled();
  assert.equal(h.states.at(-1).state, "expired");
  assert.equal(h.errors.length, 1);
  assert.equal(h.timers.size, 0);
});

test("a transient polling failure retries once without creating another QR", async () => {
  let polls = 0;
  let creations = 0;
  const h = harness(async (path) => {
    if (path.endsWith("/poll")) {
      if (++polls === 1) throw new Error("network unavailable");
      return { state: "connected", message: "connected" };
    }
    creations++;
    return { loginId: "one" };
  });
  await h.controller.start();
  await settled();
  assert.match(h.states.at(-1).message, /正在重试/u);
  assert.equal(h.timers.size, 1);
  const retry = [...h.timers][0];
  h.timers.delete(retry);
  await retry();
  assert.equal(h.connected, 1);
  assert.equal(creations, 1);
  assert.equal(polls, 2);
});
