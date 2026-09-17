// Pure multi-selection model for the right-dock file tree panel.
//
// Multi-selection is transient UI state: only the "cursor" path travels
// through settings as `selectedPath`. Keeping the range/toggle math and the
// batch-target normalization here as framework-free functions keeps the panel
// thin and makes the semantics unit-testable without a DOM.
//
// Shared implementation owned by @liveagent/ui.

import { ROOT_PATH } from "./model";

export type FileTreeClickModifiers = {
  shift: boolean;
  toggle: boolean;
};

export type FileTreeSelection = {
  // Selected paths, in the order they entered the selection. Never contains
  // the workspace root: it is neither a reference target nor deletable.
  paths: string[];
  // Shift-range origin: the row the last non-range click landed on.
  anchor: string | null;
};

export const EMPTY_FILE_TREE_SELECTION: FileTreeSelection = { paths: [], anchor: null };

function isSelectablePath(path: string) {
  return Boolean(path) && path !== ROOT_PATH;
}

export function sameFileTreeSelection(left: FileTreeSelection, right: FileTreeSelection) {
  if (left === right) return true;
  if (left.anchor !== right.anchor || left.paths.length !== right.paths.length) return false;
  return left.paths.every((path, index) => path === right.paths[index]);
}

export function singleFileTreeSelection(path: string): FileTreeSelection {
  return isSelectablePath(path) ? { paths: [path], anchor: path } : EMPTY_FILE_TREE_SELECTION;
}

export function fileTreeSelectionHasMulti(selection: FileTreeSelection) {
  return selection.paths.length > 1;
}

/**
 * Folds one row click into the selection.
 *
 * - plain click replaces the selection (and is the only variant that may
 *   expand a directory or open a file — the caller gates that);
 * - ctrl/cmd click toggles a single row and moves the range anchor;
 * - shift click extends from the anchor over the *visible* row order, so a
 *   collapsed subtree never silently joins the range. A stale anchor (the row
 *   scrolled out of the tree after a collapse) degrades to a plain click
 *   instead of selecting something arbitrary.
 */
export function applyFileTreeRowClick(
  selection: FileTreeSelection,
  input: { path: string; visiblePaths: readonly string[]; modifiers: FileTreeClickModifiers },
): FileTreeSelection {
  const { path, visiblePaths, modifiers } = input;
  if (!isSelectablePath(path)) return EMPTY_FILE_TREE_SELECTION;
  if (modifiers.toggle) {
    const paths = selection.paths.includes(path)
      ? selection.paths.filter((item) => item !== path)
      : [...selection.paths, path];
    return { paths, anchor: path };
  }
  if (modifiers.shift) {
    const anchor = selection.anchor;
    const anchorIndex = anchor ? visiblePaths.indexOf(anchor) : -1;
    const pathIndex = visiblePaths.indexOf(path);
    if (anchorIndex < 0 || pathIndex < 0) return singleFileTreeSelection(path);
    const start = Math.min(anchorIndex, pathIndex);
    const end = Math.max(anchorIndex, pathIndex);
    return {
      paths: visiblePaths.slice(start, end + 1).filter(isSelectablePath),
      anchor,
    };
  }
  return singleFileTreeSelection(path);
}

/**
 * Right-clicking inside an existing multi-selection keeps it so the batch menu
 * can act on the whole set; anywhere else (including a row that was deleted
 * behind our back) the selection collapses onto the clicked row.
 */
export function resolveFileTreeContextSelection(
  selection: FileTreeSelection,
  path: string,
  knownPaths: ReadonlySet<string>,
): FileTreeSelection {
  const live = selection.paths.filter((item) => knownPaths.has(item));
  if (live.length > 1 && live.includes(path)) {
    return { paths: live, anchor: selection.anchor };
  }
  return singleFileTreeSelection(path);
}

/**
 * Deduplicates paths and drops any that nest inside another selected
 * directory. A parent already covers its children, and asking the backend to
 * delete a child after its parent is gone is an error rather than a no-op.
 */
export function topLevelFileTreePaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!isSelectablePath(path) || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}
