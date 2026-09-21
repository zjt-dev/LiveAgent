import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 远程工作空间说明段（remoteWorkspace）是 system prompt 里新加的一段。它必须同时
// 满足两件事，否则远程会话能跑但每轮都在污染轨迹：
//
//   1. 真的被拼进模型可见的 system prompt（agent 才知道该走 SSHManager）；
//   2. 被轨迹的槽位表认识 —— 轨迹靠 composeTrajectorySystemPrompt 逐段重建 prompt
//      并与实际值比对来判定「system 段是否变化」。槽位表漏掉这一段，重建结果必然
//      短一截，于是每一轮都判定为变化，掉进 drift fallback：轨迹里整份 prompt 被
//      记成一个 runtime 块，分段信息全部丢失，还会持续刷 drift 警告。

const loader = createTsModuleLoader();
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { composeTrajectorySystemPrompt } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/sections.ts",
);
const { normalizeConversationState } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);

const TOOLS = [{ name: "SSHManager", description: "ssh", parameters: { type: "object" } }];

function stateOf(messages) {
  return normalizeConversationState({
    meta: {
      systemPrompt: "BASE",
      tools: TOOLS,
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "s0",
        messages,
        messageCount: messages.length,
        createdAt: 1,
        updatedAt: messages.length + 1,
      },
    ],
  });
}

function build(params) {
  const captured = [];
  const context = buildPreparedContext({
    state: stateOf([]),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: "",
    ...params,
    captureSlots: (slots) => captured.push(slots),
  });
  return { context, slots: captured[0] ?? {} };
}

describe("远程工作空间说明段进 system prompt", () => {
  test("the block reaches the model-visible prompt", () => {
    const { context, slots } = build({
      activeAgentPrompt: "AGENT",
      skillsPrompt: "SKILLS",
      remoteWorkspacePrompt: "REMOTE-BLOCK",
    });
    assert.equal(slots.remoteWorkspace, "REMOTE-BLOCK");
    assert.match(context.systemPrompt, /REMOTE-BLOCK/);
  });

  test("it sits between the agent prompt and skills", () => {
    // 顺序必须与轨迹的 TRAJECTORY_PROMPT_SECTION_SLOTS 一致，否则重建对不上。
    const { context } = build({
      activeAgentPrompt: "AGENT-BLOCK",
      skillsPrompt: "SKILLS-BLOCK",
      remoteWorkspacePrompt: "REMOTE-BLOCK",
    });
    const at = (needle) => context.systemPrompt.indexOf(needle);
    assert.ok(at("AGENT-BLOCK") >= 0, "agent block missing");
    assert.ok(at("AGENT-BLOCK") < at("REMOTE-BLOCK"), "remote block must follow the agent prompt");
    assert.ok(at("REMOTE-BLOCK") < at("SKILLS-BLOCK"), "remote block must precede skills");
  });

  test("a local workspace produces no such slot", () => {
    // 本地工作空间传空串：不能凭空多出一段，否则本地 prompt 也变了。
    const { context, slots } = build({ remoteWorkspacePrompt: "" });
    assert.equal(slots.remoteWorkspace, undefined);
    assert.doesNotMatch(context.systemPrompt, /## Remote workspace/);
  });
});

describe("轨迹槽位表认识远程工作空间段", () => {
  test("the segment is reconstructed in place instead of falling back to drift", () => {
    // 这是 drift 的直接复现：重建结果必须与逐段拼接的结果逐字节一致。
    const rebuilt = composeTrajectorySystemPrompt({
      base: "BASE",
      agent: "AGENT",
      remoteWorkspace: "REMOTE-BLOCK",
      skills: "SKILLS",
      memory: "MEMORY",
      runtime: "RUNTIME",
    });
    assert.equal(rebuilt, "BASE\n\nAGENT\n\nREMOTE-BLOCK\n\nSKILLS\n\nMEMORY\n\nRUNTIME");
  });

  test("the slot table lists the segment on both orders", () => {
    const types = loader.loadModule("@liveagent/ui/lib/trajectory/types.ts");
    // 存储槽位 append-only；拼接顺序决定重建能否对上，两者都必须包含它。
    assert.ok([...types.TRAJECTORY_SECTION_SLOTS].includes("remoteWorkspace"));
    assert.ok([...types.TRAJECTORY_PROMPT_SECTION_SLOTS].includes("remoteWorkspace"));
  });
});
