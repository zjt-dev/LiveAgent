import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 拖拽改高输入框后的布局契约：多出来的高度必须进输入区，工具行与底部控制列
// 始终贴住卡片底边（卡片本身锚在窗口底部，所以它们看起来"不动"）。
// 回归表现是：多余高度堆在控制列下方成死白，圈着的两行像被拖动带离原位。

const source = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);

test("拖高态与展开态共用同一个「输入区填满」判据", () => {
  assert.match(
    source,
    /const composerEditorFillsHeight = isComposerExpanded \|\| composerCustomHeight !== null;/,
  );
});

test("输入面在拖高态吸收剩余高度，而不是只在展开态", () => {
  const surface = sliceBetween('"composer-input-surface', ")}");
  assert.match(surface, /composerEditorFillsHeight && "min-h-0 flex-1"/);
  // 退回 isComposerExpanded 单独判定就会重现 bug：折叠拖高时没有 flex-1，
  // 剩余高度落到控制列下面。
  assert.equal(surface.includes("isComposerExpanded &&"), false, "输入面不得只认展开态");
});

test("编辑器在拖高态解除 160px 上限并撑满", () => {
  const editorClass = sliceBetween('"min-h-[60px] px-0 py-0"', ")}");
  assert.match(editorClass, /composerEditorFillsHeight &&/);
  assert.match(editorClass, /surface === "desktop" \? "h-full max-h-none" : "h-full! max-h-none!"/);
  assert.equal(editorClass.includes("isComposerExpanded &&"), false, "编辑器不得只认展开态");
});

test("底部控制列不可压缩，保证工具行贴住卡片底边", () => {
  const deck = sliceBetween('"composer-control-deck', '">');
  assert.match(deck, /shrink-0/);
});

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `缺少锚点：${startMarker}`);
  assert.ok(end > start, `锚点顺序不对：${startMarker} -> ${endMarker}`);
  return source.slice(start, end);
}
