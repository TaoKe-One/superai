// Catalog-only view built with the pinned LX runtime and its original song table.
// Playback, queue, lyrics and imports stay in the existing LX components/stores.
globalThis.SpeakerPrivateCatalog = ({
  h,
  reactive,
  watch,
  onUnmounted,
  getApp,
  getPlayer,
  table,
  importModal,
  searchInput,
}) => ({
  name: "PrivateCatalog",
  setup() {
    const app = getApp(),
      player = getPlayer(),
      bridge = globalThis.SpeakerLX;
    const state = reactive({
      providerId: "",
      kind: "songs",
      query: "",
      page: 1,
      collection: null,
      directoryPage: 1,
      items: [],
      hasMore: false,
      loading: false,
      error: "",
      importing: false,
      importSongs: [],
    });
    let generation = 0,
      submittedQuery = "",
      controller;
    const libraries = () =>
      app.catalog.libraries.filter((item) => item.enabled);
    const searchesArtists = () =>
      state.kind === "artists" &&
      libraries().find((item) => item.id === state.providerId)?.type !==
        "feiniu";
    const isSongs = () => state.kind === "songs" || !!state.collection;
    function cancel() {
      generation++;
      controller?.abort();
      state.loading = false;
    }
    async function load(page = 1) {
      cancel();
      state.page = page;
      state.items = [];
      state.hasMore = false;
      state.error = "";
      if (app.catalog.kind !== "private" || !state.providerId) return;
      const current = generation;
      controller = new AbortController();
      state.loading = true;
      try {
        const result = await bridge.browsePrivate(
          {
            providerId: state.providerId,
            kind: state.kind,
            query: submittedQuery,
            page,
            ...(state.collection ? { collectionId: state.collection.id } : {}),
          },
          AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
        );
        if (current !== generation) return;
        state.items = isSongs() ? result.items.map(bridge.song) : result.items;
        state.hasMore = result.hasMore;
      } catch (error) {
        if (current === generation) state.error = error.message;
      } finally {
        if (current === generation) state.loading = false;
      }
    }
    function reset(page = 1) {
      state.collection = null;
      void load(page);
    }
    watch(
      () => JSON.stringify(app.catalog),
      () => {
        cancel();
        if (app.catalog.kind !== "private") return;
        if (!libraries().some((item) => item.id === state.providerId))
          state.providerId = libraries()[0]?.id ?? "";
        state.collection = null;
        void load();
      },
      { immediate: true },
    );
    onUnmounted(cancel);
    const button = (text, action, disabled = false) =>
      h(
        "button",
        {
          type: "button",
          class: "lxm-btn-cancel",
          onClick: action,
          disabled,
        },
        text,
      );
    const select = (label, value, choices, change) =>
      h(
        "select",
        {
          "aria-label": label,
          value,
          onChange: (event) => change(event.target.value),
        },
        choices.map(([id, name]) => h("option", { value: id, key: id }, name)),
      );
    const startImport = (songs) => {
      state.importSongs = songs;
      state.importing = true;
    };
    return () => {
      if (app.catalog.kind === "loading")
        return h("p", { class: "sp-help" }, "正在读取检索来源…");
      const playRequest = {
        providerId: state.providerId,
        kind: state.kind,
        query: submittedQuery,
        page: state.page,
        ...(state.collection ? { collectionId: state.collection.id } : {}),
      };
      const loadPlayContext =
        state.page > 1 || state.hasMore
          ? (signal, matches) =>
              bridge.privateTracks(playRequest, signal, matches)
          : null;
      return h(
        "section",
        {
          class: "lxm-search-view sp-private-catalog",
          "aria-label": "私人音乐库检索",
        },
        [
          h("div", { class: "sp-catalog-search" }, [
            select(
              "选择私人音乐库",
              state.providerId,
              libraries().map((l) => [l.id, l.name]),
              (id) => {
                state.providerId = id;
                state.query = submittedQuery = "";
                reset();
              },
            ),
            select(
              "目录类型",
              state.kind,
              [
                ["songs", "歌曲"],
                ["albums", "专辑"],
                ["artists", "歌手"],
                ["playlists", "歌单 / WebDAV 文件夹"],
              ],
              (kind) => {
                state.kind = kind;
                reset();
              },
            ),
            h(searchInput, {
              modelValue: state.query,
              "onUpdate:modelValue": (query) => {
                state.query = query.slice(0, 500);
              },
              placeholder: searchesArtists()
                ? "搜索歌手姓名…"
                : "按歌名或歌手找歌曲…",
              height: "40px",
              onSearch: () => {
                submittedQuery = state.query;
                if (!searchesArtists()) state.kind = "songs";
                reset();
              },
              onClear: () => {
                state.query = submittedQuery = "";
                if (!searchesArtists()) state.kind = "songs";
                reset();
              },
            }),
          ]),
          h("div", { class: "sp-catalog-actions" }, [
            ...(state.collection
              ? [
                  button("返回目录", () => reset(state.directoryPage)),
                  h("strong", {}, state.collection.name),
                ]
              : []),
            button("刷新目录", () => void load(state.page), state.loading),
            ...(isSongs()
              ? [
                  button(
                    "播放本页",
                    () => player.playAll(state.items),
                    state.loading || !state.items.length,
                  ),
                ]
              : []),
          ]),
          !state.providerId
            ? h(
                "p",
                { class: "sp-empty" },
                "请在平台设置中添加并启用私人音乐库。",
              )
            : null,
          state.error
            ? h("p", { class: "sp-catalog-error", role: "alert" }, state.error)
            : null,
          isSongs()
            ? h(table, {
                songs: state.items,
                loadPlayContext,
                pageSize: 50,
                currentPage: state.page,
                activeSongId: player.activeSongKey,
                loading: state.loading,
                isFlat: true,
                showPagination: true,
                paginationMode: "simple",
                hasMore: state.hasMore,
                returnedCount: state.items.length,
                onPageChange: (page) => void load(page),
                selectable: true,
                showDownloadBtn: false,
                filterableColumns: ["singer", "album"],
                onAction: (action, track) => {
                  if (action === "add") startImport([track]);
                },
                onBatchImport: startImport,
              })
            : h("div", { class: "sp-collections" }, [
                state.loading
                  ? h("p", { role: "status" }, "正在读取音乐库…")
                  : null,
                ...state.items.map((item) =>
                  h("div", { class: "sp-row", key: item.id }, [
                    h("div", {}, [
                      h("strong", {}, item.name),
                      Number.isFinite(item.count)
                        ? h("small", {}, item.count + " 首")
                        : null,
                    ]),
                    button("查看", () => {
                      state.directoryPage = state.page;
                      state.collection = item;
                      void load();
                    }),
                  ]),
                ),
                !state.loading && !state.error && !state.items.length
                  ? h("p", { class: "sp-empty" }, "没有找到目录。")
                  : null,
              ]),
          !isSongs() && state.providerId && (state.page > 1 || state.hasMore)
            ? h(
                "nav",
                {
                  class: "sp-catalog-pagination",
                  "aria-label": "私有库分页",
                },
                [
                  button(
                    "上一页",
                    () => void load(state.page - 1),
                    state.loading || state.page <= 1,
                  ),
                  h(
                    "span",
                    { "aria-live": "polite" },
                    "第 " + state.page + " 页",
                  ),
                  button(
                    "下一页",
                    () => void load(state.page + 1),
                    state.loading || !state.hasMore,
                  ),
                ],
              )
            : null,
          h(importModal, {
            show: state.importing,
            songs: state.importSongs,
            "onUpdate:show": (show) => {
              state.importing = show;
            },
          }),
        ],
      );
    };
  },
});
