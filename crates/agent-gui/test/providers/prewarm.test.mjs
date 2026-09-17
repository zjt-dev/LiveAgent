import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadPrewarm(invoke) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke },
    },
  });
  return loader.loadModule("src/lib/providers/prewarm.ts");
}

function makeSettings(overrides = {}) {
  return {
    selectedModel: { customProviderId: "p1", model: "m1" },
    customProviders: [
      {
        id: "p1",
        baseUrl: "https://api.example.com",
        useSystemProxy: false,
      },
    ],
    ...overrides,
  };
}

test("collectPrewarmTargets 只取当前选中供应商的 origin", () => {
  const { collectPrewarmTargets } = loadPrewarm(async () => undefined);

  assert.deepEqual(collectPrewarmTargets(makeSettings()), [
    { origin: "https://api.example.com", useSystemProxy: false },
  ]);
});

test("collectPrewarmTargets 从带路径的 baseUrl 里取 origin", () => {
  const { collectPrewarmTargets } = loadPrewarm(async () => undefined);

  const targets = collectPrewarmTargets(
    makeSettings({
      customProviders: [
        { id: "p1", baseUrl: "https://gw.example.com/v1/openai", useSystemProxy: false },
      ],
    }),
  );

  assert.deepEqual(targets, [{ origin: "https://gw.example.com", useSystemProxy: false }]);
});

test("collectPrewarmTargets 透传 useSystemProxy", () => {
  const { collectPrewarmTargets } = loadPrewarm(async () => undefined);

  const targets = collectPrewarmTargets(
    makeSettings({
      customProviders: [
        { id: "p1", baseUrl: "http://127.0.0.1:8080", useSystemProxy: true },
      ],
    }),
  );

  assert.deepEqual(targets, [{ origin: "http://127.0.0.1:8080", useSystemProxy: true }]);
});

test("collectPrewarmTargets 对缺失或不可用的配置返回空", () => {
  const { collectPrewarmTargets } = loadPrewarm(async () => undefined);

  // 没有选中的模型
  assert.deepEqual(collectPrewarmTargets(makeSettings({ selectedModel: undefined })), []);
  // 选中的供应商已不存在
  assert.deepEqual(
    collectPrewarmTargets(
      makeSettings({ selectedModel: { customProviderId: "gone", model: "m1" } }),
    ),
    [],
  );
  // baseUrl 空 / 非 http(s) / 非法
  for (const baseUrl of ["", "   ", "ftp://api.example.com", "not-a-url"]) {
    assert.deepEqual(
      collectPrewarmTargets(
        makeSettings({ customProviders: [{ id: "p1", baseUrl, useSystemProxy: false }] }),
      ),
      [],
      `baseUrl=${JSON.stringify(baseUrl)} 应当被跳过`,
    );
  }
});

test("prewarmProviderConnections 把目标原样交给 Rust 侧", async () => {
  const calls = [];
  const { prewarmProviderConnections } = loadPrewarm(async (command, args) => {
    calls.push({ command, args });
  });

  await prewarmProviderConnections(makeSettings());

  assert.deepEqual(calls, [
    {
      command: "proxy_prewarm",
      args: { targets: [{ origin: "https://api.example.com", useSystemProxy: false }] },
    },
  ]);
});

test("prewarmProviderConnections 无目标时不打扰 Rust 侧", async () => {
  const calls = [];
  const { prewarmProviderConnections } = loadPrewarm(async (command, args) => {
    calls.push({ command, args });
  });

  await prewarmProviderConnections(makeSettings({ selectedModel: undefined }));

  assert.deepEqual(calls, []);
});

test("prewarmProviderConnections 失败静默", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const { prewarmProviderConnections } = loadPrewarm(async () => {
      throw new Error("prewarm boom");
    });

    // 预热是纯优化：失败绝不能冒泡到调用方（它跑在 App 的空闲回调里）。
    await assert.doesNotReject(() => prewarmProviderConnections(makeSettings()));
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
