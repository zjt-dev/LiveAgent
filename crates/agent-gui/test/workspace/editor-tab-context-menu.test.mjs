import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 代码编辑器 tab 右键菜单的接线不变量。批量关闭的目标集合与接替规则本身由
// editor-tab-close-scope.test.mjs 覆盖，这里锁的是「菜单确实接上了、而且批量
// 关闭没有绕过未保存改动那道闸」——这两件事最容易在重构时静悄悄丢掉。

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const overlaySource = readSource(
  "../../../agent-ui/src/components/workspace-editor/WorkspaceCodeEditorOverlay.tsx",
);

function sliceBetween(startMarker, endMarker) {
  const start = overlaySource.indexOf(startMarker);
  const end = overlaySource.indexOf(endMarker);
  assert.ok(start >= 0, `缺少锚点：${startMarker}`);
  assert.ok(end > start, `锚点顺序不对：${startMarker} -> ${endMarker}`);
  return overlaySource.slice(start, end);
}

test("每个已打开的文件 tab 都接上了右键菜单", () => {
  assert.match(
    overlaySource,
    /onContextMenu=\{\(event\) => openTabContextMenu\(event, tab\.key\)\}/,
  );
  // 菜单记住的是被右键的那个 tab，不是当前激活的那个。
  assert.match(overlaySource, /setTabContextMenu\(\{ \.\.\.position, tabKey \}\)/);
});

test("三项菜单都走带未保存闸门的 requestCloseTabs", () => {
  const menu = sliceBetween(
    "{tabContextMenu && tabContextMenuTargets",
    "{globalError || activeTab?.error",
  );
  for (const mode of ["left", "others", "all"]) {
    assert.match(menu, new RegExp(`requestCloseTabs\\(tabContextMenuTargets\\.${mode}\\)`), mode);
    // 没有可关对象的那一项置灰，而不是点了没反应。
    assert.match(
      menu,
      new RegExp(`disabled=\\{tabContextMenuTargets\\.${mode}\\.length === 0\\}`),
      mode,
    );
  }
  assert.equal(menu.includes("closeTabsNow("), false, "菜单不许绕过脏检查直接摘 tab");
});

test("批量关闭复用同一套未保存确认框，三个出口都认得 closeTabs", () => {
  assert.match(
    overlaySource,
    /setPendingDialog\(\{ kind: "closeTabs", tabKeys: \[\.\.\.closing\] \}\)/,
  );
  const discard = sliceBetween("const discardDialogTarget", "const saveDialogTarget");
  assert.match(discard, /dialog\.kind === "closeTabs"[\s\S]*closeTabsNow\(dialog\.tabKeys\)/);

  const save = sliceBetween("const saveDialogTarget", "const showFind");
  // 沿用 closeOverlay 的语义：全部存成功才关，任一失败就停在确认框上。
  assert.match(save, /dialog\.kind === "closeTabs"[\s\S]*if \(!saved\) return;/);
  assert.match(
    save,
    /dialog\.kind === "closeOverlay"[\s\S]*dialog\.kind === "closeTabs"[\s\S]*closeTabsNow\(closing\)/,
  );

  // 取消只关对话框，不动任何 tab；多项时确认按钮要说「保存全部」，否则用户以为只存当前。
  const footer = sliceBetween("<AlertDialogFooter>", "</AlertDialogFooter>");
  const cancelButton = footer.slice(
    footer.indexOf("onClick={() => setPendingDialog(null)}") - 80,
    footer.indexOf("onClick={() => setPendingDialog(null)}") + 45,
  );
  assert.equal(cancelButton.includes("closeTabs"), false, "取消按钮不许顺带关标签");
  assert.match(
    footer,
    /pendingDialog\?\.kind === "closeOverlay" \|\| pendingDialog\?\.kind === "closeTabs"[\s\S]*workspaceEditor\.saveAll/,
  );
});

test("两个菜单互斥，且点击外部与 Escape 都会收起 tab 菜单", () => {
  const opener = sliceBetween("const openTabContextMenu", "useEffect(() => {\n    if (!openRequest");
  assert.match(opener, /setContextMenu\(null\)/);
  const editorOpener = sliceBetween(
    "const openEditorContextMenu",
    "const openTabContextMenu",
  );
  assert.match(editorOpener, /setTabContextMenu\(null\)/);

  assert.match(overlaySource, /if \(event\.key === "Escape"\) \{\n\s+setContextMenu\(null\);\n\s+setTabContextMenu\(null\);/);
  const dismissal = sliceBetween("if (!contextMenu && !tabContextMenu) return;", "}, [contextMenu, tabContextMenu]);");
  assert.ok(dismissal.includes('addEventListener("click"'), "外部点击要能关掉菜单");
  assert.ok(dismissal.includes("setTabContextMenu(null)"));
});

test("菜单文案在中英两种语言里都注册了", () => {
  const en = readSource("../../../agent-ui/src/i18n/translations/enUSCommon.ts");
  const zh = readSource("../../../agent-ui/src/i18n/translations/zhCNCommon.ts");
  for (const key of [
    "closeTabsMenu",
    "closeTabsLeft",
    "closeTabsOthers",
    "closeTabsAll",
  ]) {
    assert.ok(en.includes(`"workspaceEditor.context.${key}"`), `en 缺少 ${key}`);
    assert.ok(zh.includes(`"workspaceEditor.context.${key}"`), `zh 缺少 ${key}`);
    assert.ok(overlaySource.includes(`t("workspaceEditor.context.${key}")`), `未使用的 ${key}`);
  }
  assert.match(zh, /"workspaceEditor\.context\.closeTabsLeft": "关闭左侧标签"/);
  assert.match(zh, /"workspaceEditor\.context\.closeTabsOthers": "关闭其它标签"/);
  assert.match(zh, /"workspaceEditor\.context\.closeTabsAll": "关闭所有标签"/);
  // 确认框文案也要成对存在（缺一个就会在批量关闭脏 tab 时显示 key 原文）。
  assert.match(en, /"workspaceEditor\.closeTabsDirtyTitle"/);
  assert.match(zh, /"workspaceEditor\.closeTabsDirtyTitle": "关闭这些文件前保存修改？"/);
});
