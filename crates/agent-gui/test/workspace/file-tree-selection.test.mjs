import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const selection = loader.loadModule(
  "@liveagent/ui/components/project-tools/file-tree/selection.ts",
);
const {
  applyFileTreeRowClick,
  EMPTY_FILE_TREE_SELECTION,
  resolveFileTreeContextSelection,
  sameFileTreeSelection,
  singleFileTreeSelection,
  topLevelFileTreePaths,
} = selection;

const PLAIN = { shift: false, toggle: false };
const SHIFT = { shift: true, toggle: false };
const TOGGLE = { shift: false, toggle: true };

// 可见行的渲染顺序,shift 范围只在这个序列上展开。
const VISIBLE = ["src", "src/a.ts", "src/b.ts", "docs", "docs/x.md"];

function click(current, path, modifiers, visiblePaths = VISIBLE) {
  return applyFileTreeRowClick(current, { path, visiblePaths, modifiers });
}

describe("applyFileTreeRowClick", () => {
  test("plain click replaces the selection and becomes the range anchor", () => {
    const next = click(singleFileTreeSelection("src/a.ts"), "docs/x.md", PLAIN);
    assert.deepEqual(next, { paths: ["docs/x.md"], anchor: "docs/x.md" });
  });

  test("shift click selects the visible range between the anchor and the row", () => {
    const anchored = click(EMPTY_FILE_TREE_SELECTION, "src/a.ts", PLAIN);
    assert.deepEqual(click(anchored, "docs", SHIFT), {
      paths: ["src/a.ts", "src/b.ts", "docs"],
      anchor: "src/a.ts",
    });
    // 反向 shift 得到同一段,而不是空集。
    assert.deepEqual(click(anchored, "src", SHIFT), {
      paths: ["src", "src/a.ts"],
      anchor: "src/a.ts",
    });
  });

  test("a shift range never crosses collapsed rows", () => {
    // docs 未展开时它的子文件不在可见序列里,范围必须停在 docs。
    const anchored = click(EMPTY_FILE_TREE_SELECTION, "src/a.ts", PLAIN);
    const collapsed = ["src", "src/a.ts", "src/b.ts", "docs"];
    assert.deepEqual(click(anchored, "docs", SHIFT, collapsed).paths, [
      "src/a.ts",
      "src/b.ts",
      "docs",
    ]);
  });

  test("shift click with no anchor degrades to a plain click", () => {
    assert.deepEqual(click(EMPTY_FILE_TREE_SELECTION, "docs", SHIFT), {
      paths: ["docs"],
      anchor: "docs",
    });
  });

  test("an anchor that scrolled out of the tree degrades to a plain click", () => {
    // 折叠/刷新后锚点行可能已经不可见;此时不该按陈旧的索引乱选一段。
    const anchored = click(EMPTY_FILE_TREE_SELECTION, "src/a.ts", PLAIN);
    const collapsed = ["src", "docs"];
    assert.deepEqual(click(anchored, "docs", SHIFT, collapsed), {
      paths: ["docs"],
      anchor: "docs",
    });
  });

  test("toggle adds and removes single rows without disturbing the anchor order", () => {
    let current = click(EMPTY_FILE_TREE_SELECTION, "src", PLAIN);
    current = click(current, "docs", TOGGLE);
    assert.deepEqual(current.paths, ["src", "docs"]);
    current = click(current, "src", TOGGLE);
    assert.deepEqual(current.paths, ["docs"]);
    // 取消到空集也算一次合法点击,锚点跟着走。
    assert.deepEqual(click(current, "docs", TOGGLE), { paths: [], anchor: "docs" });
  });

  test("the workspace root is never part of a selection", () => {
    // 根节点既不能作为引用插入,也不能整体删除,所以任何点击变体都不选它。
    const anchored = click(EMPTY_FILE_TREE_SELECTION, "src/a.ts", PLAIN);
    for (const modifiers of [PLAIN, SHIFT, TOGGLE]) {
      assert.deepEqual(click(anchored, "", modifiers), EMPTY_FILE_TREE_SELECTION);
    }
  });

  test("does not mutate the incoming selection", () => {
    const current = { paths: ["src"], anchor: "src" };
    click(current, "docs", SHIFT);
    click(current, "docs", TOGGLE);
    assert.deepEqual(current, { paths: ["src"], anchor: "src" });
  });
});

describe("resolveFileTreeContextSelection", () => {
  const known = new Set(VISIBLE);

  test("right-clicking inside a multi-selection keeps the whole set", () => {
    const multi = { paths: ["src", "src/a.ts"], anchor: "src" };
    assert.deepEqual(resolveFileTreeContextSelection(multi, "src/a.ts", known), multi);
  });

  test("right-clicking outside it collapses onto the clicked row", () => {
    const multi = { paths: ["src", "src/a.ts"], anchor: "src" };
    assert.deepEqual(resolveFileTreeContextSelection(multi, "docs", known), {
      paths: ["docs"],
      anchor: "docs",
    });
  });

  test("paths deleted behind our back are dropped before deciding", () => {
    const stale = { paths: ["src", "gone.ts"], anchor: "src" };
    assert.deepEqual(resolveFileTreeContextSelection(stale, "src", known), {
      paths: ["src"],
      anchor: "src",
    });
  });
});

describe("topLevelFileTreePaths", () => {
  test("drops descendants of a selected directory", () => {
    assert.deepEqual(topLevelFileTreePaths(["src", "src/a.ts", "src/deep/b.ts"]), ["src"]);
    assert.deepEqual(topLevelFileTreePaths(["src/a.ts", "src/b.ts", "docs"]), [
      "src/a.ts",
      "src/b.ts",
      "docs",
    ]);
  });

  test("does not treat a shared name prefix as nesting", () => {
    assert.deepEqual(topLevelFileTreePaths(["src", "src2/a.ts"]), ["src", "src2/a.ts"]);
  });

  test("deduplicates and drops the root", () => {
    assert.deepEqual(topLevelFileTreePaths(["src", "", "src", "docs"]), ["src", "docs"]);
  });

  test("keeps the incoming order so batches read like the tree", () => {
    assert.deepEqual(topLevelFileTreePaths(["docs/x.md", "src/a.ts"]), ["docs/x.md", "src/a.ts"]);
  });
});

describe("sameFileTreeSelection", () => {
  test("compares by value, not identity", () => {
    assert.equal(sameFileTreeSelection(singleFileTreeSelection("src"), singleFileTreeSelection("src")), true);
    assert.equal(sameFileTreeSelection(singleFileTreeSelection("src"), singleFileTreeSelection("docs")), false);
    assert.equal(
      sameFileTreeSelection({ paths: ["src", "docs"], anchor: "src" }, { paths: ["docs", "src"], anchor: "src" }),
      false,
    );
    assert.equal(
      sameFileTreeSelection({ paths: ["src"], anchor: "src" }, { paths: ["src"], anchor: "docs" }),
      false,
    );
  });
});
