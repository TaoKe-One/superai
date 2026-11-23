import { randomUUID } from "node:crypto";
import type { JsonStore } from "../../storage/store.ts";
import type { MusicTrack } from "../types.ts";
import type { LxMusicService } from "./service.ts";
import { fromLxSong } from "./service.ts";
import { lxPlatform } from "./catalog.ts";

interface CheckResult {
  sourceId: string;
  platform: string;
  state: "ok" | "failed" | "catalog_error";
  sample?: string;
  checkedAt: number;
}
interface CheckJob {
  id: string;
  state: "running" | "completed" | "cancelled" | "failed";
  startedAt: number;
  finishedAt?: number;
  total: number;
  completed: number;
  results: CheckResult[];
}
const jobs = new WeakMap<
  JsonStore,
  { job: CheckJob; controller: AbortController }
>();
export function sourceCheckStatus(store: JsonStore) {
  return structuredClone(
    jobs.get(store)?.job ?? {
      state: "idle",
      total: 0,
      completed: 0,
      results: [],
    },
  );
}
export function stopSourceCheck(store: JsonStore) {
  const active = jobs.get(store);
  if (active?.job.state === "running") {
    active.controller.abort();
    active.job.state = "cancelled";
    active.job.finishedAt = Date.now();
  }
  return sourceCheckStatus(store);
}
export function startSourceCheck(
  store: JsonStore,
  lx: LxMusicService,
  id?: string,
) {
  const config = store.snapshot().config;
  if (id && !config.lxSources.some((s) => s.id === id))
    throw new Error("找不到该音源");
  if (jobs.get(store)?.job.state === "running") return sourceCheckStatus(store);
  const tasks = config.lxSources
    .filter((s) => (id ? s.id === id : s.enabled))
    .flatMap((source) =>
      Object.keys(source.sources)
        .filter((platform) =>
          source.sources[platform].actions.includes("musicUrl"),
        )
        .map((platform) => ({ sourceId: source.id, platform })),
    );
  if (!tasks.length) throw new Error("没有可检测的音源");
  const job: CheckJob = {
    id: randomUUID(),
    state: "running",
    startedAt: Date.now(),
    total: tasks.length,
    completed: 0,
    results: [],
  };
  const controller = new AbortController();
  jobs.set(store, { job, controller });
  const samples = new Map<string, Promise<MusicTrack>>();
  const sample = (platform: string) => {
    if (!samples.has(platform))
      samples.set(
        platform,
        (async () => {
          const saved = [
            ...config.playbackQueue.tracks,
            ...config.favorites,
            ...config.playbackHistory.map((e) => e.track),
            ...config.lxPlaylists.flatMap((p) => p.tracks),
          ].find((t) => t.lx?.platform === platform);
          if (saved) return saved;
          const response = await lx.catalog.search(
            lxPlatform(platform),
            "周杰伦 晴天",
            1,
            "song",
            AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
          );
          if (!response.list.length) throw new Error("目录没有检测样本");
          return fromLxSong(response.list[0], platform);
        })(),
      );
    return samples.get(platform)!;
  };
  let next = 0;
  const worker = async () => {
    while (!controller.signal.aborted) {
      const task = tasks[next++];
      if (!task) break;
      let track: MusicTrack;
      try {
        track = await sample(task.platform);
      } catch {
        if (controller.signal.aborted) break;
        job.results.push({
          ...task,
          state: "catalog_error",
          checkedAt: Date.now(),
        });
        job.completed++;
        continue;
      }
      let state: CheckResult["state"] = "ok";
      try {
        await lx.checkPlatform(task.sourceId, track, controller.signal);
      } catch {
        state = "failed";
      }
      if (controller.signal.aborted) break;
      job.results.push({
        ...task,
        state,
        sample: track.title + " · " + track.artist,
        checkedAt: Date.now(),
      });
      job.completed++;
    }
  };
  void Promise.all([worker(), worker()])
    .then(() => {
      if (job.state === "running") {
        job.state = "completed";
        job.finishedAt = Date.now();
      }
    })
    .catch(() => {
      if (job.state === "running") {
        job.state = "failed";
        job.finishedAt = Date.now();
      }
    });
  return sourceCheckStatus(store);
}
