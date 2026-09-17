import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 文件树多选的接线不变量。选择语义本身（范围、切换、顶层归一）由
// file-tree-selection.test.mjs 覆盖，这里锁的是「面板确实按这套语义接上了、
// 而且批量动作没有绕开二次确认和 composer 的批量入口」——这几件事最容易在
// 重构时静悄悄丢掉。

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const panelSource = readSource(
  "../../../agent-ui/src/components/project-tools/file-tree/index.tsx",
);
const rowSource = readSource("../../../agent-ui/src/components/project-tools/file-tree/Row.tsx");
const menuSource = readSource(
  "../../../agent-ui/src/components/project-tools/file-tree/ContextMenu.tsx",
);
const dataSource = readSource(
  "../../../agent-ui/src/components/project-tools/file-tree/useFileTreeData.ts",
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `缺少锚点：${startMarker}`);
  assert.ok(end > start, `锚点顺序不对：${startMarker} -> ${endMarker}`);
  return source.slice(start, end);
}

test("行点击把 shift / cmd / ctrl 归一成修饰键并透传给选择逻辑", () => {
  assert.match(
    rowSource,
    /onClick=\{\(event\) =>\s*activateRow\(\{ shift: event\.shiftKey, toggle: event\.metaKey \|\| event\.ctrlKey \}\)\s*\}/,
  );
  // 带修饰键的点击只挪选择：否则 shift 划过的每一行都会展开目录或打开文件。
  assert.match(rowSource, /if \(modifiers\.shift \|\| modifiers\.toggle\) return;/);
});

test("shift 范围只在当前可见行序列上展开", () => {
  assert.match(panelSource, /applyFileTreeRowClick\(selectionRef\.current, \{/);
  assert.match(panelSource, /visiblePaths: visiblePathsRef\.current/);
  // 可见行序列必须走 ref，否则每次展开都会换掉 onSelect 的引用、把 memo 打穿。
  assert.match(panelSource, /const visiblePathsRef = useRef\(visiblePaths\)/);
});

test("右键落在多选集合内保留整个集合，落在外面收敛为单行", () => {
  assert.match(
    panelSource,
    /resolveFileTreeContextSelection\(\s*selectionRef\.current,\s*targetPath,\s*new Set\(Object\.keys\(currentNodes\)\),?\s*\)/,
  );
  // 空右键（容器）必须先清掉多选，再按持久光标开菜单。
  const background = sliceBetween(
    panelSource,
    "const openBackgroundContextMenu",
    "const startAction",
  );
  assert.match(background, /commitSelection\(singleFileTreeSelection\(cursor\)\)/);
});

test("批量菜单只在多选时出现，并且不掺入单行动作", () => {
  assert.match(menuSource, /const batch = selectionPaths\.length > 1;/);
  assert.match(menuSource, /\{batch \? batchItems : singlePathItems\}/);
  const batchItems = sliceBetween(menuSource, "const batchItems = (", "const singlePathItems = (");
  assert.match(batchItems, /onInsertSelectionMentions\(selectionPaths\)/);
  assert.match(batchItems, /onDeleteSelection\(selectionPaths\)/);
  // 打开 / 重命名 / 新建在多选下没有唯一目标，不能出现在批量菜单里。
  for (const banned of ["onOpenFile(", "onStartAction(", "onOpenExternal("]) {
    assert.equal(batchItems.includes(banned), false, `批量菜单不该有 ${banned}`);
  }
});

test("批量插入走 composer 的批量入口，而不是循环调用单条插入", () => {
  assert.match(panelSource, /onInsertFileMentionsRef\.current\?\.\(references\)/);
  assert.equal(
    /onInsertFileMentionsRef\.current\?\.\([^)]*,\s*[^)]*\)/.test(panelSource),
    false,
    "批量入口只接受引用数组，不能再按 (path, kind) 单条调用",
  );
});

test("批量删除必须过二次确认，并先做父子归一", () => {
  const deletePaths = sliceBetween(
    panelSource,
    "const deletePaths = useCallback(",
    "const handleOpenExternal",
  );
  assert.match(deletePaths, /topLevelFileTreePaths\(paths\.filter\(\(path\) => !isExternalPath\(path\)\)\)/);
  assert.match(deletePaths, /await requestConfirmDialog\(\{/);
  assert.match(deletePaths, /if \(!confirmed\) return;/);
  assert.match(deletePaths, /await deleteEntries\(targets\)/);
  // 数据层同样归一：批量删除的公共入口不能依赖调用方已经整理过。
  assert.match(dataSource, /const targets = topLevelFileTreePaths\(paths\);/);
});

test("批量删除是 best-effort：单项失败不中断其余目标", () => {
  const loop = sliceBetween(dataSource, "for (const path of targets) {", "// Refresh each affected");
  assert.match(loop, /failed\.push\(/);
  assert.match(loop, /continue;/);
  // 每个受影响目录只刷新一次，且不再刷新已被删除的父目录。
  assert.match(dataSource, /const parents = new Set<string>\(\);/);
  assert.match(dataSource, /deleted\.some\(/);
});
