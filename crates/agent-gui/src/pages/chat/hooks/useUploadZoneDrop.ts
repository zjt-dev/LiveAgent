import { buildMountedRootDrafts } from "@liveagent/ui/lib/chat/mountedRootDrafts";
import { isRemoteWorkspaceProject } from "@liveagent/ui/lib/workspaceRemoteProject";
import { invoke } from "@tauri-apps/api/core";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { desktopWorkspaceProjectRootClient } from "../../../agent-ui-adapters/workspaceProjectRoots";
import type { WorkspaceProject } from "../../../lib/settings";
import { asErrorMessage } from "../chatPageUtils";
import type { ConversationUploadTarget } from "./usePendingUploads";

type SystemClassifiedDroppedPaths = {
  files: string[];
  dirs: string[];
};

type UseUploadZoneDropParams = {
  isAgentMode: boolean;
  canDropUpload: boolean;
  fileDropTitle: string;
  activeWorkspaceProject: WorkspaceProject | undefined;
  importReadableFilePaths: (paths: string[], target?: ConversationUploadTarget) => Promise<void>;
  resolveConversationTarget: (
    conversationId: string,
  ) => (ConversationUploadTarget & { project?: WorkspaceProject }) | null;
  addNotify: (type: "success" | "warning" | "error", message: string) => void;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  t: (key: string) => string;
  onWorkspaceDirectoriesMounted?: () => void;
};

/**
 * 上传区拖入内容的分发器：原生路径先经 Rust 分类，文件走附件导入管线，
 * 文件夹挂载为当前工作空间的附属目录（只读，可在项目设置中调整）。
 */
export function useUploadZoneDrop(params: UseUploadZoneDropParams) {
  const {
    canDropUpload,
    isAgentMode,
    fileDropTitle,
    activeWorkspaceProject,
    importReadableFilePaths,
    resolveConversationTarget,
    addNotify,
    setErrorMessage,
    t,
    onWorkspaceDirectoriesMounted,
  } = params;

  const mountDroppedFolders = useCallback(
    async (dirs: string[], targetProject?: WorkspaceProject) => {
      const project = targetProject ?? activeWorkspaceProject;
      if (!project?.path.trim()) {
        addNotify("warning", t("chat.workspaceMountDropNoProject"));
        return;
      }
      // 远程项目的 `path` 是身份串（`ssh://…`），不是本地目录。附属目录是「给本地文件工具
      // 追加可访问的本地根」，而远程会话下本地文件工具根本不注册（见 builtinRegistry 的
      // hasLocalWorkspace 门），挂了也用不上；下发到 Rust 只会被 canonical_directory 拒绝，
      // 弹出与真实原因无关的「挂载失败」。这里显式拦住并给出可理解的提示。
      if (isRemoteWorkspaceProject(project)) {
        addNotify("warning", t("chat.workspaceRemoteMountUnsupported"));
        return;
      }
      const existing = await desktopWorkspaceProjectRootClient.list(project);
      const result = buildMountedRootDrafts({
        projectPath: project.path,
        existingGrants: existing,
        folderPaths: dirs,
      });
      if (result.skippedInsideWorkspace.length > 0) {
        addNotify(
          "warning",
          t("chat.workspaceMountDropSkippedInside").replace(
            "{count}",
            String(result.skippedInsideWorkspace.length),
          ),
        );
      }
      if (result.skippedOverlapping.length > 0) {
        addNotify(
          "warning",
          t("chat.workspaceMountDropSkippedOverlap").replace(
            "{count}",
            String(result.skippedOverlapping.length),
          ),
        );
      }
      if (result.addedPaths.length === 0) return;
      await desktopWorkspaceProjectRootClient.save(project, result.drafts);
      onWorkspaceDirectoriesMounted?.();
      addNotify(
        "success",
        t("chat.workspaceMountDropSuccess").replace("{count}", String(result.addedPaths.length)),
      );
    },
    [activeWorkspaceProject, addNotify, onWorkspaceDirectoriesMounted, t],
  );

  const importUploadZonePaths = useCallback(
    async (paths: string[], targetConversationId?: string) => {
      try {
        const target = targetConversationId
          ? resolveConversationTarget(targetConversationId)
          : null;
        if (targetConversationId && !target) {
          addNotify("warning", "文件投放目标会话已失效，请重试");
          return;
        }
        const classified = await invoke<SystemClassifiedDroppedPaths>(
          "system_classify_dropped_paths",
          { paths },
        );
        if (classified.dirs.length > 0) {
          await mountDroppedFolders(classified.dirs, target?.project);
        }
        if (classified.files.length === 0) return;
        if (target ? !isAgentMode || !target.workdir.trim() : !canDropUpload) {
          setErrorMessage(fileDropTitle);
          return;
        }
        await importReadableFilePaths(classified.files, target ?? undefined);
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.workspaceMountDropFailed")));
      }
    },
    [
      addNotify,
      canDropUpload,
      fileDropTitle,
      importReadableFilePaths,
      isAgentMode,
      mountDroppedFolders,
      resolveConversationTarget,
      setErrorMessage,
      t,
    ],
  );

  return { importUploadZonePaths };
}
