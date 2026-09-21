import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// system prompt 的最后一段不在 buildPreparedContext 里，而是 **provider 边界按运行模式**
// 追加：agent 模式追加 buildToolsSuffix(...)，text 模式追加 buildTextOnlySystemSuffix()
// （内容是「You are currently in text-only mode: do not make any tool calls.」）。
//
// 所以「往 system prompt 加段」时必须问：这段在**所有**运行模式下都成立吗？
// 已经踩过一次：远程工作空间段（教模型怎么调 SSHManager）在 text 模式下也被注入，
// 与「不要发起任何工具调用」直接打架。
//
// 本文件把「本地/远程 × agent/text」四种组合各拼一份真实 system prompt，断言
// **没有任何组合出现互相矛盾的指令**。新增 prompt 段时这里会自动变成一道闸门。

const loader = createTsModuleLoader();
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { normalizeConversationState } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const { buildToolsSuffix } = loader.loadModule("src/lib/chat/runner/toolExecutionPrompt.ts");
const { buildTextOnlySystemSuffix } = loader.loadModule(
  "src/lib/providers/runtime/textOnlyRuntime.ts",
);
const { buildRemoteWorkspacePrompt } = loader.loadModule(
  "@liveagent/ui/lib/workspaceRemoteProject.ts",
);

// 真实值（config.sqlite）：活动项目是 remote kind，path 就是这个身份串。
const HOST_ID = "e9635c44-f026-41b7-8ca8-19e42d9b9fdf";
const REMOTE_PROMPT = buildRemoteWorkspacePrompt({
  hostId: HOST_ID,
  hostName: "个人",
  rootPath: "/data/upload",
});

// 真实注册表在各场景下给出的工具面（见 test/tools/ssh-manager-tools.test.mjs 的实测）。
const LOCAL_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Delete",
  "List",
  "Grep",
  "Glob",
  "Bash",
  "ManagedProcess",
  "ReadTerminal",
];
const REMOTE_TOOLS = ["SSHManager", "Browser"];

function stateOf(tools) {
  return normalizeConversationState({
    meta: {
      systemPrompt: "BASE",
      tools,
      totalSegmentCount: 1,
      totalMessageCount: 0,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "s0",
        messages: [],
        messageCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}

/**
 * 按真实链路拼一份 system prompt。
 * workdir 是「调用方传给 buildToolsSuffix 的本地根」：远程下为空串（builtinRegistry 的
 * hasLocalWorkspace 决定本地工具全不注册，调用方因此没有本地根可传）。
 */
function assemblePrompt({ mode, tools, workdir, remoteWorkspacePrompt }) {
  const toolDefs = tools.map((name) => ({
    name,
    description: "",
    parameters: { type: "object" },
  }));
  const context = buildPreparedContext({
    state: stateOf(toolDefs),
    tools: toolDefs,
    activeAgentPrompt: "",
    skillsPrompt: "",
    memoryPrompt: "",
    remoteWorkspacePrompt,
  });
  const parts = [typeof context.systemPrompt === "string" ? context.systemPrompt : ""];
  if (mode === "agent") parts.push(buildToolsSuffix(workdir, tools));
  else parts.push(buildTextOnlySystemSuffix());
  return parts.join("\n\n");
}

const SCENARIOS = [
  {
    label: "local + agent",
    mode: "agent",
    tools: LOCAL_TOOLS,
    workdir: "/workspace",
    remoteWorkspacePrompt: "",
    expectsRemoteBlock: false,
  },
  {
    label: "remote + agent",
    mode: "agent",
    tools: REMOTE_TOOLS,
    workdir: "",
    remoteWorkspacePrompt: REMOTE_PROMPT,
    expectsRemoteBlock: true,
  },
  {
    label: "local + text",
    mode: "text",
    tools: [],
    workdir: "",
    remoteWorkspacePrompt: "",
    expectsRemoteBlock: false,
  },
  {
    label: "remote + text",
    mode: "text",
    tools: [],
    workdir: "",
    // 调用方（useSendChatTurn / resolveManualCompactionPromptInputs）在 text 模式传空串。
    remoteWorkspacePrompt: "",
    expectsRemoteBlock: false,
  },
];

const PROMPTS = new Map(SCENARIOS.map((s) => [s.label, { s, prompt: assemblePrompt(s) }]));

describe("四种运行模式下 system prompt 不得自相矛盾", () => {
  test("the remote workspace block only appears in the remote agent scenario", () => {
    for (const { s, prompt } of PROMPTS.values()) {
      assert.equal(
        /## Remote workspace/.test(prompt),
        s.expectsRemoteBlock,
        `${s.label}: remote block presence`,
      );
    }
  });

  test("the tool-execution rules only appear in agent mode", () => {
    for (const { s, prompt } of PROMPTS.values()) {
      assert.equal(
        /# Tool-Execution Mode/.test(prompt),
        s.mode === "agent",
        `${s.label}: tool-execution section presence`,
      );
    }
  });

  test("「forbid all tool calls」 and 「use SSHManager」 never coexist", () => {
    // 这就是踩过的那个坑：text 模式的规则段与远程段直接打架。
    for (const { s, prompt } of PROMPTS.values()) {
      const forbidsTools = /do not make any tool calls/.test(prompt);
      const instructsSsh = /through the `SSHManager` tool/.test(prompt);
      assert.equal(
        forbidsTools && instructsSsh,
        false,
        `${s.label}: text-only rules and SSHManager instructions must not both be present`,
      );
    }
  });

  test("the text-only rules appear exactly in text mode", () => {
    for (const { s, prompt } of PROMPTS.values()) {
      assert.equal(
        /do not make any tool calls/.test(prompt),
        s.mode === "text",
        `${s.label}: text-only rules presence`,
      );
    }
  });

  test("the remote agent prompt never advertises local-only tools", () => {
    // 反向对照：远程下如果本地工具名出现在「可用」语境里，就说明工具面与 prompt 脱节。
    const { prompt } = PROMPTS.get("remote + agent");
    assert.doesNotMatch(prompt, /Workspace root \(sandbox\)/);
    assert.match(prompt, /no local workspace root/i);
    assert.match(prompt, /- .*\(SSHManager\)$/m);
  });
});
