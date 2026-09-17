import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadPrewarm(invoke) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
    },
  });
  return loader.loadModule("src/lib/tools/mcpPrewarm.ts");
}

function makeServer(id, overrides = {}) {
  return {
    id,
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "some-mcp@latest"],
    env: {},
    ...overrides,
  };
}

function makeSettings(servers) {
  return { mcp: { servers, selected: [] } };
}

test("prewarmMcpServers 只把已启用的 server 交给 Rust 侧", async () => {
  const calls = [];
  const { prewarmMcpServers } = loadPrewarm(async (command, args) => {
    calls.push({ command, args });
  });

  await prewarmMcpServers(
    makeSettings([makeServer("keep"), makeServer("off", { enabled: false })]),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "mcp_prewarm");
  // 禁用项不能进预热集合：预热会真的拉起子进程，对用户没启用的 server 起进程
  // 既浪费内存也可能触发意料之外的外部访问。
  assert.deepEqual(
    calls[0].args.servers.map((server) => server.id),
    ["keep"],
  );
});

test("prewarmMcpServers 过滤掉没有 id 的 server", async () => {
  const calls = [];
  const { prewarmMcpServers } = loadPrewarm(async (command, args) => {
    calls.push({ command, args });
  });

  await prewarmMcpServers(makeSettings([makeServer("  "), makeServer("real")]));

  assert.deepEqual(
    calls[0].args.servers.map((server) => server.id),
    ["real"],
  );
});

test("prewarmMcpServers 无启用 server 时不打扰 Rust 侧", async () => {
  const calls = [];
  const { prewarmMcpServers } = loadPrewarm(async (command, args) => {
    calls.push({ command, args });
  });

  await prewarmMcpServers(makeSettings([]));
  await prewarmMcpServers(makeSettings([makeServer("off", { enabled: false })]));

  assert.deepEqual(calls, []);
});

test("prewarmMcpServers 容忍缺失的 mcp 设置", async () => {
  const calls = [];
  const { prewarmMcpServers } = loadPrewarm(async (command, args) => {
    calls.push({ command, args });
  });

  // 设置尚未就绪时 App 也可能触发一次；预热不是校验点，不该抛出。
  await assert.doesNotReject(() => prewarmMcpServers({}));
  await assert.doesNotReject(() => prewarmMcpServers(undefined));

  assert.deepEqual(calls, []);
});

test("prewarmMcpServers 失败静默", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const { prewarmMcpServers } = loadPrewarm(async () => {
      throw new Error("prewarm boom");
    });

    // 预热是纯优化：失败绝不能冒泡到调用方（它跑在 App 的空闲回调里）。
    await assert.doesNotReject(() => prewarmMcpServers(makeSettings([makeServer("s1")])));
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
