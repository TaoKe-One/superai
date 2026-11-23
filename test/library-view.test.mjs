import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../public/lx/library.js", import.meta.url),
  "utf8",
);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const track = (id, title = id) => ({
  id,
  sourceId: "lx-wy",
  title,
  artist: "Artist",
});
function fixture(request) {
  const calls = [],
    events = [];
  let dispose;
  const context = { AbortController, AbortSignal, Set, globalThis: {} };
  const song = (value) => ({ ...value, name: value.title });
  context.globalThis.SpeakerLX = {
    song,
    libraryRequest: async (...args) => {
      calls.push(args);
      return request(...args);
    },
  };
  vm.runInNewContext(source, context);
  const render = context.globalThis
    .SpeakerLibrary({
      h: (type, props, children) => ({ type, props: props ?? {}, children }),
      reactive: (value) =>
        new Proxy(value, {
          set(target, key, next) {
            if (key === "selected") events.push(next);
            return Reflect.set(target, key, next);
          },
        }),
      computed: (read) => ({
        get value() {
          return read();
        },
      }),
      watch: (read, fn) => fn(read()),
      onUnmounted: (fn) => {
        dispose = fn;
      },
      getApp: () => ({ currentView: "library" }),
      getPlayer: () => ({ playAll: (songs) => events.push(songs) }),
      table: "table",
      importModal: "modal",
    })
    .setup();
  function nodes(node) {
    if (!node || typeof node !== "object") return [];
    return [
      node,
      ...[node.children].flat(Infinity).flatMap((child) => nodes(child)),
    ];
  }
  return {
    render,
    nodes: () => nodes(render()),
    calls,
    events,
    dispose: () => dispose(),
    table: () => nodes(render()).find((n) => n.type === "table"),
    button: (text) =>
      nodes(render()).find((n) => n.type === "button" && n.children === text),
  };
}
test("library replay uses saved identities and filtering clears selection instead of removing another row", async () => {
  const songs = [track("one", "First"), track("two", "Second")];
  const removed = [];
  const ui = fixture(async (path, method, body) => {
    if (method === "POST") {
      removed.push(body);
      return { favorited: false };
    }
    if (path.endsWith("favorites")) return { tracks: songs };
    if (path.endsWith("history")) return { entries: [] };
    return { playlists: [] };
  });
  await flush();
  const table = ui.table();
  assert.equal(table.props.playContextSongs.indexOf(table.props.songs[1]), 1);
  assert.deepEqual(
    Array.from(table.props.playContextSongs, (song) => song.id),
    ["one", "two"],
  );
  table.props.onSelectionChange([table.props.songs[0]]);
  assert.ok(ui.button("取消收藏（1）"));
  const selections = ui.events.length;
  ui.table().props.onSelectionChange([table.props.songs[0]]);
  assert.equal(
    ui.events.length,
    selections,
    "a duplicate selection must not schedule another render",
  );
  ui.table().props.onSelectionChange([]);
  const cleared = ui.events.length;
  ui.table().props.onSelectionChange([]);
  assert.equal(
    ui.events.length,
    cleared,
    "a repeated empty selection must not schedule another render",
  );
  ui.table().props.onSelectionChange([table.props.songs[0]]);
  assert.ok(ui.button("取消收藏（1）"));
  const input = ui.nodes().find((n) => n.type === "input");
  input.props.onInput({ target: { value: "Second" } });
  assert.equal(ui.button("取消收藏（1）"), undefined);
  assert.equal(ui.table().props.songs.length, 1);
  ui.table().props.onSelectionChange(ui.table().props.songs);
  await ui.button("取消收藏（1）").props.onClick();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, "two");
  assert.equal(removed[0].sourceId, "lx-wy");
  ui.dispose();
});
test("a late library response cannot overwrite a newer refresh or update an unmounted view", async () => {
  const pending = [];
  const ui = fixture((path) =>
    path.endsWith("favorites")
      ? new Promise((resolve) => pending.push(resolve))
      : Promise.resolve(
          path.endsWith("history") ? { entries: [] } : { playlists: [] },
        ),
  );
  ui.button("刷新").props.onClick();
  pending[1]({ tracks: [track("new")] });
  await flush();
  pending[0]({ tracks: [track("old")] });
  await flush();
  assert.equal(ui.table().props.songs[0].id, "new");
  ui.button("刷新").props.onClick();
  ui.dispose();
  pending[2]({ tracks: [track("unmounted")] });
  await flush();
  assert.equal(ui.table().props.songs[0].id, "new");
});
