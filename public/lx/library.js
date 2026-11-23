// Platform-owned library view; the pinned LX table keeps selection, import and
// playback interactions consistent with search and charts.
globalThis.SpeakerLibrary = ({
  h,
  reactive,
  computed,
  watch,
  onUnmounted,
  getApp,
  getPlayer,
  table,
  importModal,
}) => ({
  name: "SpeakerLibrary",
  setup() {
    const bridge = globalThis.SpeakerLX,
      app = getApp(),
      player = getPlayer();
    const state = reactive({
      kind: "favorites",
      favorites: [],
      history: [],
      playlists: [],
      collection: null,
      tracks: [],
      query: "",
      page: 1,
      loading: false,
      error: "",
      selected: [],
      revision: 0,
      importing: false,
      importSongs: [],
      deleting: false,
    });
    let generation = 0,
      controller;
    const key = (track) => JSON.stringify([track.sourceId, track.id]);
    function cancel() {
      generation++;
      controller?.abort();
    }
    async function load() {
      cancel();
      const current = generation;
      controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      state.loading = true;
      state.error = "";
      state.selected = [];
      state.deleting = false;
      try {
        const [favorites, history, playlists] = await Promise.all([
          bridge.libraryRequest(
            "/api/music/favorites",
            "GET",
            undefined,
            signal,
          ),
          bridge.libraryRequest("/api/music/history", "GET", undefined, signal),
          bridge.libraryRequest("/api/lx/playlists", "GET", undefined, signal),
        ]);
        if (current !== generation) return;
        state.favorites = favorites.tracks;
        state.history = history.entries.map((e) => ({
          ...e.track,
          playedAt: e.playedAt,
        }));
        state.playlists = playlists.playlists.filter(
          (p) => p.id !== "favorites",
        );
        if (state.collection) {
          const detail = await bridge.libraryRequest(
            "/api/lx/playlist?id=" + encodeURIComponent(state.collection.id),
            "GET",
            undefined,
            signal,
          );
          if (current !== generation) return;
          state.tracks = detail.tracks;
        }
        state.revision++;
      } catch (error) {
        if (current === generation) state.error = error.message;
      } finally {
        if (current === generation) state.loading = false;
      }
    }
    function choose(kind, collection = null) {
      state.kind = kind;
      state.collection = collection;
      state.query = "";
      state.page = 1;
      state.tracks = [];
      state.selected = [];
      void load();
    }
    watch(
      () => app.currentView,
      (view) => {
        if (view === "library") void load();
      },
      { immediate: true },
    );
    onUnmounted(cancel);
    const button = (
      label,
      action,
      disabled = false,
      className = "sp-library-button",
    ) =>
      h(
        "button",
        { type: "button", class: className, disabled, onClick: action },
        label,
      );
    const startImport = (songs) => {
      state.importSongs = songs;
      state.importing = true;
    };
    async function removeFavorites() {
      state.loading = true;
      state.error = "";
      try {
        // Identity-based removal: a stale row must never target its replacement.
        for (const track of state.selected)
          await bridge.libraryRequest("/api/music/favorites", "POST", {
            id: track.id,
            sourceId: track.sourceId,
          });
        await load();
      } catch (error) {
        state.error = error.message;
        state.loading = false;
      }
    }
    async function deletePlaylist() {
      state.loading = true;
      try {
        await bridge.libraryRequest(
          "/api/lx/playlists?id=" + encodeURIComponent(state.collection.id),
          "DELETE",
        );
        choose("playlists");
      } catch (error) {
        state.error = error.message;
        state.loading = false;
      }
    }
    // Selection notifications must not replace the table's songs prop.
    const visible = computed(() => {
      const needle = state.query.trim().toLocaleLowerCase();
      const raw = state.collection
        ? state.tracks
        : state.kind === "history"
          ? state.history
          : state.favorites;
      const filtered = raw.filter(
        (t) =>
          !needle ||
          [t.title, t.artist, t.album]
            .join(" ")
            .toLocaleLowerCase()
            .includes(needle),
      );
      const contextSongs = filtered.map(bridge.song);
      const songs = contextSongs.slice((state.page - 1) * 50, state.page * 50);
      return { needle, raw, filtered, songs, contextSongs };
    });
    return () => {
      const { needle, raw, filtered, songs, contextSongs } = visible.value;
      const title =
        state.collection?.name ??
        {
          favorites: "我喜欢的音乐",
          history: "最近播放",
          playlists: "我的歌单",
        }[state.kind];
      const cards = state.playlists.filter(
        (p) => !needle || p.name.toLocaleLowerCase().includes(needle),
      );
      return h("section", { class: "sp-library", "aria-label": "我的音乐" }, [
        h("div", { class: "sp-library-intro" }, [
          h("div", {}, [
            h("p", { class: "sp-library-eyebrow" }, "你的音乐空间"),
            h("h2", {}, "每次喜欢，都留在这里"),
            h("p", {}, "收藏、最近播放和保存的歌单，在同一个播放器继续聆听。"),
          ]),
        ]),
        h(
          "div",
          {
            class: "sp-library-tabs",
            role: "tablist",
            "aria-label": "音乐分类",
          },
          [
            ["favorites", "我喜欢", state.favorites.length],
            ["history", "最近播放", state.history.length],
            ["playlists", "我的歌单", state.playlists.length],
          ].map(([kind, label, count]) =>
            h(
              "button",
              {
                type: "button",
                role: "tab",
                "aria-selected": state.kind === kind,
                class: { "is-active": state.kind === kind },
                onClick: () => choose(kind),
                disabled: state.loading,
              },
              [
                h("span", {}, label),
                h("span", { class: "sp-library-count" }, String(count)),
              ],
            ),
          ),
        ),
        h("div", { class: "sp-library-toolbar" }, [
          h("div", { class: "sp-library-heading" }, [
            state.collection
              ? button("返回歌单", () => choose("playlists"))
              : null,
            h("h3", {}, title),
            h(
              "small",
              {},
              state.kind === "playlists" && !state.collection
                ? cards.length + " 个歌单"
                : filtered.length + " 首歌曲",
            ),
          ]),
          h("div", { class: "sp-library-tools" }, [
            h("input", {
              type: "search",
              "aria-label": "搜索我的音乐",
              placeholder:
                state.kind === "playlists" && !state.collection
                  ? "搜索歌单"
                  : "搜索歌名、歌手、专辑",
              value: state.query,
              onInput: (e) => {
                state.query = e.target.value;
                state.page = 1;
                state.selected = [];
              },
            }),
            button("刷新", () => void load(), state.loading),
          ]),
        ]),
        state.error
          ? h("div", { role: "alert", class: "sp-catalog-error" }, [
              state.error,
              button("重试", () => void load(), state.loading),
            ])
          : null,
        state.loading
          ? h(
              "p",
              { role: "status", class: "sp-library-status" },
              "正在读取你的音乐…",
            )
          : null,
        state.kind === "playlists" && !state.collection
          ? h("div", { class: "sp-library-grid" }, [
              ...cards.map((list, index) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: "sp-playlist-card",
                    key: list.id,
                    onClick: () => choose("playlists", list),
                  },
                  [
                    h(
                      "span",
                      {
                        class: "sp-playlist-art",
                        "data-tone": index % 3,
                        "aria-hidden": "true",
                      },
                      "♫",
                    ),
                    h("span", { class: "sp-playlist-copy" }, [
                      h("strong", {}, list.name),
                      h("small", {}, list.song_count + " 首歌曲"),
                    ]),
                    h("span", { "aria-hidden": "true" }, "↗"),
                  ],
                ),
              ),
              !cards.length && !state.loading && !state.error
                ? h("div", { class: "sp-library-empty" }, [
                    h("h3", {}, needle ? "没有匹配的歌单" : "从一张歌单开始"),
                    h(
                      "p",
                      {},
                      "在搜索或排行榜选择歌曲，点「导入」即可保存为歌单。",
                    ),
                  ])
                : null,
            ])
          : h("div", { class: "sp-library-tracks" }, [
              h("div", { class: "sp-library-actions" }, [
                button(
                  "播放本页",
                  () => player.playAll(songs),
                  !songs.length || state.loading,
                  "sp-library-button primary",
                ),
                state.kind === "favorites" && state.selected.length
                  ? button(
                      "取消收藏（" + state.selected.length + "）",
                      removeFavorites,
                      state.loading,
                    )
                  : null,
                state.collection
                  ? button(
                      state.deleting ? "确认删除此歌单" : "删除歌单",
                      () => {
                        if (state.deleting) void deletePlaylist();
                        else state.deleting = true;
                      },
                      state.loading,
                    )
                  : null,
                state.deleting
                  ? button("取消", () => {
                      state.deleting = false;
                    })
                  : null,
              ]),
              !filtered.length && !state.loading && !state.error
                ? h("div", { class: "sp-library-empty" }, [
                    h(
                      "h3",
                      {},
                      needle
                        ? "没有匹配的歌曲"
                        : state.kind === "favorites"
                          ? "把喜欢的歌留下"
                          : "下一次聆听，从这里继续",
                    ),
                    h(
                      "p",
                      {},
                      state.kind === "favorites"
                        ? "点播放器里的「收藏当前」，喜欢的音乐就会出现在这里。"
                        : "播放过的歌曲会自动出现在最近播放中。",
                    ),
                  ])
                : null,
              h(table, {
                key: [
                  state.kind,
                  state.collection?.id,
                  state.query,
                  state.page,
                  state.revision,
                ].join(":"),
                songs,
                playContextSongs: contextSongs,
                total: filtered.length,
                currentPage: state.page,
                pageSize: 50,
                loading: state.loading,
                isFlat: true,
                selectable: true,
                showDownloadBtn: false,
                activeSongId: player.activeSongKey,
                onPageChange: (page) => {
                  state.page = page;
                  state.selected = [];
                },
                onSelectionChange: (selected) => {
                  const keys = new Set(selected.map(key));
                  const next = raw.filter((track) => keys.has(key(track)));
                  if (
                    next.length !== state.selected.length ||
                    next.some((track, index) => track !== state.selected[index])
                  )
                    state.selected = next;
                },
                onAction: (action, track) => {
                  if (action === "add") startImport([track]);
                },
                onBatchImport: startImport,
              }),
            ]),
        h(importModal, {
          show: state.importing,
          songs: state.importSongs,
          "onUpdate:show": (value) => {
            state.importing = value;
            if (!value) void load();
          },
        }),
      ]);
    };
  },
});
