import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

async function withNavigator(value, task) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value,
  });
  try {
    return await task();
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete globalThis.navigator;
    }
  }
}

test("resolveRuntimePlatform prefers the backend platform command", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          calls.push(command);
          assert.equal(command, "app_runtime_platform");
          return { platform: "windows" };
        },
      },
    },
  });

  const { resolveRuntimePlatform } = loader.loadModule("src/lib/runtimePlatform.ts");

  const platform = await withNavigator(
    { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel" },
    () => resolveRuntimePlatform(),
  );

  assert.equal(platform, "windows");
  assert.deepEqual(calls, ["app_runtime_platform"]);
});

test("resolveRuntimePlatform falls back to browser inference when backend command fails", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          assert.equal(command, "app_runtime_platform");
          throw new Error("not running under Tauri");
        },
      },
    },
  });

  const { resolveRuntimePlatform } = loader.loadModule("src/lib/runtimePlatform.ts");

  const platform = await withNavigator(
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" },
    () => resolveRuntimePlatform(),
  );

  assert.equal(platform, "windows");
});

// 缓存是刻意的：这个解析在发送消息的关键路径上，每轮白付一次跨进程往返。
// 并发调用必须只触发一次 IPC（缓存的是 Promise 而非结果值）。
test("resolveRuntimePlatform resolves through the backend only once", async () => {
  let calls = 0;
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          calls += 1;
          assert.equal(command, "app_runtime_platform");
          return { platform: "macos" };
        },
      },
    },
  });

  const { resolveRuntimePlatform } = loader.loadModule("src/lib/runtimePlatform.ts");

  const resolved = await withNavigator(
    { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" },
    () => Promise.all([resolveRuntimePlatform(), resolveRuntimePlatform(), resolveRuntimePlatform()]),
  );

  assert.deepEqual(resolved, ["macos", "macos", "macos"]);
  assert.equal(calls, 1);
});

// 失败也要缓存：平台在进程内不变，同步兜底的答案同样正确，重试只会让每轮
// 发送都多付一次注定失败的 IPC。
test("resolveRuntimePlatform caches the inference fallback instead of retrying", async () => {
  let calls = 0;
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          calls += 1;
          assert.equal(command, "app_runtime_platform");
          throw new Error("not running under Tauri");
        },
      },
    },
  });

  const { resolveRuntimePlatform } = loader.loadModule("src/lib/runtimePlatform.ts");

  const resolved = await withNavigator(
    { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel" },
    async () => [await resolveRuntimePlatform(), await resolveRuntimePlatform()],
  );

  assert.deepEqual(resolved, ["macos", "macos"]);
  assert.equal(calls, 1);
});
