import { abortable, publicRequest, publicUrl } from "./http.ts";

export function audioFormat(raw: Uint8Array): string | null {
  const bytes = Buffer.from(raw);
  if (bytes.length < 16) return null;
  if (
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
    return "mp3/aac";
  if (bytes.subarray(0, 4).toString() === "fLaC") return "flac";
  if (bytes.subarray(0, 4).toString() === "OggS") return "ogg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
  )
    return "wav";
  if (bytes.subarray(4, 8).toString() === "ftyp") return "mp4";
  return null;
}

/** Validate a small prefix only; never download a whole song or send it to the speaker. */
export async function probeAudio(
  url: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
) {
  publicUrl(url);
  const limit = 16384;
  let status: number, raw: Buffer;
  if (fetchImpl) {
    const response = await abortable(
      fetchImpl(url, {
        headers: { range: "bytes=0-16383", "accept-encoding": "identity" },
        redirect: "error",
        signal,
      }),
      signal,
    );
    status = response.status;
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    try {
      while (reader && size < limit) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        const data = Buffer.from(part.value).subarray(0, limit - size);
        chunks.push(data);
        size += data.length;
      }
    } finally {
      void reader?.cancel().catch(() => {});
    }
    raw = Buffer.concat(chunks);
  } else {
    const response = await publicRequest(url, {}, signal, 0, limit);
    status = response.statusCode;
    raw = response.raw;
  }
  if (status !== 200 && status !== 206) throw new Error("音频地址不可访问");
  const format = audioFormat(raw);
  if (!format) throw new Error("地址没有返回可识别的音频数据");
  return { format, bytes: raw.length };
}
