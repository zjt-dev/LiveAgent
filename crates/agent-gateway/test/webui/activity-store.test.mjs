import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { createActivityStore } = loader.loadModule("src/lib/chat/stream/activityStore.ts");

test("activity store hydrate drops a stale entry when the authoritative snapshot is empty", () => {
  const store = createActivityStore();
  // A run the gateway already settled, but whose stopped broadcast the client
  // missed: the local busy entry would otherwise keep the pending "Vibing..."
  // bubble alive forever (until the next reconnect re-baselines).
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    updatedAt: Date.now(),
  });
  assert.equal(store.isRunning("conv-1"), true);

  // The authoritative chat.activities snapshot says nothing is running.
  store.hydrate([]);
  assert.equal(store.isRunning("conv-1"), false);
});

test("empty activity hydration preserves only explicitly pending conversations", () => {
  const store = createActivityStore();
  for (const conversationId of ["conv-stale", "conv-pending"]) {
    store.applyActivityEvent({
      conversationId,
      runId: `run-${conversationId}`,
      running: true,
      state: "running",
      updatedAt: Date.now(),
    });
  }

  store.hydrate([], {
    keepConversationIds: new Set(["conv-pending"]),
  });

  assert.equal(store.isRunning("conv-stale"), false);
  assert.equal(store.isRunning("conv-pending"), true);
});
