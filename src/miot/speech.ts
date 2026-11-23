import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { limitedBytes } from "../security/http.ts";
import ttsCommands from "./tts-commands.json" with { type: "json" };
import wakeCommands from "./wake-commands.json" with { type: "json" };

const actionPath = "/miotspec/action";
const actionUrl = "https://api.io.mi.com/app" + actionPath;

export interface SpeechCredentials {
  userId: string;
  deviceId: string;
  serviceToken: string;
  ssecurity: string;
}

function actionFor(hardware: string, commands: Record<string, string>) {
  const model = hardware.trim().toUpperCase().split(".").at(-1) ?? "";
  if (!Object.hasOwn(commands, model)) return;
  const [siid, aiid] = commands[model].split("-").map(Number);
  return { siid, aiid };
}

export function miotSpeechAction(hardware: string) {
  return actionFor(hardware, ttsCommands);
}

// Wake Up actions with an empty input list from the official MIoT model specs.
export function miotWakeAction(hardware: string) {
  return actionFor(hardware, wakeCommands);
}

export type MiotActionDelivery = "accepted" | "rejected" | "unconfirmed";

const b64 = (bytes: Buffer) => bytes.toString("base64");

// Xiaomi's signed MIoT cloud transport requires RC4 with the first 1024 bytes
// discarded. HTTPS still protects the connection to the fixed service host.
function crypt(input: Buffer, key: Buffer) {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < state.length; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const out = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let offset = -1024; offset < input.length; offset++) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    if (offset >= 0)
      out[offset] = input[offset] ^ state[(state[i] + state[j]) & 255];
  }
  return out;
}

export async function sendMiotAction(
  creds: SpeechCredentials,
  did: string,
  action: { siid: number; aiid: number },
  inputs: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<MiotActionDelivery> {
  const nonce = randomBytes(12);
  const key = createHash("sha256")
    .update(Buffer.from(creds.ssecurity, "base64"))
    .update(nonce)
    .digest();
  const sign = (fields: Record<string, string>) =>
    createHash("sha1")
      .update(
        [
          "POST",
          actionPath,
          ...Object.entries(fields).map(([k, v]) => k + "=" + v),
          b64(key),
        ].join("&"),
      )
      .digest("base64");
  const data = JSON.stringify({
    params: { did, ...action, in: inputs },
  });
  const content = Buffer.from(data);
  const encrypted = crypt(
    Buffer.concat([content, Buffer.from(sign({ data }))]),
    key,
  );
  const fields = {
    data: b64(encrypted.subarray(0, content.length)),
    rc4_hash__: b64(encrypted.subarray(content.length)),
  };
  signal?.throwIfAborted();
  const response = await fetchImpl(actionUrl, {
    method: "POST",
    redirect: "error",
    headers: {
      "user-agent": "MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "miot-accept-encoding": "GZIP",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      cookie:
        "countryCode=CN; locale=zh_CN; timezone=GMT+08:00; timezone_id=Asia/Shanghai" +
        "; userId=" +
        creds.userId +
        "; PassportDeviceId=" +
        creds.deviceId +
        "; serviceToken=" +
        creds.serviceToken +
        "; yetAnotherServiceToken=" +
        creds.serviceToken,
    },
    body: new URLSearchParams({
      ...fields,
      signature: sign(fields),
      _nonce: b64(nonce),
      ssecurity: creds.ssecurity,
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(12000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return "unconfirmed";
  }
  const encoded = Buffer.from(
    (await limitedBytes(response, 65536)).toString(),
    "base64",
  );
  const decoded = crypt(encoded, key);
  const body =
    response.headers.get("miot-content-encoding")?.toUpperCase() === "GZIP"
      ? gunzipSync(decoded, { maxOutputLength: 65536 })
      : decoded;
  const payload = JSON.parse(body.toString());
  const code = (value: unknown) =>
    typeof value === "number" ||
    (typeof value === "string" && /^-?\d+$/u.test(value))
      ? Number(value)
      : NaN;
  const cloudCode = code(payload?.code);
  const deviceCode = code(payload?.result?.code);
  if (cloudCode === 3012 || deviceCode === 3012) return "unconfirmed";
  if (cloudCode === 0 && deviceCode === 0) return "accepted";
  if (
    (Number.isInteger(cloudCode) && cloudCode !== 0) ||
    (cloudCode === 0 && Number.isInteger(deviceCode))
  )
    return "rejected";
  return "unconfirmed";
}
