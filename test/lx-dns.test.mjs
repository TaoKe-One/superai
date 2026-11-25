import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { publicRequest } from "../src/music/lx/http.ts";

const destination = { address: "8.8.8.8", family: 4 };
const fake = { address: "198.19.0.1", family: 4 };
const local = { address: "192.168.0.1", family: 4 };

function fixture(t, { mode, system, doh, redirect } = {}) {
  const saved = process.env.LX_DNS_OVER_HTTPS;
  if (mode === undefined) delete process.env.LX_DNS_OVER_HTTPS;
  else process.env.LX_DNS_OVER_HTTPS = mode;
  const calls = [];
  t.mock.method(dns, "lookup", async (host, { all }) => {
    assert.equal(all, true);
    calls.push(["system", host]);
    return system(host);
  });
  t.mock.method(https, "request", (input, options, onResponse) => {
    const isDoh = !(input instanceof URL);
    if (isDoh) {
      onResponse = options;
      options = input;
    }
    const req = new EventEmitter();
    req.end = () => {
      options.lookup("", { all: true }, (error, addresses) => {
        assert.ifError(error);
        if (isDoh) {
          assert.equal(options.hostname, "cloudflare-dns.com");
          assert.equal(options.servername, "cloudflare-dns.com");
          assert.notEqual(options.rejectUnauthorized, false);
          assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]);
          calls.push([
            "doh",
            new URL(
              options.path,
              "https://cloudflare-dns.com",
            ).searchParams.get("name"),
          ]);
        } else {
          assert.deepEqual(addresses, [destination]);
          calls.push(["https", input.hostname]);
        }
      });
      const answer = isDoh ? doh() : { ok: true };
      if (answer === "timeout") {
        const keepAlive = setTimeout(() => {}, 5000);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            req.emit("error", options.signal.reason);
          },
          { once: true },
        );
        return;
      }
      const res = new PassThrough();
      res.statusCode = !isDoh && redirect ? 302 : 200;
      res.headers = !isDoh && redirect ? { location: redirect } : {};
      onResponse(res);
      res.end(JSON.stringify(answer));
    };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.LX_DNS_OVER_HTTPS;
    else process.env.LX_DNS_OVER_HTTPS = saved;
  });
  return calls;
}

test("automatic DNS connects to verified system addresses without contacting DoH", async (t) => {
  const calls = fixture(t, {
    system: () => [destination],
    doh: () => assert.fail("unexpected DoH request"),
  });
  assert.equal(
    (await publicRequest("https://normal.example/")).statusCode,
    200,
  );
  assert.deepEqual(calls, [
    ["system", "normal.example"],
    ["https", "normal.example"],
  ]);
});

test("automatic DNS re-resolves Fake-IP and pins the verified DoH address", async (t) => {
  const calls = fixture(t, {
    mode: "auto",
    system: () => [fake],
    doh: () => ({
      Status: 0,
      Answer: [{ type: 1, data: destination.address }],
    }),
  });
  assert.equal((await publicRequest("https://fake.example/")).statusCode, 200);
  assert.deepEqual(calls, [
    ["system", "fake.example"],
    ["doh", "fake.example"],
    ["https", "fake.example"],
  ]);
});

test("automatic DNS rejects private and mixed answers and revalidates redirects", async (t) => {
  const calls = fixture(t, {
    system: (host) =>
      host === "start.example" ? [destination] : [fake, local],
    doh: () => assert.fail("unexpected DoH request"),
    redirect: "https://blocked.example/",
  });
  await assert.rejects(publicRequest("https://start.example/"), /私有网络/);
  await assert.rejects(publicRequest("https://blocked.example/"), /私有网络/);
  assert.deepEqual(calls, [
    ["system", "start.example"],
    ["https", "start.example"],
    ["system", "blocked.example"],
    ["system", "blocked.example"],
  ]);
});

test("automatic DNS rejects Fake-IP when DoH returns a private or mixed answer", async (t) => {
  const calls = fixture(t, {
    system: () => [fake],
    doh: () => ({
      Status: 0,
      Answer: [destination, local].map(({ address }) => ({
        type: 1,
        data: address,
      })),
    }),
  });
  await assert.rejects(
    publicRequest("https://unsafe-doh.example/"),
    /Fake-IP.*加密 DNS/,
  );
  assert.deepEqual(calls, [
    ["system", "unsafe-doh.example"],
    ["doh", "unsafe-doh.example"],
  ]);
});

test("explicit system DNS never connects to Fake-IP or uses DoH", async (t) => {
  const calls = fixture(t, {
    mode: "false",
    system: () => [fake],
    doh: () => assert.fail("unexpected DoH request"),
  });
  await assert.rejects(
    publicRequest("https://system-only.example/"),
    /Fake-IP.*关闭/,
  );
  assert.deepEqual(calls, [["system", "system-only.example"]]);
});

test("cancelling a legacy DoH request prevents system fallback", async (t) => {
  const controller = new AbortController();
  const calls = fixture(t, {
    mode: "true",
    system: () => assert.fail("unexpected system lookup"),
    doh: () => {
      queueMicrotask(() => controller.abort());
      return "timeout";
    },
  });
  await assert.rejects(
    publicRequest("https://cancel.example/", {}, controller.signal),
  );
  assert.deepEqual(calls, [["doh", "cancel.example"]]);
});

test("legacy DoH timeout falls back to public system DNS within the request budget", async (t) => {
  const calls = fixture(t, {
    mode: "true",
    system: (host) =>
      host === "proxy.example"
        ? [fake]
        : host === "private.example"
          ? [local]
          : [destination],
    doh: () => "timeout",
  });
  const result = await publicRequest(
    "https://normal.example/",
    {},
    AbortSignal.timeout(4000),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(
    (await publicRequest("https://another.example/")).statusCode,
    200,
  );
  await assert.rejects(
    publicRequest("https://proxy.example/"),
    /Fake-IP.*加密 DNS/,
  );
  await assert.rejects(publicRequest("https://private.example/"), /私有网络/);
  assert.deepEqual(calls, [
    ["doh", "normal.example"],
    ["system", "normal.example"],
    ["https", "normal.example"],
    ["system", "another.example"],
    ["https", "another.example"],
    ["system", "proxy.example"],
    ["system", "private.example"],
  ]);
});
