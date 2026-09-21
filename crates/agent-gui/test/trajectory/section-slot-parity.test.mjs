import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 轨迹分段的槽位表横跨两种语言：前端 `TRAJECTORY_SECTION_SLOTS` 决定 `section.slot`，
// Rust 的 `TRAJECTORY_SECTION_SLOT_NAMES` 是入库白名单。两边不同步的后果不是一句报错提示，
// 而是**整批分段被拒**（校验在事务里用 `?`），持久化队列随后无限重试同一批 —— 那条会话的
// 轨迹永远写不进来。顺序也必须一致：事件里的 refs 是按位置存的。

const loader = createTsModuleLoader();
const types = loader.loadModule("@liveagent/ui/lib/trajectory/types.ts");

const rustSource = readFileSync(
  new URL(
    "../../../agent-gui/src-tauri/src/commands/history/chat_history/trajectory.rs",
    import.meta.url,
  ),
  "utf8",
);

function rustSlotNames() {
  const match = /TRAJECTORY_SECTION_SLOT_NAMES: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(rustSource);
  assert.ok(match, "Rust slot whitelist not found");
  const names = [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.equal(Number(match[1]), names.length, "declared array length must match the entries");
  return names;
}

describe("轨迹分段槽位表的前后端一致性", () => {
  test("the Rust whitelist lists exactly the frontend slots, in order", () => {
    assert.deepEqual(rustSlotNames(), [...types.TRAJECTORY_SECTION_SLOTS]);
  });

  test("prompt-visible slots are a subset of the storage slots", () => {
    for (const slot of types.TRAJECTORY_PROMPT_SECTION_SLOTS) {
      assert.ok(
        types.TRAJECTORY_SECTION_SLOTS.includes(slot),
        `${slot} is not a known section slot`,
      );
    }
  });
});
