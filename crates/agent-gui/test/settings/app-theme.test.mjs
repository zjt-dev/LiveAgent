import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const appTheme = loader.loadModule("@liveagent/ui/lib/theme/appTheme.ts");

const {
  applyBackgroundImage,
  approximateDataUrlBytes,
  applyThemePresetId,
  DEFAULT_BACKGROUND_OPACITY,
  isLegacyBackgroundDataUrl,
  isThemeBackgroundRef,
  MAX_BACKGROUND_FILE_BYTES,
  THEME_BACKGROUND_IMAGE_VAR,
  THEME_BACKGROUND_OPACITY_VAR,
  THEME_BACKGROUND_ROOT_ATTR,
  themeBackgroundFileName,
} = appTheme;

/** 只实现 applyBackgroundImage / applyThemePresetId 用到的根节点接口。 */
function createRootStub() {
  const properties = new Map();
  const attributes = new Map();
  return {
    properties,
    attributes,
    style: {
      setProperty(name, value) {
        properties.set(name, value);
      },
      removeProperty(name) {
        properties.delete(name);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

test("background image writes the inline vars and the root marker attribute", () => {
  const root = createRootStub();

  applyBackgroundImage("data:image/webp;base64,AAAA", 0.5, root);

  assert.equal(root.properties.get(THEME_BACKGROUND_IMAGE_VAR), 'url("data:image/webp;base64,AAAA")');
  assert.equal(root.properties.get(THEME_BACKGROUND_OPACITY_VAR), "0.5");
  // 标记属性是宿主 CSS 作用域化「让 workbench 画布/pane 透出背景层」的开关；
  // 缺席时对话页的 bg-background 会整块盖住背景图。
  assert.equal(root.attributes.get(THEME_BACKGROUND_ROOT_ATTR), "");
});

test("clearing the background image removes the vars and the root marker attribute", () => {
  const root = createRootStub();

  applyBackgroundImage("data:image/webp;base64,AAAA", DEFAULT_BACKGROUND_OPACITY, root);
  applyBackgroundImage("   ", DEFAULT_BACKGROUND_OPACITY, root);

  assert.equal(root.properties.has(THEME_BACKGROUND_IMAGE_VAR), false);
  assert.equal(root.properties.has(THEME_BACKGROUND_OPACITY_VAR), false);
  assert.equal(root.attributes.has(THEME_BACKGROUND_ROOT_ATTR), false);
});

test("background dataURL quotes and backslashes stay escaped inside url()", () => {
  const root = createRootStub();

  applyBackgroundImage('data:image/svg+xml,<svg a="b"\\c/>', 0.35, root);

  assert.equal(
    root.properties.get(THEME_BACKGROUND_IMAGE_VAR),
    'url("data:image/svg+xml,<svg a=\\"b\\"\\\\c/>")',
  );
});

test("theme preset id toggles data-theme-preset and default clears it", () => {
  const root = createRootStub();

  applyThemePresetId("ocean", root);
  assert.equal(root.attributes.get("data-theme-preset"), "ocean");

  applyThemePresetId("default", root);
  assert.equal(root.attributes.has("data-theme-preset"), false);
});

test("blob object urls are applied the same way as data urls", () => {
  const root = createRootStub();

  // 背景图现在从 ~/.liveagent/theme 读回字节转 Blob URL，applyBackgroundImage 对
  // 两者一视同仁（只负责写 CSS 变量与标记属性）。
  applyBackgroundImage("blob:http://localhost/6f1c-abc", 0.4, root);

  assert.equal(
    root.properties.get(THEME_BACKGROUND_IMAGE_VAR),
    'url("blob:http://localhost/6f1c-abc")',
  );
  assert.equal(root.attributes.get(THEME_BACKGROUND_ROOT_ATTR), "");
});

test("background image setting is a disk ref and only accepts our own file names", () => {
  assert.equal(isThemeBackgroundRef("theme:background-1757-1a2b3c4d.webp"), true);
  assert.equal(themeBackgroundFileName("theme:background-1757-1a2b3c4d.webp"), "background-1757-1a2b3c4d.webp");

  // 设置项是用户可编辑的字符串，读盘前必须挡住穿越 / 绝对路径 / 任意扩展名。
  assert.equal(themeBackgroundFileName("theme:../../../windows/system.ini"), "");
  assert.equal(themeBackgroundFileName("theme:C:\\liveagent\\x.png"), "");
  assert.equal(themeBackgroundFileName("theme:settings-1.webp"), "");
  assert.equal(themeBackgroundFileName("theme:background-1.exe"), "");
  assert.equal(themeBackgroundFileName("theme:background-1"), "");
  assert.equal(themeBackgroundFileName("data:image/webp;base64,AAAA"), "");
  assert.equal(themeBackgroundFileName(""), "");
  assert.equal(themeBackgroundFileName(undefined), "");
});

test("legacy dataURL values stay recognizable for one-time migration", () => {
  assert.equal(isLegacyBackgroundDataUrl("data:image/webp;base64,AAAA"), true);
  assert.equal(isLegacyBackgroundDataUrl("theme:background-1-2a3b.webp"), false);
  assert.equal(isLegacyBackgroundDataUrl(""), false);
});

test("dataURL byte estimate matches the base64 payload size", () => {
  // "AAAA" = 4 个 base64 字符 = 3 字节。
  assert.equal(approximateDataUrlBytes("data:image/webp;base64,AAAA"), 3);
  // 没有逗号的输入不是 dataURL：按整串长度保守高估（调用方先用 isLegacyBackgroundDataUrl 过滤）。
  assert.equal(approximateDataUrlBytes("not-a-data-url"), "not-a-data-url".length);
});

test("background file cap matches the Rust THEME_BACKGROUND_MAX_BYTES", () => {
  // 改这里必须同步改 crates/agent-gui/src-tauri/src/commands/app/system.rs。
  assert.equal(MAX_BACKGROUND_FILE_BYTES, 24 * 1024 * 1024);
  assert.equal(DEFAULT_BACKGROUND_OPACITY, 0.35);
});
