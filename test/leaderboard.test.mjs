import test from "node:test";
import assert from "node:assert/strict";
import { LxCatalog } from "../src/music/lx/catalog.ts";
import { handleLxApi } from "../src/music/lx/api.ts";
import wy from "../vendor/lx-music/musicSdk/wy/leaderboard.js";
import tx from "../vendor/lx-music/musicSdk/tx/leaderboard.js";
import kg from "../vendor/lx-music/musicSdk/kg/leaderboard.js";
import kw from "../vendor/lx-music/musicSdk/kw/leaderboard.js";
import mg from "../vendor/lx-music/musicSdk/mg/leaderboard.js";
import { catalogFixture, json } from "./helpers/lx-fixture.mjs";

test("the player chart id resolves to each platform's native board id through the catalog API", async () => {
  for (const [platform, module] of Object.entries({ wy, tx, kg, kw, mg })) {
    const original = module.getList;
    const catalog = new LxCatalog();
    const boards = await catalog.call(platform, "board", "getBoards");
    const board = boards.list[0];
    let calls = 0;
    module.getList = async (nativeId, page) => {
      calls++;
      assert.equal(nativeId, String(board.bangid));
      assert.equal(page, 2);
      return {
        list: [{ songmid: "one", source: platform }],
        total: 60,
        limit: 30,
        page,
      };
    };
    try {
      const result = await handleLxApi(
        "POST",
        "/catalog",
        new URL("http://test/catalog"),
        {
          operation: "leaderboard/list",
          source_id: platform,
          board_id: board.id,
          page: 2,
        },
        { catalog },
        {},
        {},
        { assertOnline() {} },
      );
      assert.equal(result.list.length, 1);
      assert.equal(result.page, 2);
      assert.equal(result.has_more, false);
      await catalog.call(platform, "board", "getList", String(board.bangid), 2);
      await assert.rejects(
        catalog.call(platform, "board", "getList", "other__" + board.bangid, 2),
        /找不到/,
      );
      assert.equal(calls, 2, "invalid boards must not reach upstream");
    } finally {
      module.getList = original;
    }
  }
});

test("a prefixed WY board loads actual adapter song metadata without a playback request", async () => {
  const original = wy.getData;
  let nativeId;
  const calls = [];
  wy.getData = async (id) => {
    nativeId = id;
    return {
      statusCode: 200,
      body: catalogFixture("https://music.163.com/weapi/v3/playlist/detail"),
    };
  };
  try {
    const catalog = new LxCatalog(async (input) => {
      calls.push(String(input));
      return json(catalogFixture(input));
    });
    const result = await catalog.call(
      "wy",
      "board",
      "getList",
      "wy__19723756",
      1,
    );
    assert.equal(nativeId, "19723756");
    assert.equal(result.list[0].name, "晴天");
    assert.equal(result.list[0].source, "wy");
    assert.equal(result.returned_count, 2);
    assert.ok(calls.every((url) => !url.includes("mina.mi.com")));
  } finally {
    wy.getData = original;
  }
});
