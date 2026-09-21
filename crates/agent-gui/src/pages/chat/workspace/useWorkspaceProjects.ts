import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import type { RemoteWorkspaceSelection } from "@liveagent/ui/components/chat/WorkspaceRemoteFolderPicker";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { sidebarScopeKey } from "@liveagent/ui/lib/sidebar/scope";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarScope } from "@liveagent/ui/lib/sidebar/types";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import {
  assignWorkspaceProjectToGroup,
  createWorkspaceProjectFromPath,
  ensureWorktreeProjectGroup,
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  getDefaultWorkspaceProjectPath,
  mergeWorkspaceProjectsWithHistory,
} from "@liveagent/ui/lib/workspaceProjects";
import {
  createRemoteWorkspaceProject,
  isRemoteWorkspacePath,
  isRemoteWorkspaceProject,
  isRemoteWorkspaceSessionUsable,
} from "@liveagent/ui/lib/workspaceRemoteProject";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  openRightDockSingletonTab,
  resolveWorkspaceProjects,
  updateCustomSettings,
  updateSshProjectHostIds,
  type WorkspaceProject,
  type WorkspaceProjectGroup,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import { asErrorMessage } from "../chatPageUtils";
import { startWorkspaceCloneTask } from "./cloneTasks";

type UseWorkspaceProjectsParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  sidebarStore: SidebarStore;
  isAgentMode: boolean;
  workdir: string;
  t: (key: string) => string;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setActiveView: Dispatch<SetStateAction<ApplicationViewId>>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  startNewConversationActionRef: MutableRefObject<(options?: { workdir?: string }) => string>;
  prepareComposerForConversationChangeActionRef: MutableRefObject<() => void>;
};

/**
 * Workspace-project domain state: the merged project list (settings +
 * history workdirs), active/missing/archived derivations, the sidebar scope
 * that follows the active project, and every non-destructive project action
 * (activate, select, browse, create, rename, pin, sidebar collapse).
 *
 * Destructive actions (remove/archive) live in useWorkspaceProjectRemoval —
 * they need conversation/terminal caches that are wired later in ChatPage.
 */
export function useWorkspaceProjects(params: UseWorkspaceProjectsParams) {
  const {
    settings,
    setSettings,
    sidebarStore,
    isAgentMode,
    workdir,
    t,
    setErrorMessage,
    setActiveView,
    setRightDockOpen,
    startNewConversationActionRef,
    prepareComposerForConversationChangeActionRef,
  } = params;

  const sidebarWorkdirs = useSidebarSelector(sidebarStore, (s) => s.workdirs);
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, sidebarWorkdirs),
    [sidebarWorkdirs, settings.system],
  );
  const [searchNavigation, setSearchNavigation] = useState<{
    mode: typeof isAgentMode;
    cwd: string;
  } | null>(null);
  const clearSearchConversationWorkspace = useCallback(() => setSearchNavigation(null), []);
  const searchCwd = searchNavigation?.mode === isAgentMode ? searchNavigation.cwd : undefined;
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectIdState] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const setActiveWorkspaceProjectId = useCallback<Dispatch<SetStateAction<string>>>((id) => {
    setSearchNavigation(null);
    setActiveWorkspaceProjectIdState(id);
  }, []);
  useEffect(() => {
    if (searchNavigation && searchNavigation.mode !== isAgentMode) setSearchNavigation(null);
  }, [searchNavigation, isAgentMode]);
  const missingWorkspaceProjectPathKeys = useMemo(
    () =>
      new Set(
        settings.system.missingWorkspaceProjectPaths
          // 「目录缺失」是本地语义：远程项目的可用性取决于隧道在不在，跟本地目录
          // 存在与否无关。守卫之前写下的存量标记必须在这里失效，否则侧栏行会把
          // 「新建对话」换成「删除」，用户在远程文件夹里再也开不了新会话。
          .filter((path) => !isRemoteWorkspacePath(path))
          .map(workspaceProjectPathKey),
      ),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const archivedWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.archivedWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.archivedWorkspaceProjectPaths],
  );
  // Archived workspaces can never be active. Falling back to the full list
  // only guards a transient synced state where everything is archived.
  const selectableWorkspaceProjects = useMemo(() => {
    const active = workspaceProjects.filter(
      (project) => !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(project.path)),
    );
    return active.length > 0 ? active : workspaceProjects;
  }, [archivedWorkspaceProjectPathKeys, workspaceProjects]);
  const activeWorkspaceProject = useMemo(
    () =>
      searchCwd === ""
        ? undefined
        : findWorkspaceProject(selectableWorkspaceProjects, activeWorkspaceProjectId),
    [activeWorkspaceProjectId, selectableWorkspaceProjects, searchCwd],
  );
  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId, setActiveWorkspaceProjectId]);
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";
  const sidebarScope = useMemo<SidebarScope>(
    () =>
      searchCwd !== undefined
        ? searchCwd
          ? { kind: "workdir", cwd: searchCwd }
          : { kind: "unscoped" }
        : isAgentMode
          ? activeWorkspaceProjectPath
            ? { kind: "workdir", cwd: activeWorkspaceProjectPath }
            : { kind: "none" }
          : { kind: "unscoped" },
    [activeWorkspaceProjectPath, isAgentMode, searchCwd],
  );
  useEffect(() => {
    sidebarStore.setScope(sidebarScope);
  }, [sidebarScope, sidebarStore]);
  const historyScopeKey = sidebarScopeKey(sidebarScope);
  const [workspaceCreateModalOpen, setWorkspaceCreateModalOpen] = useState(false);
  const [workspaceRemotePickerOpen, setWorkspaceRemotePickerOpen] = useState(false);

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) {
          return prev;
        }
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              missingWorkspaceProjectPaths,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject) => {
      // 远程工作空间的可用性取决于隧道是否在线，跟本地目录存在性无关。
      // 在这里做本地探测只会把一个健康的远程项目误标成 missing，
      // 而隧道的在线状态本来就允许随时断开/重连，不适合固化成持久标记。
      if (isRemoteWorkspaceProject(project)) return true;
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      try {
        await invokeFs("fs_list", {
          workdir: path,
          path: null,
          depth: 1,
          offset: 0,
          max_results: 1,
        });
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [setWorkspaceProjectDirectoryMissing],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Action refs deliberately provide the latest conversation-transition handlers without changing this callback identity.
  const activateWorkspaceProject = useCallback(
    (
      project: WorkspaceProject,
      options?: { startConversation?: boolean; preserveMissing?: boolean },
    ) => {
      setSearchNavigation(null);
      const pathKey = project.path.trim();
      if (!pathKey) return null;
      const normalizedPathKey = workspaceProjectPathKey(pathKey);
      const matchedProject = workspaceProjects.find(
        (item) =>
          workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
      );
      const targetProject = matchedProject
        ? {
            ...matchedProject,
            ...(project.worktree ? { worktree: project.worktree } : {}),
          }
        : project;
      // 目标工作区已完全激活时提前返回，避免流式进行中触发无谓的 settings 写入与重渲染
      if (
        !options?.startConversation &&
        targetProject.id === activeWorkspaceProjectId &&
        settings.system.activeWorkspaceProjectId === targetProject.id &&
        settings.system.workspaceProjects.some((item) => item.id === targetProject.id) &&
        !settings.system.hiddenWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        ) &&
        !settings.system.missingWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        ) &&
        !settings.system.archivedWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === normalizedPathKey,
        )
      ) {
        return null;
      }
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ? { ...targetProject, id: existing.id } : targetProject;
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    name: item.id === DEFAULT_WORKSPACE_PROJECT_ID ? item.name : nextProject.name,
                    path: nextProject.path,
                    kind:
                      item.id === DEFAULT_WORKSPACE_PROJECT_ID
                        ? "managed"
                        : nextProject.kind === "history"
                          ? item.kind
                          : nextProject.kind,
                    worktree: nextProject.worktree ?? item.worktree,
                    updatedAt: item.updatedAt,
                    lastConversationAt:
                      Math.max(item.lastConversationAt ?? 0, nextProject.lastConversationAt ?? 0) ||
                      undefined,
                  }
                : item,
            )
          : [...prev.system.workspaceProjects, nextProject];
        const nextSystem = resolveWorkspaceProjects(
          {
            ...prev.system,
            workspaceProjects,
            activeWorkspaceProjectId: existing?.id ?? nextProject.id,
            hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
            missingWorkspaceProjectPaths: options?.preserveMissing
              ? prev.system.missingWorkspaceProjectPaths
              : prev.system.missingWorkspaceProjectPaths.filter(
                  (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
                ),
            // Activating a workspace always brings it back from the archive.
            archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
            ),
          },
          getDefaultWorkspaceProjectPath(prev.system),
        );
        return {
          ...prev,
          system: nextSystem,
        };
      });
      if (options?.startConversation) {
        prepareComposerForConversationChangeActionRef.current();
        return startNewConversationActionRef.current({
          // 远程项目的 `path` 是 `ssh://…` 身份串，不是本地路径：下游 `normalizeWorkdir`
          // 会把它清成空串，于是会话的 workdir 变成「没给」而不是「明确没有本地根」，
          // 而 `getDefaultNewConversationWorkdir` 此刻读到的还是**上一个**活动项目
          // （React state 尚未提交），新对话就会挂到之前打开的本地文件夹上。
          // 所以这里显式传空串：远程会话的 workdir 为空是预期状态，agent 走 SSHManager
          // 在远端干活。
          workdir: isRemoteWorkspacePath(targetProject.path) ? "" : targetProject.path,
        });
      }
      return null;
    },
    [setSettings, workspaceProjects, activeWorkspaceProjectId, settings.system],
  );

  // Reading persisted history does not require the original directory to exist.
  const activateSearchConversationWorkspace = useCallback(
    (cwd?: string) => {
      const path = cwd?.trim() ?? "";
      if (
        path &&
        workspaceProjectPathKey(path) !== workspaceProjectPathKey(activeWorkspaceProjectPath)
      ) {
        const project =
          workspaceProjects.find(
            (item) => workspaceProjectPathKey(item.path) === workspaceProjectPathKey(path),
          ) ?? createWorkspaceProjectFromPath(path, "history");
        activateWorkspaceProject(project, { preserveMissing: true });
      }
      setSearchNavigation({ mode: isAgentMode, cwd: path });
      sidebarStore.setScope(path ? { kind: "workdir", cwd: path } : { kind: "unscoped" });
    },
    [
      activeWorkspaceProjectPath,
      workspaceProjects,
      activateWorkspaceProject,
      isAgentMode,
      sidebarStore,
    ],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      // 远程工作空间同样能开新会话：agent 走 SSHManager 在远端干活，workdir 为空是
      // 预期状态。别再按「身份串不是本地路径」把它拦掉。
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return null;
      }
      setActiveView("chat");
      return activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setActiveView],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "tunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  const ensureSshTunnelToolTab = useCallback(
    (projectPathKey?: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(activeWorkspaceProjectPath);
      if (!targetProjectPathKey) return;
      setSettings((prev) => openRightDockSingletonTab(prev, targetProjectPathKey, "sshTunnel"));
    },
    [activeWorkspaceProjectPath, setSettings],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      // 本地文件树读不了远程目录；把用户送到 SSH 隧道面板（SFTP 的实际入口），
      // 并且明说原因，避免「点了没反应」或打开一棵空树。
      if (isRemoteWorkspaceProject(project)) {
        setErrorMessage(t("chat.workspaceRemoteFileTreeUnsupported"));
        setActiveView("chat");
        setRightDockOpen(true);
        activateWorkspaceProject(project);
        ensureSshTunnelToolTab(workspaceProjectPathKey(project.path));
        return;
      }
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) {
        return;
      }

      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [
      activateWorkspaceProject,
      checkWorkspaceProjectDirectory,
      ensureSshTunnelToolTab,
      setActiveView,
      setErrorMessage,
      setRightDockOpen,
      setSettings,
      t,
    ],
  );

  const handleBrowseWorkspaceProjectInSystemFileManager = useCallback(
    async (project: WorkspaceProject) => {
      if (isRemoteWorkspaceProject(project)) {
        setErrorMessage(t("chat.workspaceRemoteRevealUnsupported"));
        return;
      }
      if (!(await checkWorkspaceProjectDirectory(project))) {
        return;
      }

      try {
        await revealItemInDir(project.path.trim());
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.workspaceOpenSystemFileManagerFailed")));
      }
    },
    [checkWorkspaceProjectDirectory, setErrorMessage, t],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setWorkspaceCreateModalOpen(true);
  }, []);

  const handleOpenRemoteWorkspaceFolder = useCallback(() => {
    setWorkspaceRemotePickerOpen(true);
  }, []);

  const handleSelectRemoteWorkspaceFolder = useCallback(
    async (selection: RemoteWorkspaceSelection) => {
      // 选择器里确认过会话可用，但从确认到落盘之间用户可能已经把隧道关掉；
      // 这里再验一次，避免存下一个指向死连接的远程工作空间。
      const sessions = await tauriTerminalClient.list();
      const session = sessions.find((item) => item.id === selection.sessionId);
      if (!session || !isRemoteWorkspaceSessionUsable(session)) {
        throw new Error("SSH session is not connected");
      }
      const project = createRemoteWorkspaceProject({
        hostId: selection.hostId,
        hostName: selection.hostName,
        rootPath: selection.rootPath,
      });
      activateWorkspaceProject(project);
      // 这个远程工作空间是从哪条隧道选出来的，就在【SSH 隧道】的【项目 SSH】里
      // 立刻可见。不写这一步的话，用户之后得自己去面板里再勾一次，而那时他多半
      // 已经记不得当初选的是哪条隧道了。
      setSettings((prev) => updateSshProjectHostIds(prev, project.path, [selection.hostId]));
    },
    [activateWorkspaceProject, setSettings],
  );

  const handleOpenWorkspaceFolder = useCallback(async () => {
    try {
      const picked = await invoke<string | null>("system_pick_folder", {
        // 初始目录必须是本地路径；远程工作空间的身份串不是，回退到全局 workdir。
        initial_workdir:
          (isRemoteWorkspacePath(activeWorkspaceProjectPath) ? "" : activeWorkspaceProjectPath) ||
          workdir,
      });
      const path = picked?.trim();
      if (!path) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
    } catch (error) {
      setErrorMessage(asErrorMessage(error, "选择项目目录失败"));
    }
  }, [activateWorkspaceProject, activeWorkspaceProjectPath, workdir, setErrorMessage]);

  const handleDropWorkspaceFolders = useCallback(
    async (paths: string[]) => {
      try {
        const folders = await invoke<string[]>("system_resolve_dropped_workspace_folders", {
          paths,
        });
        for (const path of folders) {
          activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
        }
      } catch (error) {
        setErrorMessage(asErrorMessage(error, "添加拖入的工作空间失败"));
      }
    },
    [activateWorkspaceProject, setErrorMessage],
  );

  const handleCloneWorkspaceProject = useCallback(
    async (remoteUrl: string, parent: string, name: string, branch: string) => {
      await startWorkspaceCloneTask({
        remoteUrl,
        parent,
        name,
        branch,
      });
    },
    [],
  );

  const handleOpenClonedWorkspace = useCallback(
    (path: string) => activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed")),
    [activateWorkspaceProject],
  );

  // 后端返回主工作树作为稳定仓库身份；即使从 linked worktree 再创建，
  // 新项目也会归到同一个源仓库分组并持久化真实关联分支。
  const handleOpenWorktree = useCallback(
    (worktree: { path: string; repositoryPath: string; branch: string }) => {
      const path = worktree.path.trim();
      const repositoryPath = worktree.repositoryPath.trim();
      const worktreeKey = workspaceProjectPathKey(path);
      if (!path || !repositoryPath || !worktreeKey || !activeWorkspaceProject) return;
      const branch = worktree.branch.trim();
      const nextProject: WorkspaceProject = {
        ...createWorkspaceProjectFromPath(path, "managed"),
        worktree: {
          repositoryPath,
          ...(branch ? { branch } : {}),
        },
      };
      activateWorkspaceProject(nextProject);
      setSettings((prev) => {
        const sourceProject = prev.system.workspaceProjects.find(
          (item) => workspaceProjectPathKey(item.path) === workspaceProjectPathKey(repositoryPath),
        );
        const ensured = ensureWorktreeProjectGroup(prev.system.workspaceProjectGroups, {
          name: sourceProject?.name || fallbackWorkspaceProjectName(repositoryPath),
          sourceProjectPath: repositoryPath,
        });
        let workspaceProjectGroups = assignWorkspaceProjectToGroup(
          ensured.groups,
          ensured.groupId,
          repositoryPath,
        );
        workspaceProjectGroups = assignWorkspaceProjectToGroup(
          workspaceProjectGroups,
          ensured.groupId,
          activeWorkspaceProject.path,
        );
        workspaceProjectGroups = assignWorkspaceProjectToGroup(
          workspaceProjectGroups,
          ensured.groupId,
          path,
        );
        return {
          ...prev,
          system: {
            ...prev.system,
            workspaceProjectGroups,
          },
        };
      });
    },
    [activateWorkspaceProject, activeWorkspaceProject, setSettings],
  );

  const handleLoadWorkspaceRemoteBranches = useCallback(
    (remoteUrl: string) =>
      invoke<{ defaultBranch: string; branches: string[] }>("git_list_remote_branches", {
        remote_url: remoteUrl,
      }),
    [],
  );

  const updateWorkspaceProjectGroups = useCallback(
    (updater: (groups: WorkspaceProjectGroup[]) => WorkspaceProjectGroup[]) => {
      setSettings((prev) => {
        const next = updater(prev.system.workspaceProjectGroups);
        if (next === prev.system.workspaceProjectGroups) return prev;
        return { ...prev, system: { ...prev.system, workspaceProjectGroups: next } };
      });
    },
    [setSettings],
  );

  const handleCreateWorkspaceGroup = useCallback(
    (nameInput: string) => {
      const name = nameInput.trim();
      if (!name) return;
      const now = Date.now();
      updateWorkspaceProjectGroups((groups) => [
        ...groups,
        {
          id: createUuid(),
          name,
          projectPaths: [],
          createdAt: now,
          updatedAt: now,
        },
      ]);
    },
    [updateWorkspaceProjectGroups],
  );

  const handleRenameWorkspaceGroup = useCallback(
    (groupId: string, nameInput: string) => {
      const name = nameInput.trim();
      if (!name) return;
      updateWorkspaceProjectGroups((groups) =>
        groups.map((group) =>
          group.id === groupId ? { ...group, name, updatedAt: Date.now() } : group,
        ),
      );
    },
    [updateWorkspaceProjectGroups],
  );

  const handleDeleteWorkspaceGroup = useCallback(
    (groupId: string) => {
      // 删除分组只解除成员归属，项目保留在列表中。
      updateWorkspaceProjectGroups((groups) => groups.filter((group) => group.id !== groupId));
    },
    [updateWorkspaceProjectGroups],
  );

  const handleMoveWorkspaceProjectToGroup = useCallback(
    (projectPath: string, groupId: string | null) => {
      const pathKey = workspaceProjectPathKey(projectPath);
      if (!pathKey) return;
      updateWorkspaceProjectGroups((groups) => {
        if (groupId === null) {
          // 移出所有分组
          return groups.map((group) =>
            group.projectPaths.some((path) => workspaceProjectPathKey(path) === pathKey)
              ? {
                  ...group,
                  updatedAt: Date.now(),
                  projectPaths: group.projectPaths.filter(
                    (path) => workspaceProjectPathKey(path) !== pathKey,
                  ),
                }
              : group,
          );
        }
        return assignWorkspaceProjectToGroup(groups, groupId, projectPath);
      });
    },
    [updateWorkspaceProjectGroups],
  );

  const handleToggleWorkspaceGroupCollapsed = useCallback(
    (groupId: string) => {
      updateWorkspaceProjectGroups((groups) =>
        groups.map((group) =>
          group.id === groupId
            ? { ...group, collapsed: !group.collapsed, updatedAt: Date.now() }
            : group,
        ),
      );
    },
    [updateWorkspaceProjectGroups],
  );
  const commitWorkspaceProjectRename = useCallback(
    (project: WorkspaceProject, nextNameInput: string) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const nextName = nextNameInput.trim();
      if (!nextName || nextName === project.name) return;
      setSettings((prev) => {
        const pathKey = workspaceProjectPathKey(project.path);
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        const updatedProject: WorkspaceProject = {
          ...(existing ?? project),
          id: existing?.id ?? project.id,
          name: nextName,
          kind: (existing ?? project).kind === "history" ? "folder" : (existing ?? project).kind,
          updatedAt: Date.now(),
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleSetWorkspaceProjectPinned = useCallback(
    (project: WorkspaceProject, isPinned: boolean) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;

      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) => item.id === project.id || workspaceProjectPathKey(item.path) === pathKey,
        );
        if (!existing && !isPinned) {
          return prev;
        }

        const now = Date.now();
        const source = existing ?? project;
        const updatedProject: WorkspaceProject = {
          ...source,
          id: existing?.id ?? source.id,
          kind: source.id === DEFAULT_WORKSPACE_PROJECT_ID ? "managed" : source.kind,
          updatedAt: now,
          isPinned,
          pinnedAt: isPinned ? now : null,
        };
        const workspaceProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];

        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects,
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const handleSidebarProjectsCollapsedChange = useCallback(
    (projectsCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            projectsCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: {
            ...prev.customSettings.chatSidebar,
            recentCollapsed,
          },
        }),
      );
    },
    [setSettings],
  );

  return {
    workspaceProjects,
    activeWorkspaceProjectId,
    setActiveWorkspaceProjectId,
    missingWorkspaceProjectPathKeys,
    archivedWorkspaceProjectPathKeys,
    selectableWorkspaceProjects,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    sidebarScope,
    historyScopeKey,
    checkWorkspaceProjectDirectory,
    activateWorkspaceProject,
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    searchConversationWorkdir: searchCwd,
    handleSelectWorkspaceProject,
    handleNewConversationForProject,
    handleBrowseWorkspaceProjectInFileTree,
    ensureTunnelToolTab,
    ensureSshTunnelToolTab,
    handleBrowseWorkspaceProjectInSystemFileManager,
    handleOpenCreateWorkspaceProject,
    workspaceCreateModalOpen,
    setWorkspaceCreateModalOpen,
    handleOpenWorkspaceFolder,
    workspaceRemotePickerOpen,
    setWorkspaceRemotePickerOpen,
    handleOpenRemoteWorkspaceFolder,
    handleSelectRemoteWorkspaceFolder,
    handleDropWorkspaceFolders,
    handleCloneWorkspaceProject,
    handleOpenClonedWorkspace,
    handleOpenWorktree,
    workspaceProjectGroups: settings.system.workspaceProjectGroups,
    handleCreateWorkspaceGroup,
    handleRenameWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleMoveWorkspaceProjectToGroup,
    handleToggleWorkspaceGroupCollapsed,
    handleLoadWorkspaceRemoteBranches,
    commitWorkspaceProjectRename,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
  };
}
