import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 不变量：dock tab 的「点击激活」必须挂在**接受指针捕获的容器**上，而不是内层
// 覆盖按钮。
//
// 终端 tab 的拖出意图把 `currentTarget`（tab 容器）交给工作台拖拽会话，会话在
// 该容器上 `setPointerCapture`；真实浏览器会把随后的 click 重定向到捕获元素，
// 于是挂在**内层覆盖按钮**上的激活 handler 永远收不到 click —— 现象就是「终端
// tab 点不动，文件树等不取捕获的 tab 仍能切」。这里按真实浏览器语义断言接线：
// 命中容器（= 捕获重定向后 click 的落点）必须激活，关闭/拖拽手柄不能激活。
//
// jsdom 不实现指针捕获重定向，因此本测试不能直接复现浏览器行为；它锁的是让
// 该行为无害的接线（容器的 onClick），缺少这条接线时第一个用例就会失败。

// The strip imports the registry relatively, so the mock must be keyed by the
// resolved file path. Mocking it keeps the file-tree/git/tunnel panels (and
// their virtualizer + monaco deps) out of this DOM test.
const REGISTRY_PATH = fileURLToPath(
  new URL(
    "../../../agent-ui/src/components/project-tools/rightDockRegistry.tsx",
    import.meta.url,
  ),
);

const REGISTRY_MOCK = {
  getRightDockToolDefinition: (kind) => ({
    titleKey: `projectTools.${kind}Title`,
    closeKey: `projectTools.close.${kind}`,
    icon: () => null,
  }),
};

const NullIcon = () => null;

const env = await createDomTestEnv({
  mocks: {
    [REGISTRY_PATH]: REGISTRY_MOCK,
    // Icons resolve to null so the assertions only see tab structure.
    "@liveagent/ui/components/IconSet": {
      Check: NullIcon,
      Columns2: NullIcon,
      Cpu: NullIcon,
      GripVertical: NullIcon,
      Terminal: NullIcon,
      X: NullIcon,
    },
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({ t: (key) => key }),
    },
  },
});
const { React, act, createRoot } = env;
const { RightDockTabStrip } = env.loadModule(
  "@liveagent/ui/components/project-tools/RightDockTabStrip.tsx",
);

const SESSION = { id: "session-1", title: "Terminal 1", running: true };
const TERMINAL_TAB_ID = "session-1";
const FILE_TREE_TAB_ID = "tool:fileTree";

function click(element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function pointerDown(element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
}

function mountStrip(options = {}) {
  const calls = [];
  const consumed = { value: options.suppressClicks ?? false };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      React.createElement(RightDockTabStrip, {
        tabs: [
          { id: FILE_TREE_TAB_ID, kind: "fileTree" },
          { id: TERMINAL_TAB_ID, kind: "terminal", session: SESSION },
        ],
        currentActiveTab: "terminal",
        backgroundTasksRunning: 0,
        onCloseBackgroundTasks: () => calls.push("close:backgroundTasks"),
        activeSession: SESSION,
        pendingCloseSessionId: "",
        closingSessionIds: new Set(),
        draggingTabId: "",
        renderTabDragHandle: () => null,
        getTabDragProps: () => ({ onPointerDown: () => calls.push("reorderDrag") }),
        getTabDragStyle: () => undefined,
        consumeSuppressedTabClick: () => consumed.value,
        onActivateTab: (tabId) => calls.push(`tab:${tabId}`),
        onActivateTerminalSession: (session) => calls.push(`session:${session.id}`),
        onCloseToolTab: (kind) => calls.push(`close:${kind}`),
        onCloseTerminalRequest: (session) => calls.push(`closeRequest:${session.id}`),
        onTerminalTabDragStart: (session) => calls.push(`dragIntent:${session.id}`),
        onOpenTerminalInWorkbench: (session) => calls.push(`openInWorkbench:${session.id}`),
      }),
    );
  });
  return {
    calls,
    consumed,
    terminalTab: host.querySelector(`[data-project-tools-tab-id="${TERMINAL_TAB_ID}"]`),
    fileTreeTab: host.querySelector(`[data-project-tools-tab-id="${FILE_TREE_TAB_ID}"]`),
  };
}

test("a click retargeted to the tab container (pointer-capture landing spot) activates the tab", () => {
  const { calls, terminalTab } = mountStrip();
  // The drag-out gesture captures the pointer on this container, so this is
  // where Chromium dispatches the click; activation must live here too.
  click(terminalTab);
  assert.deepEqual(calls, [`session:${TERMINAL_TAB_ID}`]);
});

test("the inner overlay button still activates by bubbling into the container", () => {
  const { calls, terminalTab } = mountStrip();
  const overlayButton = terminalTab.querySelector("button[aria-label]");
  assert.ok(overlayButton, "the tab keeps a focusable overlay button for a11y");
  click(overlayButton);
  assert.deepEqual(calls, [`session:${TERMINAL_TAB_ID}`]);
});

test("a capture-free tab keeps activating exactly once", () => {
  const { calls, fileTreeTab } = mountStrip();
  click(fileTreeTab);
  assert.deepEqual(calls, [`tab:${FILE_TREE_TAB_ID}`]);
});

test("the close button and the drag grip never activate the tab", () => {
  const withClose = mountStrip();
  click(withClose.terminalTab.querySelector('[data-project-tools-tab-action="close"]'));
  assert.deepEqual(withClose.calls, [`closeRequest:${TERMINAL_TAB_ID}`]);

  const withGrip = mountStrip();
  const grip = withGrip.terminalTab.querySelector('[data-project-tools-tab-action="drag"]');
  pointerDown(grip);
  click(grip);
  // Grip gesture arms the drag-out intent; its click must not activate.
  assert.deepEqual(withGrip.calls, [`dragIntent:${TERMINAL_TAB_ID}`]);
});

test("a suppressed post-drag click is consumed instead of activating", () => {
  const { calls, consumed, terminalTab } = mountStrip({ suppressClicks: true });
  click(terminalTab);
  assert.deepEqual(calls, []);
  consumed.value = false;
  click(terminalTab);
  assert.deepEqual(calls, [`session:${TERMINAL_TAB_ID}`]);
});
