import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const draftText = loader.loadModule("src/pages/chat/composer/composerDraftText.ts");
const sendSource = readFileSync(
  new URL("../../src/pages/chat/runtime/useSendChatTurn.ts", import.meta.url),
  "utf8",
);

const PASTE = {
  id: "p1",
  label: "Pasted 1",
  text: "LINE-1\nLINE-2",
  charCount: 13,
  lineCount: 2,
  preview: "LINE-1…",
};

function draftWithPaste() {
  return {
    segments: [
      { type: "text", text: "看下这段：" },
      { type: "largePaste", paste: PASTE },
    ],
    largePastes: [PASTE],
    textWithoutLargePastes: "看下这段：",
  };
}

// 远程工作空间没有本地根。大段粘贴的「导入成附件」会把它落成**工作目录**里的文件，
// 正文则被换成文件引用；而 agent 侧只注册 SSHManager，读不到那个本地文件 ——
// 粘贴内容等于静默丢失。修复前更糟：workdir 被兜底成本地默认项目，导入「成功」，
// 文件落在用户根本没在用的目录里。所以远程下必须跳过导入、把正文原样内联。
test("a skipped paste import keeps the pasted text inline", () => {
  const draft = draftWithPaste();

  // 不传 pastedFileById 即「跳过导入」时的输出：正文原样保留。
  const inlined = draftText.buildTextFromComposerDraft(draft);
  assert.match(inlined, /LINE-1\nLINE-2/);
  assert.doesNotMatch(inlined, /Pasted 1:/);

  // 反向对照：传了 map 才会换成文件引用 —— 那正是 agent 读不到远程文件的形态。
  const fileByPasteId = new Map([
    ["p1", { relativePath: ".liveagent/pasted-text/p1.txt" }],
  ]);
  const imported = draftText.buildTextFromComposerDraft(draft, fileByPasteId);
  assert.match(imported, /\[Pasted 1: \.liveagent\/pasted-text\/p1\.txt\]/);
  assert.doesNotMatch(imported, /LINE-1/);
});

test("importing a large paste without a local workdir throws", async () => {
  // 这条锁住「为什么远程必须显式跳过导入」：workdir 一旦为空（远程的预期状态），
  // 导入会抛错，而不是安静地退化成某种可用行为。所以不能靠它自己兜底。
  await assert.rejects(
    () => draftText.importPastedTextsAsFiles("", [PASTE]),
    /请先在项目栏选择或创建项目/,
  );
});

test("the send path gates the paste import on a non-remote workspace", () => {
  // 接线不变量：上面两条行为断言证明「跳过导入 → 正文保留」和「空 workdir → 抛错」，
  // 但证明不了发送链路真的会跳过。这里补上唯一能锁住接线的方式。
  assert.match(sendSource, /const canImportLargePastes = effectiveIsAgentMode && !activeWorkspaceIsRemote;/);
  // 正文构造与导入块必须用同一个闸，否则会出现「正文摘掉了但没导入」的丢字状态。
  const gateUses = sendSource.match(/canImportLargePastes/g) ?? [];
  assert.equal(gateUses.length, 3, "闸应出现在声明、正文构造、导入块三处");
  assert.doesNotMatch(
    sendSource,
    /if \(\s*effectiveIsAgentMode &&\s*composerDraft &&\s*composerDraft\.largePastes\.length > 0/,
  );
});
