import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 「功能实现了但用户找不到入口」的 DOM 级回归。
//
// 远程文件夹下本地根为空，`disabledMessage` 必定有值；顶栏的 dock 折叠按钮此前
// 只看这一个信号就直接禁用 —— dock 打不开，而「远程工作空间」侧栏的两个入口
// （dock 空态卡片、「+」菜单）都在 dock 里面，于是功能整体不可达。这个测试用
// 真实 registry + 真实 launcher 渲染，锁住：
//   1. 远程项目下两个入口都出现、都可点，点击进的是同一个 kind；
//   2. 本地项目工具（文件树/审查/SSH）在同一屏里仍然是禁用的，并给出禁用原因；
//   3. 顶栏折叠按钮在「远程侧栏可用」时不被禁用原因锁死。
//
// 重面板（文件树 / 审查 / 隧道 / 远程面板本体）与 Base UI 的下拉都换成轻量替身：
// 断言对象是入口列表本身，不是这些实现。

const reactRef = { current: null };
const h = (type, props, ...children) => reactRef.current.createElement(type, props, ...children);
const NullIcon = () => null;
const Stub = () => null;

const projectToolPath = (relative) =>
  fileURLToPath(
    new URL(`../../../agent-ui/src/components/project-tools/${relative}`, import.meta.url),
  );

// 图标全部渲染成 null：断言只看入口的结构与可点性。
const iconMocks = {
  ChevronRight: NullIcon,
  Columns2: NullIcon,
  Cpu: NullIcon,
  FolderTree: NullIcon,
  GitBranch: NullIcon,
  Globe: NullIcon,
  Key: NullIcon,
  PanelRightClose: NullIcon,
  PanelRightOpen: NullIcon,
  Plus: NullIcon,
  Server: NullIcon,
  Terminal: NullIcon,
};
const iconSetPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url),
);
const dropdownMenuPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/ui/dropdown-menu.tsx", import.meta.url),
);

// Base UI 的下拉需要 portal / 定位 / ResizeObserver，jsdom 里不值得拉起；
// 替身保留「disabled + title + onSelect」这三个被断言的语义。
const DropdownStub = (props) => h("div", null, props.children);
const DropdownTriggerStub = (props) =>
  h("button", { type: "button", disabled: props.disabled, title: props.title }, props.children);
const DropdownItemStub = (props) =>
  h(
    "button",
    {
      type: "button",
      disabled: props.disabled,
      title: props.title,
      onClick: props.onSelect,
    },
    props.children,
  );
const dropdownMocks = {
  DropdownMenu: DropdownStub,
  DropdownMenuContent: DropdownStub,
  DropdownMenuItem: DropdownItemStub,
  DropdownMenuSub: DropdownStub,
  DropdownMenuSubContent: DropdownStub,
  DropdownMenuSubTrigger: DropdownItemStub,
  DropdownMenuTrigger: DropdownTriggerStub,
};

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": iconMocks,
    // IconSet 在 toggle 里是按相对路径导入的，mock 必须按解析后的路径再挂一份。
    [iconSetPath]: iconMocks,
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({ locale: "zh-CN", t: (key) => key }),
    },
    "@liveagent/ui/components/project-tools/file-tree/index": { FileTreePanel: Stub },
    "@liveagent/ui/components/project-tools/git-review/index": { GitReviewPanel: Stub },
    [projectToolPath("LocalTunnelPanel.tsx")]: { LocalTunnelPanel: Stub },
    [projectToolPath("SshTunnelPanel.tsx")]: { SshTunnelPanel: Stub },
    [projectToolPath("RemoteWorkspacePanel.tsx")]: { RemoteWorkspacePanel: Stub },
    "@liveagent/ui/components/ui/dropdown-menu": dropdownMocks,
    // 同 IconSet：launcher 里是按相对路径导入的。
    [dropdownMenuPath]: dropdownMocks,
  },
});
reactRef.current = env.React;
const { React, act, createRoot } = env;

const { RightDockChooser, RightDockCreateMenu } = env.loadModule(
  "@liveagent/ui/components/project-tools/RightDockLauncher.tsx",
);
const { ProjectToolsPanelToggle } = env.loadModule(
  "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle.tsx",
);

const LOCAL_DISABLED_MESSAGE = "Select a project to use project tools.";
const REMOTE_DISABLED_MESSAGE = "projectTools.remoteWorkspaceNeedsRemote";
const REMOTE_TILE_TITLE = "projectTools.newRemoteWorkspace";
const FILE_TREE_TILE_TITLE = "projectTools.newFileTree";

function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    host,
    click: (target) => {
      act(() => {
        target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

/** 入口按钮按可见文案定位（launcher 给每项渲染 createTitleKey 的翻译）。 */
function entryByTitle(host, title) {
  return [...host.querySelectorAll("button")].find((button) =>
    (button.textContent ?? "").includes(title),
  );
}

function chooserProps(overrides = {}) {
  return {
    creating: false,
    disabledMessage: LOCAL_DISABLED_MESSAGE,
    error: null,
    loading: false,
    onCreateTerminal: () => {},
    onOpenBackgroundTasks: () => {},
    onStartTool: () => {},
    projectReady: false,
    remoteWorkspaceAvailable: true,
    remoteWorkspaceDisabledMessage: REMOTE_DISABLED_MESSAGE,
    terminalDisabledMessage: LOCAL_DISABLED_MESSAGE,
    terminalReady: false,
    tunnelAvailable: false,
    ...overrides,
  };
}

describe("远程文件夹里的入口", () => {
  test("the chooser offers the remote workspace tile and it starts the tool", () => {
    const started = [];
    const view = mount(
      React.createElement(
        RightDockChooser,
        chooserProps({ onStartTool: (kind) => started.push(kind) }),
      ),
    );
    const tile = entryByTitle(view.host, REMOTE_TILE_TITLE);
    assert.ok(tile, "the remote workspace tile must be rendered");
    assert.equal(tile.disabled, false, "it must be clickable in a remote folder");
    // 可点的一项不该带着「只在远程文件夹中可用」这种禁用原因。
    assert.equal(tile.getAttribute("title"), null);
    view.click(tile);
    assert.deepEqual(started, ["remoteWorkspace"]);
    view.unmount();
  });

  test("local-only tools stay disabled next to it, with their own reason", () => {
    const started = [];
    const view = mount(
      React.createElement(
        RightDockChooser,
        chooserProps({ onStartTool: (kind) => started.push(kind) }),
      ),
    );
    const fileTree = entryByTitle(view.host, FILE_TREE_TILE_TITLE);
    assert.ok(fileTree, "the file tree tile stays listed");
    assert.equal(fileTree.disabled, true);
    assert.equal(fileTree.getAttribute("title"), LOCAL_DISABLED_MESSAGE);
    view.click(fileTree);
    assert.deepEqual(started, []);
    view.unmount();
  });

  test("a local project greys the remote tile out and explains why", () => {
    const view = mount(
      React.createElement(
        RightDockChooser,
        chooserProps({
          projectReady: true,
          remoteWorkspaceAvailable: false,
          terminalReady: true,
        }),
      ),
    );
    const tile = entryByTitle(view.host, REMOTE_TILE_TITLE);
    assert.ok(tile);
    assert.equal(tile.disabled, true);
    assert.equal(tile.getAttribute("title"), REMOTE_DISABLED_MESSAGE);
    const fileTree = entryByTitle(view.host, FILE_TREE_TILE_TITLE);
    assert.equal(fileTree.disabled, false);
    view.unmount();
  });

  test("the create menu lists the same entry with the same gating", () => {
    const started = [];
    const remoteMenu = mount(
      React.createElement(
        RightDockCreateMenu,
        chooserProps({
          onOpenChange: () => {},
          onStartTool: (kind) => started.push(kind),
          open: true,
          shellOptions: [],
        }),
      ),
    );
    const remoteItem = entryByTitle(remoteMenu.host, REMOTE_TILE_TITLE);
    assert.ok(remoteItem, "the create menu must list the remote workspace tool");
    assert.equal(remoteItem.disabled, false);
    remoteMenu.click(remoteItem);
    assert.deepEqual(started, ["remoteWorkspace"]);
    remoteMenu.unmount();

    const localMenu = mount(
      React.createElement(
        RightDockCreateMenu,
        chooserProps({
          onOpenChange: () => {},
          open: true,
          projectReady: true,
          remoteWorkspaceAvailable: false,
          shellOptions: [],
          terminalReady: true,
        }),
      ),
    );
    const localItem = entryByTitle(localMenu.host, REMOTE_TILE_TITLE);
    assert.ok(localItem);
    assert.equal(localItem.disabled, true);
    assert.equal(localItem.getAttribute("title"), REMOTE_DISABLED_MESSAGE);
    localMenu.unmount();
  });
});

describe("顶栏的 dock 折叠按钮", () => {
  test("stays enabled while the remote workspace sidebar is available", () => {
    const toggles = [];
    const view = mount(
      React.createElement(ProjectToolsPanelToggle, {
        disabledMessage: LOCAL_DISABLED_MESSAGE,
        isOpen: false,
        onToggle: () => toggles.push("toggle"),
        remoteWorkspaceAvailable: true,
        sessionCount: 0,
      }),
    );
    const button = view.host.querySelector("button");
    assert.equal(button.disabled, false, "a remote folder must be able to open the dock");
    assert.equal(button.getAttribute("title"), "Expand project tools panel");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    view.click(button);
    assert.deepEqual(toggles, ["toggle"]);
    view.unmount();
  });

  test("stays disabled for a project that has nothing to show", () => {
    const view = mount(
      React.createElement(ProjectToolsPanelToggle, {
        disabledMessage: LOCAL_DISABLED_MESSAGE,
        isOpen: false,
        onToggle: () => {},
        sessionCount: 0,
      }),
    );
    const button = view.host.querySelector("button");
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("title"), LOCAL_DISABLED_MESSAGE);
    view.unmount();
  });

  test("an open dock can always be collapsed again", () => {
    const view = mount(
      React.createElement(ProjectToolsPanelToggle, {
        disabledMessage: LOCAL_DISABLED_MESSAGE,
        isOpen: true,
        onToggle: () => {},
        sessionCount: 2,
      }),
    );
    const button = view.host.querySelector("button");
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("title"), "Collapse project tools panel");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.match(button.textContent ?? "", /2/);
    view.unmount();
  });
});
