// Host-independent adapter for the pinned LXMusic player artifact.
(() => {
  const $ = (selector) => document.querySelector(selector);
  const players = new WeakSet(),
    apps = new WeakSet();
  const modeToNative = {
    sequence: "loop",
    singleLoop: "single",
    random: "random",
    singlePlay: "order",
  };
  const nativeToMode = {
    loop: "sequence",
    single: "singleLoop",
    random: "random",
    order: "singlePlay",
  };
  let state = null,
    player = null,
    app = null,
    catalogConfig = null,
    chain = Promise.resolve(),
    refreshing = null,
    pending = 0,
    dialogGeneration = 0,
    lyricKey = "",
    lyricController = null,
    lyricRetryAt = 0,
    lyricEmptyText = "",
    deviceClock = null,
    browserOutput = false,
    audio = null,
    voiceId = "",
    errorCountdown,
    lastPlaybackError = "",
    lastRefreshError = "",
    centeredLyricPanel = null;
  function dismissError() {
    clearInterval(errorCountdown);
    errorCountdown = undefined;
    $("#sp-lx-error").hidden = true;
  }
  const report = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const details = Array.isArray(error?.attempts)
      ? error.attempts
          .map(
            (a) =>
              (a.sourceName || a.sourceId) +
              " / " +
              a.platform +
              " / " +
              a.quality +
              "：" +
              ({ resolve: "解析失败", audio: "音频检查失败", ready: "就绪" }[
                a.stage
              ] ?? a.stage),
          )
          .join("；")
      : "";
    clearInterval(errorCountdown);
    $("#sp-lx-error").hidden = false;
    $("#sp-lx-error-message").textContent =
      message + (details ? "（" + details + "）" : "");
    const deadline = Date.now() + 5000;
    const updateCountdown = () => {
      const seconds = Math.ceil((deadline - Date.now()) / 1000);
      if (seconds <= 0) dismissError();
      else $("#sp-lx-error-countdown").textContent = seconds + " 秒后自动关闭";
    };
    updateCountdown();
    errorCountdown = setInterval(updateCountdown, 1000);
  };
  async function api(path, method = "GET", body, signal) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(35000),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? "管理会话已过期，请刷新平台并重新登录"
          : (data.error ?? "请求失败"),
      );
      error.attempts = data.attempts;
      throw error;
    }
    return data;
  }
  function trackIdentity(track) {
    const info = track.lx?.songInfo ?? track.source_data?.songInfo ?? track;
    return JSON.stringify([
      track.library?.providerId ??
        track.lx?.platform ??
        track.source_data?.platform ??
        track.source ??
        track.sourceId,
      String(
        info.songmid ??
          track.id ??
          info.id ??
          info.hash ??
          info.copyrightId ??
          "",
      ),
    ]);
  }
  async function catalogTracks(path, request, signal, matches) {
    const tracks = [];
    const seenPages = new Set();
    let pageStart;
    for (let page = 1; ; page++) {
      const result = await api(path, "POST", { ...request, page }, signal);
      const items = result.items ?? result.list;
      const hasMore = result.hasMore ?? result.has_more;
      const fingerprint = JSON.stringify(items.map(trackIdentity));
      if (seenPages.has(fingerprint) || (!items.length && hasMore))
        throw new Error("列表分页返回重复或缺失的数据，无法建立完整队列");
      seenPages.add(fingerprint);
      if (page === (request.page ?? 1)) pageStart = tracks.length;
      tracks.push(...items.filter(matches));
      if (!hasMore) return { tracks, pageStart };
    }
  }
  const song = (track) => ({
    id: track.id,
    sourceId: track.sourceId,
    name: track.title,
    title: track.title,
    singer: track.artist,
    artist: track.artist,
    album: track.album ?? "",
    cover_url: track.coverUrl ?? "",
    duration: track.durationSeconds ?? 0,
    durationSeconds: track.durationSeconds,
    coverUrl: track.coverUrl,
    source: track.lx?.platform ?? track.sourceId,
    lx: track.lx,
    library: track.library,
    quality: track.quality,
    source_data: track.lx
      ? {
          platform: track.lx.platform,
          songInfo: track.lx.songInfo,
          quality: track.quality,
        }
      : undefined,
  });
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = readState().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function readState() {
    try {
      let result = await api("/api/playback/state");
      const voice = result.voicePlayback;
      if (browserOutput && voice && voice.id !== voiceId) {
        if (voice.deviceId !== result.device?.deviceId) {
          await api("/api/miot/device", "PUT", { deviceId: voice.deviceId });
          result = await api("/api/playback/state");
        }
        releaseAudio();
        browserOutput = false;
      }
      voiceId = result.voicePlayback?.id ?? "";
      lastRefreshError = "";
      state = result;
      if (!result.device && !browserOutput) {
        browserOutput = true;
        if (player) {
          player.playlist = result.playbackQueue.tracks.map(song);
          player.currentIndex = result.playbackQueue.currentIndex;
          player.playMode = nativeToMode[result.playbackMode] ?? "singlePlay";
        }
      }
      if (browserOutput) {
        showBrowserOutput();
        return result;
      }
      const playbackError = result.autoPlayback?.error ?? "";
      if (playbackError && playbackError !== lastPlaybackError)
        report(new Error(playbackError));
      lastPlaybackError = playbackError;
      $("#sp-lx-favorite").textContent = result.currentFavorited
        ? "已收藏"
        : "收藏当前";
      $("#sp-lx-device").textContent = result.device
        ? "音箱 · " + result.device.name
        : "请先在「音箱设备」连接并选择音箱";
      const resolution = result.playbackResolution;
      $("#sp-lx-device").title = resolution?.sourceId
        ? "实际音源 " +
          (resolution.sourceName || resolution.sourceId) +
          " · " +
          resolution.platform +
          " · " +
          resolution.quality +
          " · 尝试 " +
          (resolution.attempts?.length ?? 1) +
          " 次"
        : "";
      if (player) {
        player.playlist = result.playbackQueue.tracks.map(song);
        player.currentIndex = result.playbackQueue.currentIndex;
        player.playMode = nativeToMode[result.playbackMode] ?? "singlePlay";
        player.isCasting = true;
        player.castDevice = result.device
          ? {
              device_id: result.device.deviceId,
              account_id: "platform",
              name: result.device.name,
            }
          : null;
        player.currentTime = result.deviceStatus?.position ?? 0;
        player.duration =
          result.deviceStatus?.duration ||
          result.currentTrack?.durationSeconds ||
          0;
        if (typeof result.deviceStatus?.volume === "number")
          player.volume = result.deviceStatus.volume / 100;
        player.playbackState =
          result.deviceStatus?.status === 1
            ? "playing"
            : result.currentTrack
              ? "paused"
              : "idle";
        player.castSessionActive =
          result.deviceStatus?.status === 1 ||
          result.deviceStatus?.status === 2;
        deviceClock = result.deviceStatus?.sampledAt
          ? {
              position: result.deviceStatus.position ?? 0,
              sampledAt: result.deviceStatus.sampledAt,
              receivedAt: performance.now(),
              playing: result.deviceStatus.status === 1,
            }
          : null;
        void fetchLyrics(result.currentTrack);
        player.syncLyric();
        player.endLoading();
      }
      return result;
    } catch (error) {
      const message = String(error);
      if (message !== lastRefreshError) report(error);
      lastRefreshError = message;
    }
  }
  function perform(work) {
    pending++;
    const run = chain.then(async () => {
      if (refreshing) await refreshing;
      try {
        return await work();
      } catch (error) {
        report(error);
        return false;
      } finally {
        await refresh();
        player?.endLoading();
      }
    });
    chain = run
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return run;
  }
  async function fetchLyrics(track) {
    if (!player) return;
    const key = track
      ? JSON.stringify([
          track.sourceId,
          track.id,
          track.lx?.platform,
          track.lx?.songInfo?.songmid,
        ])
      : "";
    if (key === lyricKey && Date.now() < lyricRetryAt) return;
    lyricController?.abort();
    lyricKey = key;
    lyricRetryAt = Infinity;
    player.parsedLyrics = [];
    player.currentLyricIndex = -1;
    lyricEmptyText = key ? "正在获取歌词…" : "";
    player.currentLyricLine = lyricEmptyText;
    if (!key) return;
    const controller = new AbortController();
    lyricController = controller;
    try {
      const result = await api(
        "/api/lx/lyrics",
        "POST",
        { track },
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (controller.signal.aborted || key !== lyricKey) return;
      player.parsedLyrics = (result.lines ?? []).map((line) => ({
        ...line,
        text: line.text + (line.translation ? "\n" + line.translation : ""),
      }));
      lyricEmptyText = result.available
        ? result.timed
          ? "前奏"
          : result.lyric.slice(0, 1500)
        : result.reason === "unavailable"
          ? "歌词暂时获取失败，将自动重试"
          : "暂无歌词";
      if (!result.available && result.reason !== "no_metadata")
        lyricRetryAt = Date.now() + 60000;
      player.syncLyric();
    } catch {
      if (controller.signal.aborted || key !== lyricKey) return;
      lyricRetryAt = Date.now() + 60000;
      lyricEmptyText = "歌词暂时获取失败，将自动重试";
      player.currentLyricLine = lyricEmptyText;
    }
  }
  const control = (command) => api("/api/miot/control", "POST", { command });
  const browserMedia = (track) =>
    api("/api/lx/player/browser", "POST", { track });
  const currentTrack = () =>
    browserOutput ? player?.playlist[player.currentIndex] : state?.currentTrack;

  function showBrowserOutput() {
    $("#sp-lx-device").textContent = "当前输出 · 网页播放器";
    $("#sp-lx-device").title = "";
    deviceClock = null;
    if (!player) return;
    player.isCasting = false;
    player.castDevice = null;
    player.castSessionActive = false;
    syncAudio();
  }

  function syncAudio() {
    if (!browserOutput || !player) return;
    player.currentTime = audio?.currentTime ?? 0;
    player.duration =
      audio && Number.isFinite(audio.duration)
        ? audio.duration
        : (currentTrack()?.durationSeconds ?? currentTrack()?.duration ?? 0);
    player.playbackState =
      audio && !audio.paused && !audio.ended
        ? "playing"
        : currentTrack()
          ? "paused"
          : "idle";
    player.syncLyric();
  }

  function releaseAudio() {
    if (!audio) return;
    const previous = audio;
    audio = null;
    previous.pause();
    previous.removeAttribute("src");
    previous.load();
  }

  function browserAudio() {
    if (audio) return audio;
    const element = new Audio();
    element.volume = player.volume ?? 1;
    for (const event of [
      "timeupdate",
      "loadedmetadata",
      "playing",
      "pause",
      "durationchange",
    ])
      element.addEventListener(event, syncAudio);
    element.addEventListener("ended", () => {
      if (audio === element && browserOutput)
        void perform(() => stepBrowser(1, true));
    });
    element.addEventListener("error", () => {
      if (audio === element && browserOutput && element.getAttribute("src")) {
        syncAudio();
        report(new Error("网页无法加载当前歌曲，请重试或切换音源"));
      }
    });
    audio = element;
    return element;
  }

  async function playInBrowser(tracks, index, options = {}) {
    const track = tracks[index];
    if (!track) return false;
    const media = options.media ?? (await browserMedia(track));
    const element = browserAudio();
    element.pause();
    player.playlist = [...tracks];
    if (media.track) player.playlist[index] = song(media.track);
    player.currentIndex = index;
    $("#sp-lx-favorite").textContent = "收藏当前";
    element.src = media.url;
    // Assigning currentTime before metadata sets the initial playback position.
    if (options.position > 0) element.currentTime = options.position;
    void fetchLyrics(currentTrack());
    syncAudio();
    if (options.play !== false) await element.play();
    return true;
  }

  function stepBrowser(direction, ended = false) {
    const tracks = player.playlist;
    if (!tracks.length) return false;
    if (player.currentIndex < 0) return playInBrowser(tracks, 0);
    const current = player.currentIndex;
    let next = current + direction;
    if (ended && player.playMode === "singleLoop") next = current;
    else if (player.playMode === "random" && tracks.length > 1)
      next =
        (current + 1 + Math.floor(Math.random() * (tracks.length - 1))) %
        tracks.length;
    else if (
      ended &&
      player.playMode === "singlePlay" &&
      next >= tracks.length
    ) {
      syncAudio();
      return false;
    }
    return playInBrowser(tracks, (next + tracks.length) % tracks.length);
  }
  function attachPlayer(store) {
    if (players.has(store)) return store;
    players.add(store);
    player = store;
    store.stopCastHeartbeat();
    store.isCasting = true;
    store.initAudio = () => {};
    store.saveToLocal = () => {};
    store.flushToLocal = () => {};
    store.loadFromLocal = () => {};
    store.initCastHeartbeat = () => {};
    store.bootstrap = refresh;
    store.syncBackendState = refresh;
    store.fetchLyricCore = () => fetchLyrics(currentTrack());
    store.syncLyric = () => {
      const lines = store.parsedLyrics ?? [];
      let low = 0,
        high = lines.length - 1,
        index = -1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        if (lines[mid].time <= store.currentTime) {
          index = mid;
          low = mid + 1;
        } else high = mid - 1;
      }
      store.currentLyricIndex = index;
      store.currentLyricLine =
        index < 0
          ? lines.length
            ? "前奏"
            : lyricEmptyText
          : lines[index].text;
    };
    let lastPlay = {};
    const play = (tracks, index = 0, loadTracks) => {
      const selected = tracks[index];
      if (!selected) return Promise.resolve(false);
      if (
        !loadTracks &&
        lastPlay.tracks === tracks &&
        lastPlay.index === index &&
        Date.now() - lastPlay.at < 600
      )
        return lastPlay.promise;
      const promise = perform(async () => {
        store.beginLoading("resolving");
        if (loadTracks) {
          const identity = trackIdentity(selected);
          const occurrence = tracks
            .slice(0, index)
            .filter((track) => trackIdentity(track) === identity).length;
          const context = await loadTracks(AbortSignal.timeout(25000));
          tracks = context.tracks;
          const start = context.pageStart ?? tracks.length;
          let matches = 0;
          index = tracks.findIndex(
            (track, position) =>
              position >= start &&
              trackIdentity(track) === identity &&
              matches++ === occurrence,
          );
          if (index < 0) throw new Error("列表已更新，请刷新后重新选择歌曲");
        }
        if (browserOutput) return playInBrowser(tracks, index);
        await api("/api/lx/player/play", "POST", { tracks, index });
        return true;
      });
      lastPlay = { tracks, index, at: Date.now(), promise };
      return promise;
    };
    store.playCore = () => play(store.playlist, store.currentIndex);
    store.playSingle = (track) => play([track]);
    store.playAll = (tracks) => play(tracks);
    store.playContext = play;
    store.playAt = (index) => {
      const track = store.playlist[index];
      if (!track) return Promise.resolve(false);
      return perform(() =>
        browserOutput
          ? playInBrowser(store.playlist, index)
          : api("/api/music/queue/play", "POST", {
              index,
              id: track.id,
              sourceId: track.sourceId,
            }),
      );
    };
    store.playNext = () =>
      perform(() => (browserOutput ? stepBrowser(1) : control("next")));
    store.playPrev = () =>
      perform(() => (browserOutput ? stepBrowser(-1) : control("previous")));
    store.togglePlay = () =>
      perform(async () => {
        if (browserOutput) {
          if (!audio?.getAttribute("src") || audio.error)
            return playInBrowser(
              store.playlist,
              Math.max(0, store.currentIndex),
            );
          if (audio.paused) return audio.play();
          audio.pause();
          return;
        }
        if (!state?.currentTrack && store.playlist.length) {
          await api("/api/lx/player/play", "POST", {
            tracks: store.playlist,
            index: Math.max(0, store.currentIndex),
          });
          return;
        }
        return control(store.playbackState === "playing" ? "pause" : "resume");
      });
    store.togglePlayModeStore = () =>
      perform(() => {
        const modes = Object.keys(modeToNative);
        const mode = modes[(modes.indexOf(store.playMode) + 1) % modes.length];
        if (browserOutput) {
          store.playMode = mode;
          return;
        }
        return api("/api/playback/mode", "PUT", { mode: modeToNative[mode] });
      });
    store.setVolume = (value) =>
      perform(() => {
        const volume = Math.max(0, Math.min(1, value));
        if (browserOutput) {
          store.volume = browserAudio().volume = volume;
          return;
        }
        return api("/api/miot/control", "POST", {
          command: "volume",
          volume: Math.round(volume * 100),
        });
      });
    store.seek = (position) => {
      if (browserOutput) {
        if (audio && Number.isFinite(position)) audio.currentTime = position;
      } else report(new Error("当前音箱接口尚不支持拖动进度"));
    };
    store.append = (track) =>
      perform(() => {
        if (browserOutput) {
          store.playlist = [...store.playlist, track];
          return;
        }
        return api("/api/lx/player/queue", "POST", {
          operation: "append",
          tracks: [track],
        });
      });
    store.insertNext = (track) =>
      perform(async () => {
        if (browserOutput) {
          store.playlist.splice(store.currentIndex + 1, 0, track);
          return;
        }
        const next = await api("/api/lx/player/queue", "POST", {
          operation: "append",
          tracks: [track],
        });
        const q = next.playbackQueue;
        const to = Math.max(0, q.currentIndex + 1);
        if (q.tracks.length - 1 > to)
          return api("/api/lx/player/queue", "POST", {
            operation: "move",
            index: q.tracks.length - 1,
            to,
            revision: q.revision,
          });
        return next;
      });
    store.removeSong = (index) => {
      const revision = state?.playbackQueue.revision;
      return perform(() => {
        if (browserOutput) {
          store.playlist.splice(index, 1);
          if (index < store.currentIndex) store.currentIndex--;
          else if (index === store.currentIndex) {
            releaseAudio();
            store.currentIndex = -1;
            void fetchLyrics(null);
          }
          return;
        }
        return api("/api/lx/player/queue", "POST", {
          operation: "remove",
          index,
          revision,
        });
      });
    };
    store.clearList = () =>
      perform(() => {
        if (!browserOutput) return api("/api/music/queue/clear", "POST", {});
        releaseAudio();
        store.playlist = [];
        store.currentIndex = -1;
        void fetchLyrics(null);
      });
    store.disconnectCast = async () => {
      const result = await perform(async () => {
        const remote = await refresh();
        const deviceId = remote?.device?.deviceId;
        if (!deviceId) {
          browserOutput = true;
          showBrowserOutput();
          return true;
        }
        const tracks = remote.playbackQueue.tracks;
        const index = remote.playbackQueue.currentIndex;
        const track = tracks[index];
        const playing = remote.deviceStatus?.status === 1;
        let media, mediaError;
        if (playing && track) {
          try {
            media = await browserMedia(track);
          } catch (error) {
            mediaError = error;
          }
        }
        const latest = playing && track ? await refresh() : remote;
        if (
          !latest ||
          latest.device?.deviceId !== deviceId ||
          latest.playbackQueue.revision !== remote.playbackQueue.revision ||
          latest.voicePlayback?.id !== remote.voicePlayback?.id
        )
          throw new Error("音箱播放已变化，请重新断开连接");
        await api("/api/lx/player/detach", "POST", {
          deviceId,
          revision: latest.playbackQueue.revision,
          voiceId: latest.voicePlayback?.id ?? "",
        });
        browserOutput = true;
        store.playlist = tracks.map(song);
        store.currentIndex = index;
        showBrowserOutput();
        void fetchLyrics(currentTrack());
        if (mediaError) report(mediaError);
        if (media) {
          try {
            await playInBrowser(store.playlist, index, {
              media,
              position: latest.deviceStatus?.position ?? 0,
            });
          } catch (error) {
            report(error);
          }
        }
        return true;
      });
      if (!result) throw new Error($("#sp-lx-error-message").textContent);
    };
    store.connectCastDevice = async (device) => {
      const result = await perform(async () => {
        const active = audio && !audio.paused && !audio.ended;
        if (browserOutput && active && currentTrack()) {
          const element = audio;
          element.pause();
          try {
            await api("/api/lx/player/play", "POST", {
              deviceId: device.device_id,
              tracks: store.playlist,
              index: store.currentIndex,
            });
          } catch (error) {
            if (browserOutput && audio === element)
              void element.play().catch(() => {});
            throw error;
          }
        } else {
          await api("/api/miot/device", "PUT", { deviceId: device.device_id });
        }
        releaseAudio();
        browserOutput = false;
        return true;
      });
      return {
        ok: !!result,
        ...(result ? {} : { reason: $("#sp-lx-error-message").textContent }),
      };
    };
    return store;
  }
  function chooseCatalog(kind) {
    if (!app || !catalogConfig) return;
    const mode = catalogConfig.mode;
    kind =
      mode === "private" || (mode === "hybrid" && kind !== "online")
        ? "private"
        : "online";
    app.catalog = { kind, libraries: catalogConfig.libraries };
    $("#sp-lx-catalog").value = kind;
    $("#sp-lx-catalog").hidden = mode !== "hybrid";
    $("#sp-lx-sources").hidden = kind !== "online";
    if (kind === "private" && !["search", "library"].includes(app.currentView))
      app.setView("search");
  }
  function configureCatalog(config) {
    catalogConfig = config;
    chooseCatalog(app?.catalog.kind);
  }
  function attachApp(store) {
    if (apps.has(store)) return store;
    apps.add(store);
    app = store;
    store.catalog = { kind: "loading", libraries: [] };
    const original = store.setView.bind(store);
    if (
      !["search", "songlist", "leaderboard", "library"].includes(
        store.currentView,
      )
    )
      original("search");
    store.setView = (view) => {
      if (view === "settings") {
        if (store.catalog.kind === "online") openSources();
      } else if (view === "library" || view === "local") original("library");
      else if (view === "search" || store.catalog.kind === "online")
        original(view);
    };
    if (catalogConfig) chooseCatalog();
    else
      void api("/api/music/services")
        .then((config) => {
          if (!catalogConfig) configureCatalog(config);
        })
        .catch((error) => {
          if (!catalogConfig) report(error);
        });
    return store;
  }
  async function request(raw, options = {}) {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin)
      throw new Error("播放器只使用同源平台接口");
    const method = options.method ?? "GET";
    const data =
      typeof options.body === "string" ? JSON.parse(options.body) : {};
    const prefix = "/api/v1/jsplugin/lxmusic/api";
    const path = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : url.pathname;
    const envelope = (payload) => ({ code: 0, msg: "success", data: payload });
    const params = Object.fromEntries(url.searchParams);
    if (path === "/settings") {
      const value = await api("/api/lx/settings");
      return envelope({
        enablePlayQuality: true,
        playQuality: value.quality,
        playTimeout: 30,
        probeTimeout: 5,
      });
    }
    if (path === "/sources") return envelope(await api("/api/lx/sources"));
    if (
      path === "/search" ||
      path === "/hotsearch" ||
      path.startsWith("/songlist/") ||
      path.startsWith("/leaderboard/")
    ) {
      if (app?.catalog.kind !== "online")
        throw new Error("当前检索来源不是 LX 在线音乐");
      if (path === "/songlist/import_full")
        return envelope(await api("/api/lx/playlists/import", "POST", data));
      return envelope(
        await api(
          "/api/lx/catalog",
          "POST",
          {
            operation: path.slice(1),
            ...params,
            ...data,
            source_id:
              params.source_id ?? params.source ?? data.source_id ?? "wy",
          },
          options.signal,
        ),
      );
    }
    if (path === "/songs/import") {
      const existing = await api("/api/lx/playlists");
      const selected = existing.playlists.find(
        (list) => String(list.id) === String(data.playlist_id),
      );
      const saved = await api("/api/lx/playlists", "POST", {
        songs: data.songs ?? [],
        name: data.new_playlist_name || selected?.name || "导入歌单",
        ...(selected ? { id: selected.id } : {}),
      });
      return envelope({ success: saved.count, failed: 0 });
    }
    if (url.pathname === "/api/v1/playlists") {
      const result = await api("/api/lx/playlists");
      const limit = Math.max(1, Math.min(100, Number(params.limit) || 30)),
        offset = Math.max(0, Number(params.offset) || 0);
      return {
        ...result,
        playlists: result.playlists.slice(offset, offset + limit),
        limit,
        offset,
      };
    }
    const playlistMatch = url.pathname.match(
      /^\/api\/v1\/playlists\/([^/]+)(\/songs)?$/,
    );
    if (playlistMatch) {
      const result = await api(
        "/api/lx/playlist?id=" + encodeURIComponent(playlistMatch[1]),
      );
      if (!playlistMatch[2]) return result;
      const limit = Math.max(1, Math.min(100, Number(params.limit) || 30)),
        offset = Math.max(0, Number(params.offset) || 0);
      return {
        ...result,
        songs: result.songs.slice(offset, offset + limit),
        limit,
        offset,
      };
    }
    if (url.pathname === "/api/v1/jsplugin/miot/mina/devices") {
      const status = await api("/api/status");
      return {
        success: true,
        data: [
          {
            account_id: "platform",
            name: "平台账号",
            devices: status.devices.map((d) => ({
              ...d,
              deviceID: d.deviceId,
              device_id: d.deviceId,
              volume:
                state?.device?.deviceId === d.deviceId
                  ? state.deviceStatus?.volume
                  : undefined,
            })),
          },
        ],
      };
    }
    if (url.pathname === "/api/v1/jsplugin/miot/mina/volume")
      return {
        success: true,
        data: await api("/api/miot/control", "POST", {
          deviceId: data.device_id,
          command: "volume",
          volume: data.volume,
        }),
      };
    if (path.startsWith("/cast/"))
      throw new Error("请使用播放器控制，音箱投放由平台统一管理");
    throw new Error("此功能不适用于音箱平台：" + path);
  }
  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    const el = element("button", text);
    el.type = "button";
    el.onclick = async () => {
      el.disabled = true;
      try {
        await action();
      } catch (error) {
        $("#sp-lx-dialog-error").textContent = error.message;
      } finally {
        el.disabled = false;
      }
    };
    return el;
  }
  function dialog(title) {
    dialogGeneration++;
    $("#sp-lx-dialog-title").textContent = title;
    $("#sp-lx-dialog-error").textContent = "";
    $("#sp-lx-dialog-body").replaceChildren();
    if (!$("#sp-lx-dialog").open) $("#sp-lx-dialog").showModal();
    return { root: $("#sp-lx-dialog-body"), generation: dialogGeneration };
  }
  async function openSources() {
    const { root, generation } = dialog("LX 音乐源管理");
    root.append(
      element(
        "p",
        "导入你有权使用、兼容 LX 的 .js 音源。搜索目录与播放地址分开处理；未导入音源时可以搜索，但无法播放。脚本只获得受限网络、缓冲区和加密 API，不能读取平台配置。",
        "sp-help",
      ),
    );
    const form = element("div", undefined, "sp-form");
    const file = element("input");
    file.type = "file";
    file.accept = ".js,.txt";
    file.setAttribute("aria-label", "选择 LX 音源脚本");
    form.append(
      file,
      button("导入文件", async () => {
        if (!file.files?.length) throw new Error("请先选择音源文件");
        if (file.files[0].size > 512 * 1024)
          throw new Error("音源不能超过 512 KB");
        await api("/api/lx/sources/import", "POST", {
          script: await file.files[0].text(),
        });
        await openSources();
      }),
    );
    root.append(form);
    const urlForm = element("div", undefined, "sp-form");
    const input = element("input");
    input.type = "url";
    input.placeholder = "https://…/source.js";
    input.setAttribute("aria-label", "LX 音源脚本地址");
    urlForm.append(
      input,
      button("从地址导入", async () => {
        await api("/api/lx/sources/import-url", "POST", { url: input.value });
        await openSources();
      }),
    );
    root.append(urlForm);
    const qualityRow = element("label", "音箱优先音质：");
    const quality = element("select");
    quality.setAttribute("aria-label", "音箱优先音质");
    for (const q of ["128k", "320k", "flac", "flac24bit"]) {
      const option = element("option", q);
      option.value = q;
      quality.append(option);
    }
    qualityRow.append(quality);
    root.append(qualityRow);
    const fallbackLabel = element("label", undefined, "sp-fallback");
    const fallback = element("input");
    fallback.type = "checkbox";
    fallback.setAttribute("aria-label", "失败时允许降低音质");
    fallbackLabel.append(
      fallback,
      document.createTextNode("失败时允许降低音质"),
    );
    root.append(fallbackLabel);
    fallback.onchange = async () => {
      try {
        await api("/api/lx/settings", "PUT", {
          qualityFallback: fallback.checked,
        });
      } catch (error) {
        fallback.checked = !fallback.checked;
        $("#sp-lx-dialog-error").textContent = error.message;
      }
    };
    const tools = element("div", undefined, "sp-form");
    const progress = element("p", "正在读取检测状态…", "sp-help");
    progress.setAttribute("role", "status");
    const healthCells = new Map();
    let polling = false;
    const isCurrent = () =>
      generation === dialogGeneration && $("#sp-lx-dialog").open;
    const platformNames = {
      wy: "网易",
      tx: "腾讯",
      kg: "酷狗",
      kw: "酷我",
      mg: "咪咕",
    };
    const reasonNames = {
      resolve: "解析失败",
      audio: "无有效音频",
      timeout: "超时",
      ok: "可用",
    };
    async function pollChecks() {
      if (!isCurrent() || polling) return;
      polling = true;
      try {
        const [job, sources] = await Promise.all([
          api("/api/lx/sources/check-status"),
          api("/api/lx/sources"),
        ]);
        if (!isCurrent()) return;
        progress.textContent =
          ({
            idle: "尚未开始检测",
            running: "正在检测",
            completed: "检测完成",
            cancelled: "已停止检测",
            failed: "检测任务失败",
          }[job.state] ?? job.state) +
          (job.total ? " · " + job.completed + " / " + job.total : "");
        checkAll.disabled = job.state === "running";
        stop.disabled = job.state !== "running";
        for (const source of sources)
          for (const platform of Object.keys(source.sources)) {
            const target = healthCells.get(source.id + ":" + platform);
            if (!target) continue;
            const health = source.health?.[platform];
            const result = job.results?.find(
              (r) => r.sourceId === source.id && r.platform === platform,
            );
            const catalogError =
              result?.state === "catalog_error" &&
              (!health || result.checkedAt >= health.checkedAt);
            target.textContent = catalogError
              ? "目录暂不可用，未判定音源"
              : health
                ? (health.state === "ok"
                    ? "样本可用"
                    : reasonNames[health.reason]) +
                  " · " +
                  health.score +
                  " 分 · " +
                  (health.latencyMs / 1000).toFixed(1) +
                  "s · " +
                  health.quality +
                  " · " +
                  new Date(health.checkedAt).toLocaleTimeString()
                : "未检测";
            target.dataset.state = catalogError
              ? "unknown"
              : (health?.state ?? "unknown");
            target.title =
              (health
                ? "最近检测 " +
                  new Date(health.checkedAt).toLocaleString() +
                  (health.cooldownUntil > Date.now()
                    ? "；连续失败，暂时降低尝试顺序"
                    : "")
                : "尚无音频检测记录") +
              (result?.sample ? "；样本：" + result.sample : "");
          }
        if (job.state === "running") setTimeout(() => void pollChecks(), 1200);
      } catch (error) {
        if (isCurrent()) progress.textContent = error.message;
      } finally {
        polling = false;
      }
    }
    const start = async (id) => {
      await api("/api/lx/sources/check", "POST", id ? { id } : {});
      await pollChecks();
    };
    const checkAll = button("检测全部启用音源", () => start());
    const stop = button("停止检测", async () => {
      await api("/api/lx/sources/check-stop", "POST", {});
      await pollChecks();
    });
    tools.append(checkAll, stop);
    root.append(
      tools,
      progress,
      element(
        "p",
        "按平台设置启用和优先级（0—100，越大越优先），再按近期健康分选择音源。连续失败的源临时后移；只在投放前自动换源。检测只校验样本音频前 16 KB，不向音箱播放，不保证所有歌曲可用。",
        "sp-help",
      ),
    );
    quality.onchange = async () => {
      try {
        await api("/api/lx/settings", "PUT", { quality: quality.value });
      } catch (error) {
        $("#sp-lx-dialog-error").textContent = error.message;
      }
    };
    try {
      const [sources, settings] = await Promise.all([
        api("/api/lx/sources"),
        api("/api/lx/settings"),
      ]);
      if (generation !== dialogGeneration) return;
      quality.value = settings.quality;
      fallback.checked = settings.qualityFallback;
      if (!sources.length)
        root.append(element("p", "还没有导入 LX 音源", "sp-empty"));
      for (const source of sources) {
        const row = element("div", undefined, "sp-row");
        const info = element("div");
        info.append(
          element("strong", source.name),
          element(
            "small",
            [
              source.version,
              source.author,
              Object.keys(source.sources).join(" / "),
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
        const actions = element("div", undefined, "sp-source-actions");
        const enabled = element("input");
        enabled.type = "checkbox";
        enabled.checked = source.enabled;
        enabled.setAttribute("aria-label", "启用 " + source.name);
        enabled.onchange = async () => {
          try {
            await api("/api/lx/sources", "PUT", {
              id: source.id,
              enabled: enabled.checked,
            });
          } catch (error) {
            enabled.checked = !enabled.checked;
            $("#sp-lx-dialog-error").textContent = error.message;
          }
        };
        actions.append(
          enabled,
          button("检测可用性", () => start(source.id)),
          button("删除", async () => {
            await api(
              "/api/lx/sources?id=" + encodeURIComponent(source.id),
              "DELETE",
            );
            await openSources();
          }),
        );
        row.append(info, actions);
        const card = element("section", undefined, "sp-source-card");
        card.append(row);
        for (const platform of Object.keys(source.sources).filter((p) =>
          source.sources[p].actions.includes("musicUrl"),
        )) {
          const rule = source.routing?.[platform] ?? {
            enabled: true,
            priority: 50,
          };
          const line = element("div", undefined, "sp-route");
          const label = element("label");
          const enabled = element("input");
          enabled.type = "checkbox";
          enabled.checked = rule.enabled;
          enabled.setAttribute(
            "aria-label",
            source.name + " " + platform + " 启用",
          );
          label.append(
            enabled,
            document.createTextNode(platformNames[platform] ?? platform),
          );
          const priority = element("input");
          priority.type = "number";
          priority.min = "0";
          priority.max = "100";
          priority.step = "1";
          priority.value = rule.priority;
          priority.setAttribute(
            "aria-label",
            source.name + " " + platform + " 优先级",
          );
          const save = button("保存规则", async () => {
            await api("/api/lx/sources/routing", "PUT", {
              id: source.id,
              platform,
              enabled: enabled.checked,
              priority: Number(priority.value),
            });
            save.textContent = "已保存";
          });
          const changed = () => (save.textContent = "保存规则");
          enabled.onchange = changed;
          priority.oninput = changed;
          const health = element("small", "未检测", "sp-health");
          healthCells.set(source.id + ":" + platform, health);
          line.append(label, priority, save, health);
          card.append(line);
        }
        root.append(card);
      }
      await pollChecks();
    } catch (error) {
      if (generation === dialogGeneration)
        $("#sp-lx-dialog-error").textContent = error.message;
    }
  }
  function openLibrary() {
    app?.setView("library");
  }
  globalThis.SpeakerLX = Object.freeze({
    request,
    configureCatalog,
    browsePrivate: (body, signal) =>
      api("/api/music/services/browse", "POST", body, signal),
    privateTracks: async (query, signal, matches) => {
      const context = await catalogTracks(
        "/api/music/services/browse",
        query,
        signal,
        matches,
      );
      return { ...context, tracks: context.tracks.map(song) };
    },
    onlineTrackLoader: (query) => (signal, matches) =>
      catalogTracks("/api/lx/catalog", query, signal, matches),
    libraryRequest: api,
    song,
    sourceName: (sourceId) =>
      catalogConfig?.libraries.find((l) => "library:" + l.id === sourceId)
        ?.name,
    songKey: (track) =>
      track?.library ? JSON.stringify([track.sourceId, track.id]) : undefined,
    player: attachPlayer,
    app: attachApp,
  });
  document.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || image.dataset.lxFallback)
        return;
      image.dataset.lxFallback = "true";
      image.removeAttribute("srcset");
      image.src = "/superai-icon.png";
      image.alt = "暂无封面";
    },
    true,
  );
  $("#sp-lx-catalog").onchange = (event) => chooseCatalog(event.target.value);
  $("#sp-lx-sources").onclick = openSources;
  $("#sp-lx-library").onclick = () => openLibrary();
  $("#sp-lx-error-close").onclick = dismissError;
  $("#sp-lx-close").onclick = () => {
    dialogGeneration++;
    $("#sp-lx-dialog").close();
  };
  $("#sp-lx-dialog").addEventListener("close", () => dialogGeneration++);
  $("#sp-lx-favorite").onclick = () =>
    perform(async () => {
      const track = currentTrack();
      if (!track) throw new Error("还没有正在播放的歌曲");
      const result = await api(
        "/api/music/favorites",
        "POST",
        browserOutput && (track.lx || track.library)
          ? { track }
          : { id: track.id, sourceId: track.sourceId },
      );
      $("#sp-lx-favorite").textContent = result.favorited
        ? "已收藏"
        : "收藏当前";
    });
  const interval = setInterval(() => {
    if (
      (browserOutput && audio && !audio.paused) ||
      (document.visibilityState === "visible" &&
        (!window.frameElement || window.frameElement.getClientRects().length))
    )
      if (!pending && !refreshing) void refresh();
  }, 4000);
  const lyricInterval = setInterval(() => {
    const panel = document.querySelector(
      ".detail-overlay .lyric-scroll-container",
    );
    if (!panel) centeredLyricPanel = null;
    else if (panel !== centeredLyricPanel && panel.clientHeight > 0) {
      const active = panel.querySelector?.(".lyric-line.is-active");
      if (active) {
        panel.scrollTo({
          top: Math.max(
            0,
            active.offsetTop - panel.clientHeight / 2 + active.clientHeight / 2,
          ),
          behavior: "instant",
        });
        centeredLyricPanel = panel;
      }
    }
    if (!player || !deviceClock || document.visibilityState !== "visible")
      return;
    const elapsed = (performance.now() - deviceClock.receivedAt) / 1000;
    const age = Date.now() - deviceClock.sampledAt;
    // Brief interpolation between device samples; stale status freezes progress.
    if (deviceClock.playing && age >= 0 && age < 10000) {
      player.currentTime = Math.min(
        player.duration || Infinity,
        deviceClock.position + Math.min(elapsed, 8),
      );
      player.syncLyric();
    }
  }, 250);
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(interval);
      clearInterval(lyricInterval);
      dismissError();
      lyricController?.abort();
      releaseAudio();
      dialogGeneration++;
    },
    {
      once: true,
    },
  );
})();
