// Bound output when upstream lyric decoders inflate remote data.
import { inflate as nativeInflate, constants } from "node:zlib";
export { constants };
export function inflate(input, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return nativeInflate(
    input,
    { ...options, maxOutputLength: 1024 * 1024 },
    callback,
  );
}
