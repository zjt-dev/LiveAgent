import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const appTheme = loader.loadModule("@liveagent/ui/lib/theme/appTheme.ts");

const {
  applyBackgroundImage,
  applyThemePresetId,
  DEFAULT_BACKGROUND_OPACITY,
  THEME_BACKGROUND_IMAGE_VAR,
  THEME_BACKGROUND_OPACITY_VAR,
  THEME_BACKGROUND_ROOT_ATTR,
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
