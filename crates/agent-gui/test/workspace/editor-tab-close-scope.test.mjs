import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const closeScope = loader.loadModule(
  "@liveagent/ui/components/workspace-editor/editorTabCloseScope.ts",
);
const { pickEditorTabActiveKeyAfterClose, resolveEditorTabCloseKeys } = closeScope;

function keysAfterClose(keys, closing, activeKey) {
  return pickEditorTabActiveKeyAfterClose(keys, new Set(closing), activeKey);
}

describe("resolveEditorTabCloseKeys", () => {
  test("left closes only the tabs before the anchor, and the anchor itself stays", () => {
    assert.deepEqual(resolveEditorTabCloseKeys(["a", "b", "c", "d"], "c", "left"), ["a", "b"]);
    assert.deepEqual(resolveEditorTabCloseKeys(["a", "b", "c"], "b", "left"), ["a"]);
  });

  test("left on the first tab closes nothing (菜单会据此置灰)", () => {
    assert.deepEqual(resolveEditorTabCloseKeys(["a", "b", "c"], "a", "left"), []);
  });

  test("others keeps exactly the tab that was right-clicked", () => {
    assert.deepEqual(resolveEditorTabCloseKeys(["a", "b", "c", "d"], "b", "others"), [
      "a",
      "c",
      "d",
    ]);
  });

  test("others on a lone tab closes nothing", () => {
    assert.deepEqual(resolveEditorTabCloseKeys(["a"], "a", "others"), []);
  });

  test("all closes every tab including the anchor", () => {
    assert.deepEqual(resolveEditorTabCloseKeys(["a", "b", "c"], "b", "all"), ["a", "b", "c"]);
  });

  test("all on a lone tab still closes it (单项可点，不算无意义)", () => {
    assert.deepEqual(resolveEditorTabCloseKeys(["a"], "a", "all"), ["a"]);
  });

  test("an anchor that is already gone selects nothing instead of wiping the strip", () => {
    // 菜单打开后另一个来源可能把该 tab 关掉了；此时任何一项都不该动手。
    for (const mode of ["left", "others", "all"]) {
      assert.deepEqual(resolveEditorTabCloseKeys(["a", "b"], "gone", mode), [], mode);
    }
  });

  test("does not mutate the incoming key list", () => {
    const keys = ["a", "b", "c"];
    resolveEditorTabCloseKeys(keys, "b", "all");
    resolveEditorTabCloseKeys(keys, "c", "left");
    assert.deepEqual(keys, ["a", "b", "c"]);
  });
});

describe("pickEditorTabActiveKeyAfterClose", () => {
  test("keeps the current tab when it survives the batch", () => {
    assert.equal(keysAfterClose(["a", "b", "c"], ["a"], "b"), "b");
    assert.equal(keysAfterClose(["a", "b", "c"], ["a", "b"], "c"), "c");
  });

  test("closing left hands over to the right-clicked tab", () => {
    assert.equal(keysAfterClose(["a", "b", "c", "d"], ["a", "b"], "b"), "c");
  });

  test("closing others hands over to the tab that was kept", () => {
    assert.equal(keysAfterClose(["a", "b", "c"], ["a", "c"], "a"), "b");
  });

  test("closing everything leaves the editor empty", () => {
    assert.equal(keysAfterClose(["a", "b"], ["a", "b"], "a"), "");
    assert.equal(keysAfterClose(["a"], ["a"], "a"), "");
  });

  test("single-tab close keeps the same successor rule as before", () => {
    // 回归护栏：批量实现接管了原来的单个关闭，中间/末尾/唯一三种落位都要一致。
    assert.equal(keysAfterClose(["a", "b", "c"], ["b"], "b"), "c");
    assert.equal(keysAfterClose(["a", "b"], ["b"], "b"), "a");
    assert.equal(keysAfterClose(["a"], ["a"], "a"), "");
  });
});
