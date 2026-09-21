import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// toolsSuffix 是拼在 system prompt 末尾、provider 边界前的工具执行规则段。
//
// 它原来假定「一定有一个本地工作空间根」，无条件输出
// `- Workspace root (sandbox): \`<workdir>\`` 并让模型用 workspace-relative 路径。
// 远程工作空间下 workdir 为空、本地工具一个都没注册，这段就会变成
// `- Workspace root (sandbox): \`\`` 加一串本地路径指引 —— 与远端事实正好相反，
// 模型会拿本地路径去试并逐个失败。
//
// 判据：远程下必须给专用变体（说明没有本地根、改走 SSHManager），且不得出现本地措辞。

const loader = createTsModuleLoader();
const { buildToolsSuffix } = loader.loadModule("src/lib/chat/runner/toolExecutionPrompt.ts");

const LOCAL_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
const REMOTE_TOOL_NAMES = ["SSHManager", "AskUserQuestion"];

describe("toolsSuffix 的工作空间段", () => {
  test("a remote workspace gets the SSH variant, not the local-root wording", () => {
    const suffix = buildToolsSuffix("", REMOTE_TOOL_NAMES, "linux");
    assert.match(suffix, /no local workspace root/i);
    assert.match(suffix, /SSHManager/);
    // 本地措辞一律不得出现 —— 它们会直接指向不存在的本地根。
    assert.doesNotMatch(suffix, /Workspace root \(sandbox\)/);
    assert.doesNotMatch(suffix, /workspace-relative paths exactly as tools return them/);
  });

  test("a local workspace keeps the original wording", () => {
    // 正向对照：没有这条，上面那组 doesNotMatch 可能因为「段落整个没输出」而平凡通过。
    const suffix = buildToolsSuffix("/workspace", LOCAL_TOOL_NAMES, "linux");
    assert.match(suffix, /## Workspace & Paths/);
    assert.match(suffix, /- Workspace root \(sandbox\): `\/workspace`/);
    assert.match(suffix, /workspace-relative paths exactly as tools return them/);
    assert.doesNotMatch(suffix, /no local workspace root/i);
  });

  test("the remote variant is emitted because SSHManager is present", () => {
    // 远程下真正会命中这段的条件：hasAny(..., "SSHManager", ...)。
    // 没有 SSHManager 时整段不输出，也不该凭空冒出本地措辞。
    const suffix = buildToolsSuffix("", ["AskUserQuestion"], "linux");
    assert.doesNotMatch(suffix, /## Workspace & Paths/);
    assert.doesNotMatch(suffix, /Workspace root \(sandbox\)/);
  });
});

describe("toolsSuffix 的 Available Tools 目录", () => {
  // 目录是模型判定「我手上有什么」的权威清单。远程工作空间下 SSHManager 是唯一能碰到
  // 工作区的工具，漏掉它就会和上面的「Workspace & Paths」段自相矛盾：正文让模型用它，
  // 目录里却查不到 —— 把目录当完整清单的模型会以为无从下手。
  test("SSHManager is listed in the catalog", () => {
    const suffix = buildToolsSuffix("", REMOTE_TOOL_NAMES, "linux");
    assert.match(suffix, /## Available Tools/);
    assert.match(suffix, /- .*\(SSHManager\)$/m);
  });

  test("SSHManager is listed for a local project too, since it can be registered there", () => {
    // 本地项目关联了 SSH 主机时同样会注册 SSHManager，目录不能只在远程出现。
    const suffix = buildToolsSuffix("/workspace", ["SSHManager", "Bash"], "linux");
    assert.match(suffix, /- .*\(SSHManager\)$/m);
  });

  test("the catalog entry is gated on the tool actually being registered", () => {
    // 正向对照：没注册就不能列。没有这条，上面两条可能因为「无条件输出」而平凡通过。
    const suffix = buildToolsSuffix("/workspace", ["Read", "Bash"], "linux");
    assert.doesNotMatch(suffix, /\(SSHManager\)/);
    // 且目录本身仍在（否则 doesNotMatch 会因为整段缺失而平凡通过）。
    assert.match(suffix, /## Available Tools/);
    assert.match(suffix, /- .*\(Bash\)$/m);
  });
});
