/**
 * 代码编辑器 tab 条的批量关闭语义（纯函数，不依赖 Monaco/React，便于单测）。
 *
 * tab 顺序 = tab 条从左到右的视觉顺序，即 `tabs.map((tab) => tab.key)`。
 * 右键菜单只负责问「关哪一批」和「关完之后显示谁」，真正的摘除与 Monaco model
 * 释放留在 WorkspaceCodeEditorOverlay 里，和单个关闭走同一条路径。
 */

export type EditorTabCloseMode = "left" | "others" | "all";

/**
 * 算出一次批量关闭要摘掉的 tab key。锚点（被右键的那个 tab）自身：
 * - `left`：不关，只关它左边的；
 * - `others`：关，被右键的那个是唯一的幸存者；
 * - `all`：关。
 *
 * 锚点已不在表里（菜单打开后另一个来源把该 tab 关了）时返回空集，调用方据此
 * 什么都不做，而不是把整条 tab 条关掉。
 */
export function resolveEditorTabCloseKeys(
  tabKeys: readonly string[],
  anchorKey: string,
  mode: EditorTabCloseMode,
): string[] {
  const anchorIndex = tabKeys.indexOf(anchorKey);
  if (anchorIndex < 0) return [];
  if (mode === "left") return tabKeys.slice(0, anchorIndex);
  if (mode === "all") return [...tabKeys];
  return tabKeys.filter((_, index) => index !== anchorIndex);
}

/**
 * 批量关闭后应该显示哪个 tab。
 *
 * 当前激活的 tab 没被关就维持原样；被关了就接手被关闭区间最左位置的右侧第一
 * 个幸存者（等价于单个关闭里 `next[Math.min(index, next.length - 1)]` 的「原地
 * 接替」），右边没有了再回头看左边，全被关完返回 ""——此时编辑器留在空态，与
 * 一个个手动关到空的行为一致。
 */
export function pickEditorTabActiveKeyAfterClose(
  tabKeys: readonly string[],
  closingKeys: ReadonlySet<string>,
  activeKey: string,
): string {
  if (!closingKeys.has(activeKey)) return activeKey;
  const anchorIndex = tabKeys.findIndex((key) => closingKeys.has(key));
  if (anchorIndex < 0) return activeKey;
  for (let index = anchorIndex; index < tabKeys.length; index += 1) {
    const key = tabKeys[index];
    if (!closingKeys.has(key)) return key;
  }
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const key = tabKeys[index];
    if (!closingKeys.has(key)) return key;
  }
  return "";
}
