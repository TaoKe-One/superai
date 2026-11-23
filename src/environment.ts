import { loadEnvFile } from "node:process";

/** Load local startup settings; explicit process variables keep precedence. */
export function loadLocalEnvironment(path = ".env") {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
