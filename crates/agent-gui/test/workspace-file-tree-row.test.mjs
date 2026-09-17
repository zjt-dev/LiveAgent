import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

function createRowHarness() {
  const loader = createTsModuleLoader({
    mocks: {
      react: {
        memo(component) {
          return component;
        },
      },
      "@liveagent/ui/i18n/index": {
        useLocale() {
          return { t: (key) => key };
        },
      },
      "@liveagent/ui/components/IconSet": {
        ChevronRight: (props) => ({ type: "ChevronRight", props }),
        Loader2: (props) => ({ type: "Loader2", props }),
      },
      "@liveagent/ui/lib/shared/utils": {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
      "@liveagent/ui/components/chat/fileTypeIcons": {
        getFileTypeIcon() {
          return (props) => ({ type: "FileTypeIcon", props });
        },
      },
    },
  });
  return loader.loadModule("@liveagent/ui/components/project-tools/file-tree/Row.tsx");
}

function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

const PLAIN_CLICK = { shiftKey: false, metaKey: false, ctrlKey: false };
const SHIFT_CLICK = { shiftKey: true, metaKey: false, ctrlKey: false };
const CTRL_CLICK = { shiftKey: false, metaKey: false, ctrlKey: true };

function renderRow(overrides = {}) {
  const { FileTreeRow } = createRowHarness();
  const calls = [];
  const tree = FileTreeRow({
    path: "assets/preview.png",
    name: "preview.png",
    kind: "file",
    hidden: false,
    depth: 1,
    expanded: false,
    selected: false,
    loading: false,
    title: "assets/preview.png",
    onToggle: (...args) => calls.push(["toggle", ...args]),
    onSelect: (...args) => calls.push(["select", ...args]),
    onOpen: (...args) => calls.push(["open", ...args]),
    onContextMenu() {},
    ...overrides,
  });
  return { tree, calls };
}

test("workspace file tree opens files from anywhere in the hovered row", () => {
  const { tree, calls } = renderRow();

  assert.equal(tree.props.onDoubleClick, undefined);
  assert.match(tree.props.className, /\bw-full\b/);
  assert.equal(typeof tree.props.onClick, "function");
  tree.props.onClick(PLAIN_CLICK);

  assert.deepEqual(calls, [
    ["select", "assets/preview.png", { shift: false, toggle: false }],
    ["open", "assets/preview.png"],
  ]);
});

test("workspace file tree expands directories with one click", () => {
  const { tree, calls } = renderRow({
    path: "assets",
    name: "assets",
    kind: "dir",
  });
  const [expandButton] = findAll(tree, (node) => node.type === "button");

  tree.props.onClick(PLAIN_CLICK);
  assert.deepEqual(calls, [
    ["select", "assets", { shift: false, toggle: false }],
    ["toggle", "assets", false],
  ]);

  calls.length = 0;
  let propagationStopped = false;
  expandButton.props.onClick({
    stopPropagation() {
      propagationStopped = true;
    },
  });
  assert.equal(propagationStopped, true);
  assert.deepEqual(calls, [["toggle", "assets", false]]);
});

test("workspace file tree modifier clicks only move the selection", () => {
  // 多选点击不应该展开目录或打开文件:否则 shift 划过的每一行都会触发一次。
  const cases = [
    [SHIFT_CLICK, { shift: true, toggle: false }],
    [CTRL_CLICK, { shift: false, toggle: true }],
  ];
  for (const [event, modifiers] of cases) {
    const file = renderRow();
    file.tree.props.onClick(event);
    assert.deepEqual(file.calls, [["select", "assets/preview.png", modifiers]]);

    const dir = renderRow({ path: "assets", name: "assets", kind: "dir" });
    dir.tree.props.onClick(event);
    assert.deepEqual(dir.calls, [["select", "assets", modifiers]]);
  }
});

test("workspace file tree treats cmd-click as a toggle on every platform", () => {
  const { tree, calls } = renderRow();
  tree.props.onClick({ shiftKey: false, metaKey: true, ctrlKey: false });
  assert.deepEqual(calls, [["select", "assets/preview.png", { shift: false, toggle: true }]]);
});

test("workspace file tree rows expose a copy drag without replacing click behavior", () => {
  const dragCalls = [];
  const { tree } = renderRow({
    onDragStart: (...args) => dragCalls.push(args),
    onDragEnd: () => dragCalls.push(["end"]),
  });
  const event = { dataTransfer: {} };
  assert.equal(tree.props.draggable, true);
  tree.props.onDragStart(event);
  tree.props.onDragEnd();
  assert.deepEqual(dragCalls, [
    [event, "assets/preview.png", "file"],
    ["end"],
  ]);
});
