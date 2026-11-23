// Platform implementations of the small renderer helpers used by the LX SDK.
import { createHash } from "node:crypto";
export const toMD5 = (value) =>
  createHash("md5").update(String(value)).digest("hex");
export const decodeName = (value) =>
  String(value ?? "").replace(
    /&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi,
    (token) => {
      const names = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " ",
      };
      if (names[token]) return names[token];
      const n = token.startsWith("&#x")
        ? parseInt(token.slice(3), 16)
        : parseInt(token.slice(2), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff
        ? String.fromCodePoint(n)
        : token;
    },
  );
export const formatPlayTime = (raw) => {
  const n = Math.max(0, Math.floor(Number(raw) || 0));
  return (
    String(Math.floor(n / 60)).padStart(2, "0") +
    ":" +
    String(n % 60).padStart(2, "0")
  );
};
export const sizeFormate = (raw) => {
  let n = Number(raw) || 0;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return n.toFixed(2) + " " + units[i];
};
export const formatPlayCount = (raw) => {
  const n = Number(raw) || 0;
  return n >= 1e8
    ? (n / 1e8).toFixed(1) + "亿"
    : n >= 1e4
      ? (n / 1e4).toFixed(1) + "万"
      : String(n);
};
export const dateFormat = (raw, format = "Y-M-D") => {
  const d = new Date(raw);
  const fields = {
    Y: d.getFullYear(),
    M: String(d.getMonth() + 1).padStart(2, "0"),
    D: String(d.getDate()).padStart(2, "0"),
    h: String(d.getHours()).padStart(2, "0"),
    m: String(d.getMinutes()).padStart(2, "0"),
    s: String(d.getSeconds()).padStart(2, "0"),
  };
  return format.replace(/[YMDhms]/g, (k) => fields[k]);
};
