// Right-dock file tree panel: virtualized tree over the useFileTreeData
// layer, reading its wiring from the right-dock tool context.
//
// Shared implementation owned by @liveagent/ui. Host-specific icons, settings
// and backend capabilities resolve through the current application's contracts.

import type {
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
  WorkspaceProject,
} from "@liveagent/app/lib/settings";
import {
  Check,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { FileMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  finishWorkspacePathDrag,
  writeWorkspacePathDragPayload,
} from "../../../lib/chat/workspacePathDrag";
import { cn } from "../../../lib/shared/utils";
import type { WorkspaceActivityClient } from "../../../lib/workspace-activity/types";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import { Button } from "../../ui/button";
import { useConfirmDialog } from "../../ui/confirm-dialog";
import { Input } from "../../ui/input";
import { isWorkspaceImagePath } from "../../workspace-editor/workspaceImagePreview";
import { useRightDockToolContext } from "../RightDockContext";
import { FileTreeContextMenu } from "./ContextMenu";
import {
  addExpandedPaths,
  ancestorDirsOfPath,
  basename,
  dirname,
  FILE_TREE_HAS_OS_INTEGRATION,
  FILE_TREE_ROW_HEIGHT,
  type FileTreeExternalRoot,
  type FileTreeKind,
  flattenFileTreeRows,
  ROOT_PATH,
  remapExpandedPathsForRename,
  removeExpandedPath,
  removeExpandedSubtree,
} from "./model";
import { FileTreeErrorRow, FileTreeRow } from "./Row";
import {
  applyFileTreeRowClick,
  EMPTY_FILE_TREE_SELECTION,
  type FileTreeClickModifiers,
  type FileTreeSelection,
  resolveFileTreeContextSelection,
  sameFileTreeSelection,
  singleFileTreeSelection,
  topLevelFileTreePaths,
} from "./selection";
import { useFileTreeData } from "./useFileTreeData";
import { useFileTreeExternalRoots } from "./useFileTreeExternalRoots";

const FILE_TREE_QUERY_SYNC_DEBOUNCE_MS = 180;
const NO_EXTERNAL_FILE_TREE_ROOTS: readonly FileTreeExternalRoot[] = [];

type PendingAction = "file" | "folder" | "rename" | null;

type ContextMenuState = {
  x: number;
  y: number;
  path: string;
  // Batch targets frozen when the menu opened. More than one entry switches
  // the menu to its multi-selection form; a single entry keeps the regular
  // per-path menu. See `resolveFileTreeContextSelection`.
  selectionPaths: string[];
};

export function FileTreePanel(props: { active: boolean }) {
  const context = useRightDockToolContext();
  return (
    <FileTreeSurface
      active={props.active}
      projectPathKey={context.projectPathKey}
      cwd={context.cwd}
      state={context.fileTree.state}
      initialized={context.fileTree.initialized}
      externalRoots={context.fileTree.externalRoots}
      workspaceActivityClient={context.clients.workspaceActivity ?? null}
      onInitializedChange={context.fileTree.onInitializedChange}
      onRefreshExternalRoots={context.fileTree.refreshExternalRoots}
      onStateChange={context.fileTree.onStateChange}
      onInsertFileMentions={context.fileTree.onInsertFileMentions}
      onOpenFile={context.fileTree.onOpenFile}
    />
  );
}

export type FileTreeSurfaceProps = {
  active: boolean;
  projectPathKey: string;
  cwd: string;
  state: RightDockFileTreeState;
  initialized?: boolean;
  externalRoots?: readonly FileTreeExternalRoot[];
  workspaceActivityClient?: WorkspaceActivityClient | null;
  onInitializedChange?: (initialized: boolean) => void;
  onRefreshExternalRoots?: () => Promise<void>;
  onStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onInsertFileMentions?: (references: readonly FileMentionReference[]) => void;
  onOpenFile?: (path: string, imagePaths?: string[]) => void;
};

export type FileTreePaneSurfaceProps = Omit<
  FileTreeSurfaceProps,
  "externalRoots" | "onRefreshExternalRoots"
> & {
  workspaceProject?: WorkspaceProject;
  workspaceProjectRootClient?: WorkspaceProjectRootClient;
  workspaceRootRevision?: number;
};

/**
 * Workbench pane host for the file tree. The Right Dock fetches external
 * (multi-root) grants itself and injects them through context; a pane has no
 * dock context, so this wrapper owns the same fetch and keeps both hosts
 * rendering identical roots.
 */
export function FileTreePaneSurface(props: FileTreePaneSurfaceProps) {
  const { workspaceProject, workspaceProjectRootClient, workspaceRootRevision, ...surfaceProps } =
    props;
  const { externalRoots, refreshExternalRoots } = useFileTreeExternalRoots({
    workspaceProject,
    workspaceProjectRootClient,
    workspaceRootRevision,
  });
  return (
    <FileTreeSurface
      {...surfaceProps}
      externalRoots={externalRoots}
      onRefreshExternalRoots={refreshExternalRoots}
    />
  );
}

export function FileTreeSurface(props: FileTreeSurfaceProps) {
  const {
    active,
    projectPathKey,
    cwd,
    state: syncState,
    initialized = true,
    externalRoots = NO_EXTERNAL_FILE_TREE_ROOTS,
    workspaceActivityClient,
    onInitializedChange,
    onRefreshExternalRoots,
    onStateChange,
    onInsertFileMentions,
    onOpenFile,
  } = props;
  const { t } = useLocale();

  const [query, setQuery] = useState(syncState.query);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingTargetPath, setPendingTargetPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  // Multi-selection is transient (never persisted): `selectedPath` stays the
  // single source of truth for the persisted cursor, this only adds the extra
  // rows a shift/cmd click swept in.
  const [selection, setSelection] = useState<FileTreeSelection>(EMPTY_FILE_TREE_SELECTION);
  const selectionRef = useRef(selection);
  const commitSelection = useCallback((next: FileTreeSelection) => {
    if (sameFileTreeSelection(next, selectionRef.current)) return;
    selectionRef.current = next;
    setSelection(next);
  }, []);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const {
    nodes,
    loadChildren,
    refreshVisible,
    ensureDirsLoaded,
    createEntry,
    renameEntry,
    deleteEntries,
    openWorkspacePath,
    isExternalPath,
    getDisplayPath,
    search,
  } = useFileTreeData({
    projectPathKey,
    cwd,
    externalRoots,
    active,
    initialized,
    workspaceActivityClient: workspaceActivityClient ?? null,
    expandedPaths: syncState.expandedPaths,
    query,
    showHidden: syncState.showHidden,
  });

  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  const emitState = useCallback((patch: RightDockFileTreeStatePatch) => {
    onStateChangeRef.current(patch);
  }, []);

  // Expansion state has one source of truth: the persisted settings state.
  // `expandedRef` is updated both when a patch is emitted and when the
  // persisted state round-trips, so local toggles and sync operate on the
  // same value even mid-async-flow (no stale-closure overwrites).
  const expandedPaths = syncState.expandedPaths;
  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const expandedRef = useRef(expandedPaths);
  useEffect(() => {
    expandedRef.current = expandedPaths;
  }, [expandedPaths]);

  const setExpanded = useCallback(
    (next: string[]) => {
      if (next === expandedRef.current) return;
      expandedRef.current = next;
      emitState({ expandedPaths: next });
    },
    [emitState],
  );

  const selectedNode = nodes[syncState.selectedPath] ?? nodes[ROOT_PATH];
  const selectedPath = selectedNode?.path ?? ROOT_PATH;
  const canMutate = initialized && Boolean(projectPathKey && cwd);

  const selectPath = useCallback(
    (path: string) => {
      emitState({ selectedPath: path });
    },
    [emitState],
  );

  // Moves both the persisted cursor and the transient selection, for the
  // flows that resolve to exactly one row (reveal, create, rename, delete).
  const selectSinglePath = useCallback(
    (path: string) => {
      selectPath(path);
      commitSelection(singleFileTreeSelection(path));
    },
    [commitSelection, selectPath],
  );

  const toggleDirectory = useCallback(
    (path: string, isExpanded: boolean) => {
      if (isExpanded) {
        setExpanded(removeExpandedPath(expandedRef.current, path));
      } else {
        setExpanded(addExpandedPaths(expandedRef.current, [path]));
        void loadChildren(path);
      }
    },
    [loadChildren, setExpanded],
  );

  // Local query <-> persisted query (both directions, debounced outbound).
  useEffect(() => {
    setQuery((current) => (current === syncState.query ? current : syncState.query));
  }, [syncState.query]);
  useEffect(() => {
    if (!initialized || !projectPathKey || query === syncState.query) return;
    const timer = window.setTimeout(() => {
      emitState({ query });
    }, FILE_TREE_QUERY_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [emitState, initialized, projectPathKey, query, syncState.query]);

  // Transient UI state never leaks across project switches.
  useEffect(() => {
    void projectPathKey;
    setContextMenu(null);
    setPendingAction(null);
    setPendingTargetPath(null);
    setDraftName("");
    setActionError(null);
    setRevealTarget(null);
    commitSelection(EMPTY_FILE_TREE_SELECTION);
  }, [commitSelection, projectPathKey]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  // Reveal: expand + load the ancestor chain, then scroll the row into view.
  // The expansion merge reads `expandedRef` *after* the awaits so manual
  // expands that happened while loading are preserved (the old panel captured
  // a pre-await snapshot and overwrote them).
  const revealPath = useCallback(
    async (path: string, kind: FileTreeKind) => {
      const dirs =
        kind === "dir" && path ? [...ancestorDirsOfPath(path), path] : ancestorDirsOfPath(path);
      await ensureDirsLoaded(dirs);
      setExpanded(addExpandedPaths(expandedRef.current, dirs));
      selectSinglePath(path);
      setRevealTarget(path);
    },
    [ensureDirsLoaded, selectSinglePath, setExpanded],
  );

  // External reveal requests arrive as a bump of the persisted revision
  // nonce (state.revision) with selectedPath/expandedPaths already patched
  // by RightDockPanel.revealPathInFileTree.
  const lastRevisionRef = useRef(syncState.revision);
  useEffect(() => {
    const previous = lastRevisionRef.current;
    lastRevisionRef.current = syncState.revision;
    if (!initialized || !projectPathKey || previous === syncState.revision) return;
    const target = syncState.selectedPath;
    const kind = nodesRef.current[target]?.kind ?? "file";
    void revealPath(target, kind);
  }, [initialized, projectPathKey, revealPath, syncState.revision, syncState.selectedPath]);

  const rows = useMemo(() => flattenFileTreeRows(nodes, expandedSet), [expandedSet, nodes]);

  // Row order is what shift-ranges sweep over. Held in a ref so the row
  // click handler keeps a stable identity — a fresh callback per expand would
  // defeat FileTreeRow's memoization and re-render every visible row.
  const visiblePaths = useMemo(
    () => rows.filter((row) => row.type === "node").map((row) => row.path),
    [rows],
  );
  const visiblePathsRef = useRef(visiblePaths);
  useEffect(() => {
    visiblePathsRef.current = visiblePaths;
  }, [visiblePaths]);

  const rowIndexByPath = useMemo(() => {
    const index = new Map<string, number>();
    for (const [position, path] of visiblePaths.entries()) {
      index.set(path, position);
    }
    return index;
  }, [visiblePaths]);

  const handleRowSelect = useCallback(
    (path: string, modifiers: FileTreeClickModifiers) => {
      commitSelection(
        applyFileTreeRowClick(selectionRef.current, {
          path,
          visiblePaths: visiblePathsRef.current,
          modifiers,
        }),
      );
      // The persisted cursor follows the clicked row in every variant, so
      // "current file" consumers keep seeing the row the user just touched.
      selectPath(path);
    },
    [commitSelection, selectPath],
  );

  const selectedPathSet = useMemo(() => new Set(selection.paths), [selection.paths]);
  const hasMultiSelection = selection.paths.length > 1;

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_TREE_ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    if (!revealTarget) return;
    const index = rows.findIndex((row) => row.type === "node" && row.path === revealTarget);
    if (index < 0) return;
    rowVirtualizer.scrollToIndex(index, { align: "center" });
    setRevealTarget(null);
  }, [revealTarget, rowVirtualizer, rows]);

  const getSiblingImagePaths = useCallback((targetPath: string) => {
    if (!isWorkspaceImagePath(targetPath)) return [];
    const currentNodes = nodesRef.current;
    const parentNode = currentNodes[dirname(targetPath)];
    const siblingPaths =
      parentNode?.children.filter((childPath) => {
        const child = currentNodes[childPath];
        return child?.kind === "file" && isWorkspaceImagePath(childPath);
      }) ?? [];
    return siblingPaths.includes(targetPath) ? siblingPaths : [targetPath];
  }, []);

  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);
  const handleOpenFile = useCallback(
    (path: string) => {
      if (isExternalPath(path)) {
        if (!FILE_TREE_HAS_OS_INTEGRATION) return;
        setActionError(null);
        void openWorkspacePath(path, "open").catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      onOpenFileRef.current?.(path, getSiblingImagePaths(path));
    },
    [getSiblingImagePaths, isExternalPath, openWorkspacePath],
  );

  const onInsertFileMentionsRef = useRef(onInsertFileMentions);
  useEffect(() => {
    onInsertFileMentionsRef.current = onInsertFileMentions;
  }, [onInsertFileMentions]);
  const handleInsertMentions = useCallback(
    (paths: readonly string[]) => {
      const currentNodes = nodesRef.current;
      const order = rowIndexByPath;
      const references = paths
        .filter((path) => Boolean(path) && !isExternalPath(path) && Boolean(currentNodes[path]))
        .map<FileMentionReference>((path) => ({ path, kind: currentNodes[path].kind }))
        // Insert in visible row order so the chips read the same way the tree
        // does, regardless of the order the paths entered the selection.
        .sort((left, right) => (order.get(left.path) ?? 0) - (order.get(right.path) ?? 0));
      if (references.length === 0) return;
      onInsertFileMentionsRef.current?.(references);
    },
    [isExternalPath, rowIndexByPath],
  );
  const handleInsertMention = useCallback(
    (path: string) => handleInsertMentions([path]),
    [handleInsertMentions],
  );

  const handleWorkspacePathDragStart = useCallback(
    (event: ReactDragEvent, path: string, kind: FileTreeKind) => {
      const node = nodesRef.current[path];
      // External roots live outside the project cwd, so they have no
      // project-relative payload; the payload validator would reject their
      // sentinel prefix anyway, but refuse the drag explicitly.
      if (!node || !path || isExternalPath(path)) {
        event.preventDefault();
        return;
      }
      if (
        !writeWorkspacePathDragPayload(event.dataTransfer, {
          kind: "workspacePath",
          projectPathKey,
          cwd,
          relativePath: path,
          entryKind: kind,
          label: node.name,
        })
      ) {
        event.preventDefault();
      }
    },
    [cwd, isExternalPath, projectPathKey],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      const currentNodes = nodesRef.current;
      const targetPath = currentNodes[path] ? path : ROOT_PATH;
      // Right-clicking inside an existing multi-selection keeps it so the
      // batch menu can act on the whole set; anywhere else the selection
      // collapses onto the clicked row.
      const resolved = resolveFileTreeContextSelection(
        selectionRef.current,
        targetPath,
        new Set(Object.keys(currentNodes)),
      );
      commitSelection(resolved);
      selectPath(targetPath);
      const rect = panelRef.current?.getBoundingClientRect();
      setContextMenu({
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
        path: targetPath,
        selectionPaths: topLevelFileTreePaths(resolved.paths),
      });
    },
    [commitSelection, selectPath],
  );

  // Rows stop propagation on their own contextmenu, so reaching the container
  // handler means the click landed on empty space: drop any multi-selection
  // and offer the menu for the persisted cursor, as the panel always did.
  const openBackgroundContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      const cursor = selectedPath || ROOT_PATH;
      commitSelection(singleFileTreeSelection(cursor));
      openContextMenu(event, cursor);
    },
    [commitSelection, openContextMenu, selectedPath],
  );

  const startAction = useCallback(
    (action: Exclude<PendingAction, null>, targetPath: string) => {
      const currentNodes = nodesRef.current;
      const targetNode = currentNodes[targetPath] ?? currentNodes[ROOT_PATH];
      const normalizedTargetPath = targetNode?.path ?? ROOT_PATH;
      if (action === "rename" && !normalizedTargetPath) return;
      selectSinglePath(normalizedTargetPath);
      setPendingTargetPath(normalizedTargetPath);
      setPendingAction(action);
      setActionError(null);
      setDraftName(action === "rename" ? basename(normalizedTargetPath) : "");
    },
    [selectSinglePath],
  );

  const finishAction = useCallback(async () => {
    if (!pendingAction || busyAction) return;
    const name = draftName.trim();
    if (!name) {
      setActionError(t("projectTools.fileTree.nameRequired"));
      return;
    }
    setBusyAction(true);
    setActionError(null);
    try {
      const currentNodes = nodesRef.current;
      const targetPath = pendingTargetPath ?? selectedPath;
      const targetNode = currentNodes[targetPath] ?? currentNodes[ROOT_PATH];
      const targetDir =
        targetNode?.kind === "dir" ? targetNode.path : dirname(targetNode?.path ?? targetPath);
      if (pendingAction === "file") {
        const nextPath = await createEntry("file", targetDir, name);
        setExpanded(addExpandedPaths(expandedRef.current, [targetDir]));
        selectSinglePath(nextPath);
      } else if (pendingAction === "folder") {
        const nextPath = await createEntry("dir", targetDir, name);
        setExpanded(addExpandedPaths(expandedRef.current, [targetDir, nextPath]));
        selectSinglePath(nextPath);
      } else if (pendingAction === "rename" && targetPath) {
        const nextPath = await renameEntry(targetPath, name);
        setExpanded(remapExpandedPathsForRename(expandedRef.current, targetPath, nextPath));
        selectSinglePath(nextPath);
      }
      setPendingAction(null);
      setPendingTargetPath(null);
      setDraftName("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(false);
    }
  }, [
    busyAction,
    createEntry,
    draftName,
    pendingAction,
    pendingTargetPath,
    renameEntry,
    selectSinglePath,
    selectedPath,
    setExpanded,
    t,
  ]);

  const deletePaths = useCallback(
    async (paths: readonly string[]) => {
      // External roots are read-only here (same gate as the single-path menu).
      const targets = topLevelFileTreePaths(paths.filter((path) => !isExternalPath(path)));
      if (targets.length === 0 || busyAction) return;
      const confirmed = await requestConfirmDialog({
        title:
          targets.length > 1
            ? t("projectTools.fileTree.deleteMultiConfirm").replace(
                "{count}",
                String(targets.length),
              )
            : t("projectTools.fileTree.deleteConfirm").replace("{path}", targets[0]),
        subtitle: t("projectTools.fileTree.deleteConfirmDescription"),
        description:
          targets.length > 1 ? (
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">
                  {t("projectTools.fileTree.selectedCount").replace(
                    "{count}",
                    String(targets.length),
                  )}
                </div>
                <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-auto text-xs leading-5 text-muted-foreground">
                  {targets.map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">
                  {basename(targets[0])}
                </div>
                <p className="mt-1.5 break-all text-xs leading-5 text-muted-foreground">
                  {targets[0]}
                </p>
              </div>
            </div>
          ),
        confirmLabel: t("projectTools.fileTree.delete"),
        cancelLabel: t("settings.cancel"),
        closeLabel: t("projectTools.fileTree.deleteConfirmClose"),
      });
      if (!confirmed) return;
      setBusyAction(true);
      setActionError(null);
      try {
        const result = await deleteEntries(targets);
        for (const path of result.deleted) {
          setExpanded(removeExpandedSubtree(expandedRef.current, path));
        }
        const parent = dirname(targets[0]);
        selectPath(parent);
        commitSelection(
          targets.length > 1 ? EMPTY_FILE_TREE_SELECTION : singleFileTreeSelection(parent),
        );
        const firstFailure = result.failed[0];
        if (firstFailure) {
          setActionError(
            result.deleted.length === 0
              ? firstFailure.message
              : t("projectTools.fileTree.deletePartialFailed")
                  .replace("{done}", String(result.deleted.length))
                  .replace("{failed}", String(result.failed.length))
                  .replace("{message}", firstFailure.message),
          );
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction(false);
      }
    },
    [
      busyAction,
      commitSelection,
      deleteEntries,
      isExternalPath,
      requestConfirmDialog,
      selectPath,
      setExpanded,
      t,
    ],
  );

  const handleOpenExternal = useCallback(
    (path: string) => {
      setActionError(null);
      void openWorkspacePath(path, "open").catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    },
    [openWorkspacePath],
  );

  const handleOpenContainingDirectory = useCallback(
    (path: string) => {
      setActionError(null);
      void openWorkspacePath(path, "reveal").catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    },
    [openWorkspacePath],
  );

  const handleMenuRefresh = useCallback(
    (path: string, kind: FileTreeKind) => {
      void loadChildren(kind === "dir" ? path : dirname(path), { force: true });
    },
    [loadChildren],
  );

  const actionPlaceholder = useMemo(() => {
    if (pendingAction === "file") return t("projectTools.fileTree.newFilePlaceholder");
    if (pendingAction === "folder") return t("projectTools.fileTree.newFolderPlaceholder");
    if (pendingAction === "rename") return t("projectTools.fileTree.renamePlaceholder");
    return "";
  }, [pendingAction, t]);

  if (!initialized) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/80">
          <FolderOpen className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{t("projectTools.newFileTree")}</div>
          <div className="text-xs text-muted-foreground">
            {t("projectTools.fileTreeDescription")}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            onInitializedChange?.(true);
            void loadChildren(ROOT_PATH, { force: true });
          }}
        >
          {t("projectTools.newFileTree")}
        </Button>
      </div>
    );
  }

  const contextNode = contextMenu ? (nodes[contextMenu.path] ?? nodes[ROOT_PATH]) : null;
  // Batch targets for the multi-selection menu: the frozen selection minus
  // the read-only external roots. A single surviving target still means the
  // menu is multi (the user selected more than one row), it just disables the
  // entries that would silently skip rows.
  const contextBatchPaths = contextMenu
    ? contextMenu.selectionPaths.filter((path) => !isExternalPath(path))
    : [];
  const batchMenu = Boolean(contextMenu && contextMenu.selectionPaths.length > 1);

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 select-none flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("projectTools.fileTree.searchPlaceholder")}
            className="h-8 pl-7 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))]"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          title={t("projectTools.fileTree.refresh")}
          onClick={() => {
            void onRefreshExternalRoots?.();
            refreshVisible();
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {pendingAction ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void finishAction();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setPendingAction(null);
                setPendingTargetPath(null);
                setActionError(null);
              }
            }}
            placeholder={actionPlaceholder}
            className="h-8 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))]"
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-lg"
            disabled={busyAction}
            onClick={() => void finishAction()}
          >
            {busyAction ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-lg"
            onClick={() => {
              setPendingAction(null);
              setPendingTargetPath(null);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

      {query.trim() ? (
        <div className="project-file-tree-panel-scroll max-h-40 shrink-0 overflow-auto border-b border-border/60 px-2 py-2">
          {search.loading ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("projectTools.fileTree.searching")}
            </div>
          ) : search.error ? (
            <div className="px-2 py-1 text-xs text-destructive">{search.error}</div>
          ) : search.results.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("projectTools.fileTree.noMatches")}
            </div>
          ) : (
            search.results.map((entry) => {
              const TypeIcon = getFileTypeIcon(entry.path, entry.kind);
              return (
                <button
                  key={`${entry.kind}:${entry.path}`}
                  type="button"
                  draggable
                  className={cn(
                    "flex w-full select-none items-center gap-1.5 rounded-md px-2 text-left text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground",
                    entry.hidden && "opacity-60 hover:opacity-80",
                  )}
                  style={{ minHeight: FILE_TREE_ROW_HEIGHT }}
                  title={entry.path}
                  onClick={() => void revealPath(entry.path, entry.kind)}
                  onDragStart={(event) =>
                    handleWorkspacePathDragStart(event, entry.path, entry.kind)
                  }
                  onDragEnd={finishWorkspacePathDrag}
                >
                  <TypeIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{entry.path}</span>
                </button>
              );
            })
          )}
          {search.truncated ? (
            <div className="px-2 pt-1 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
              {t("projectTools.fileTree.resultsTruncated")}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        role="tree"
        aria-multiselectable
        ref={scrollRef}
        className="project-file-tree-panel-scroll min-h-0 flex-1 select-none overflow-auto px-2 py-2"
        onContextMenu={openBackgroundContextMenu}
      >
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            if (row.type === "error") {
              return (
                <div
                  key={row.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <FileTreeErrorRow depth={row.depth} message={row.message} />
                </div>
              );
            }
            const node = nodes[row.path];
            if (!node) return null;
            return (
              <div
                key={row.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <FileTreeRow
                  path={node.path}
                  name={node.name}
                  kind={node.kind}
                  hidden={node.hidden}
                  depth={row.depth}
                  expanded={expandedSet.has(row.path)}
                  selected={
                    hasMultiSelection ? selectedPathSet.has(row.path) : selectedPath === row.path
                  }
                  loading={node.loading}
                  title={getDisplayPath(row.path)}
                  onToggle={toggleDirectory}
                  onSelect={handleRowSelect}
                  onOpen={handleOpenFile}
                  onContextMenu={openContextMenu}
                  onDragStart={handleWorkspacePathDragStart}
                  onDragEnd={finishWorkspacePathDrag}
                />
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && contextNode ? (
        <FileTreeContextMenu
          key={`${contextMenu.path}:${contextMenu.x}:${contextMenu.y}`}
          anchor={{ x: contextMenu.x, y: contextMenu.y }}
          containerRef={panelRef}
          path={contextNode.path}
          displayPath={
            isExternalPath(contextNode.path) ? getDisplayPath(contextNode.path) : undefined
          }
          kind={contextNode.kind}
          selectionPaths={contextMenu.selectionPaths}
          canMutate={
            batchMenu
              ? canMutate && contextBatchPaths.length > 0
              : canMutate && !isExternalPath(contextNode.path)
          }
          canOpenFile={Boolean(onOpenFile) && !isExternalPath(contextNode.path)}
          canInsertMention={
            batchMenu
              ? Boolean(onInsertFileMentions) && contextBatchPaths.length > 0
              : Boolean(onInsertFileMentions) && !isExternalPath(contextNode.path)
          }
          showHidden={syncState.showHidden}
          onClose={() => setContextMenu(null)}
          onOpenFile={handleOpenFile}
          onOpenExternal={handleOpenExternal}
          onOpenContainingDirectory={handleOpenContainingDirectory}
          onStartAction={startAction}
          onDelete={(path) => void deletePaths([path])}
          onDeleteSelection={(paths) => void deletePaths(paths)}
          onInsertMention={handleInsertMention}
          onInsertSelectionMentions={handleInsertMentions}
          onRefresh={handleMenuRefresh}
          onToggleHidden={() => emitState({ showHidden: !syncState.showHidden })}
          onActionError={setActionError}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
