import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import type { WorkspaceCloneTask } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import type {
  RemoteWorkspaceBrowseClient,
  RemoteWorkspaceSelection,
} from "@liveagent/ui/components/chat/WorkspaceRemoteFolderPicker";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarWorkdirSummary } from "@liveagent/ui/lib/sidebar/types";
import {
  assignWorkspaceProjectToGroup,
  createWorkspaceProjectFromPath,
  ensureWorktreeProjectGroup,
  fallbackWorkspaceProjectName,
  findWorkspaceProject,
  getDefaultWorkspaceProjectPath,
  mergeWorkspaceProjectsWithHistory,
} from "@liveagent/ui/lib/workspaceProjects";
import type { WorkspaceProjectGroup } from "@liveagent/ui/lib/workspaceProjectTypes";
import {
  createRemoteWorkspaceProject,
  isRemoteWorkspacePath,
  isRemoteWorkspaceProject,
  isRemoteWorkspaceSessionUsable,
} from "@liveagent/ui/lib/workspaceRemoteProject";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  openRightDockSingletonTab,
  resolveWorkspaceProjects,
  updateCustomSettings,
  updateSshProjectHostIds,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";

import { isMobileSidebarLayout } from "../historyUtils";

type StartNewConversation = (options?: {
  workdir?: string;
  preserveCurrentComposerDraft?: boolean;
}) => string;

type UseGatewayWorkspaceProjectsOptions = {
  api: GatewayWebSocketClientLike | null;
  displayedConversationWorkdirRef: MutableRefObject<string>;
  /** 远程工作空间相关的失败提示；桌面端用 setErrorMessage，WebUI 用通知栈。 */
  notifyError: (key: string) => void;
  remoteWorkspaceBrowseClient: RemoteWorkspaceBrowseClient | null;
  setActiveView: Dispatch<SetStateAction<ApplicationViewId>>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  settings: AppSettings;
  sidebarStore: SidebarStore;
  sidebarWorkdirs: readonly SidebarWorkdirSummary[];
  startNewConversationRef: MutableRefObject<StartNewConversation>;
};

export function useGatewayWorkspaceProjects({
  api,
  displayedConversationWorkdirRef,
  notifyError,
  remoteWorkspaceBrowseClient,
  setActiveView,
  setRightDockOpen,
  setSettings,
  setSidebarOpen,
  settings,
  sidebarStore,
  sidebarWorkdirs,
  startNewConversationRef,
}: UseGatewayWorkspaceProjectsOptions) {
  const [workspaceCloneTasks, setWorkspaceCloneTasks] = useState<WorkspaceCloneTask[]>([]);
  const dismissedWorkspaceCloneTaskIds = useRef(new Set<string>());
  const [searchNavigation, setSearchNavigation] = useState<{
    mode: typeof settings.system.executionMode;
    cwd: string;
  } | null>(null);
  const clearSearchConversationWorkspace = useCallback(() => setSearchNavigation(null), []);
  const searchCwd =
    searchNavigation?.mode === settings.system.executionMode ? searchNavigation.cwd : undefined;
  const [activeWorkspaceProjectId, setActiveWorkspaceProjectIdState] = useState<string>(
    () => settings.system.activeWorkspaceProjectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID,
  );
  const setActiveWorkspaceProjectId = useCallback<Dispatch<SetStateAction<string>>>((id) => {
    setSearchNavigation(null);
    setActiveWorkspaceProjectIdState(id);
  }, []);
  useEffect(() => {
    if (searchNavigation && searchNavigation.mode !== settings.system.executionMode)
      setSearchNavigation(null);
  }, [searchNavigation, settings.system.executionMode]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [workspaceCreateModalOpen, setWorkspaceCreateModalOpen] = useState(false);
  const [workspaceRemotePickerOpen, setWorkspaceRemotePickerOpen] = useState(false);

  const missingWorkspaceProjectPathKeys = useMemo(
    () =>
      new Set(
        settings.system.missingWorkspaceProjectPaths
          // 「目录缺失」是本地语义：远程项目的可用性取决于隧道在不在。守卫之前
          // 写下的存量标记必须在这里失效，否则侧栏行会把「新建对话」换成「删除」，
          // 用户在远程文件夹里再也开不了新会话（与桌面端同一处修复）。
          .filter((path) => !isRemoteWorkspacePath(path))
          .map(workspaceProjectPathKey),
      ),
    [settings.system.missingWorkspaceProjectPaths],
  );
  const workspaceProjects = useMemo(
    () => mergeWorkspaceProjectsWithHistory(settings.system, sidebarWorkdirs),
    [settings.system, sidebarWorkdirs],
  );
  const archivedWorkspaceProjectPathKeys = useMemo(
    () => new Set(settings.system.archivedWorkspaceProjectPaths.map(workspaceProjectPathKey)),
    [settings.system.archivedWorkspaceProjectPaths],
  );
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
  const activeWorkspaceProjectPath = activeWorkspaceProject?.path.trim() ?? "";

  useEffect(() => {
    if (activeWorkspaceProject?.id && activeWorkspaceProject.id !== activeWorkspaceProjectId) {
      setActiveWorkspaceProjectId(activeWorkspaceProject.id);
    }
  }, [activeWorkspaceProject?.id, activeWorkspaceProjectId, setActiveWorkspaceProjectId]);

  useEffect(() => {
    sidebarStore.setScope(
      searchCwd !== undefined
        ? searchCwd
          ? { kind: "workdir", cwd: searchCwd }
          : { kind: "unscoped" }
        : settings.system.executionMode !== "text"
          ? activeWorkspaceProjectPath
            ? { kind: "workdir", cwd: activeWorkspaceProjectPath }
            : { kind: "none" }
          : { kind: "unscoped" },
    );
  }, [activeWorkspaceProjectPath, settings.system.executionMode, sidebarStore, searchCwd]);

  const setWorkspaceProjectDirectoryMissing = useCallback(
    (project: WorkspaceProject, missing: boolean) => {
      const key = workspaceProjectPathKey(project.path);
      const path = project.path.trim();
      if (!key || !path) return;
      setSettings((prev) => {
        const hasMissingPath = prev.system.missingWorkspaceProjectPaths.some(
          (item) => workspaceProjectPathKey(item) === key,
        );
        if (hasMissingPath === missing) return prev;
        const missingWorkspaceProjectPaths = missing
          ? [...prev.system.missingWorkspaceProjectPaths, path]
          : prev.system.missingWorkspaceProjectPaths.filter(
              (item) => workspaceProjectPathKey(item) !== key,
            );
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            { ...prev.system, missingWorkspaceProjectPaths },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
    },
    [setSettings],
  );

  const checkWorkspaceProjectDirectory = useCallback(
    async (project: WorkspaceProject, currentApi = api) => {
      // 远程工作空间的可用性取决于隧道是否在线，本地目录探测对它没有意义；
      // 在这里探测只会把一个健康的远程项目误标成 missing。
      if (isRemoteWorkspaceProject(project)) return true;
      const path = project.path.trim();
      if (!path) {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
      if (!currentApi) {
        return !missingWorkspaceProjectPathKeys.has(workspaceProjectPathKey(path));
      }
      try {
        await currentApi.listDirs(path, 1);
        setWorkspaceProjectDirectoryMissing(project, false);
        return true;
      } catch {
        setWorkspaceProjectDirectoryMissing(project, true);
        return false;
      }
    },
    [api, missingWorkspaceProjectPathKeys, setWorkspaceProjectDirectoryMissing],
  );

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
        ? { ...matchedProject, ...(project.worktree ? { worktree: project.worktree } : {}) }
        : project;
      setActiveWorkspaceProjectId(targetProject.id);
      setSettings((prev) => {
        const existing = prev.system.workspaceProjects.find(
          (item) =>
            workspaceProjectPathKey(item.path) === normalizedPathKey || item.id === project.id,
        );
        const nextProject = existing ? { ...targetProject, id: existing.id } : targetProject;
        const nextProjects = existing
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
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects: nextProjects,
              activeWorkspaceProjectId: existing?.id ?? nextProject.id,
              hiddenWorkspaceProjectPaths: prev.system.hiddenWorkspaceProjectPaths.filter(
                (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
              ),
              missingWorkspaceProjectPaths: options?.preserveMissing
                ? prev.system.missingWorkspaceProjectPaths
                : prev.system.missingWorkspaceProjectPaths.filter(
                    (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
                  ),
              archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
                (path) => workspaceProjectPathKey(path) !== normalizedPathKey,
              ),
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
      });
      if (options?.startConversation) {
        setActiveView("chat");
        return startNewConversationRef.current({
          // 与桌面端同源：远程项目的 `path` 是 `ssh://…` 身份串，不是本地路径，
          // gateway 的文件/命令子系统会拒收。显式留空（而不是 undefined），新会话才
          // 不会回退到上一个活动项目的本地目录 —— 那正是「在远程文件夹里开新对话，
          // 却跳回之前打开的本地文件夹」。
          workdir: isRemoteWorkspacePath(targetProject.path) ? "" : targetProject.path,
          preserveCurrentComposerDraft: true,
        });
      }
      return null;
    },
    [
      setActiveView,
      setSettings,
      startNewConversationRef,
      workspaceProjects,
      setActiveWorkspaceProjectId,
    ],
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
      setSearchNavigation({ mode: settings.system.executionMode, cwd: path });
      sidebarStore.setScope(path ? { kind: "workdir", cwd: path } : { kind: "unscoped" });
    },
    [
      activeWorkspaceProjectPath,
      workspaceProjects,
      activateWorkspaceProject,
      settings.system.executionMode,
      sidebarStore,
    ],
  );

  const handleSelectWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (await checkWorkspaceProjectDirectory(project)) activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory],
  );

  const handleNewConversationForProject = useCallback(
    async (project: WorkspaceProject) => {
      // 与桌面端一致：远程工作空间同样能开新会话，agent 走 SSHManager 在远端干活。
      if (!(await checkWorkspaceProjectDirectory(project))) return null;
      if (isMobileSidebarLayout()) setSidebarOpen(false);
      return activateWorkspaceProject(project, { startConversation: true });
    },
    [activateWorkspaceProject, checkWorkspaceProjectDirectory, setSidebarOpen],
  );

  const handleBrowseWorkspaceProjectInFileTree = useCallback(
    async (project: WorkspaceProject) => {
      // 本地文件树读不了远程目录；明说原因而不是打开一棵空树。
      if (isRemoteWorkspaceProject(project)) {
        notifyError("chat.workspaceRemoteFileTreeUnsupported");
        return;
      }
      if (!(await checkWorkspaceProjectDirectory(project))) return;
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;
      if (isMobileSidebarLayout()) setSidebarOpen(false);
      setActiveView("chat");
      setRightDockOpen(true);
      activateWorkspaceProject(project);
      setSettings((prev) => openRightDockSingletonTab(prev, pathKey, "fileTree"));
    },
    [
      activateWorkspaceProject,
      checkWorkspaceProjectDirectory,
      notifyError,
      setActiveView,
      setRightDockOpen,
      setSettings,
      setSidebarOpen,
    ],
  );

  const handleOpenCreateWorkspaceProject = useCallback(() => {
    setWorkspaceCreateModalOpen(true);
  }, []);
  const handleOpenWorkspaceFolder = useCallback(() => {
    setWorkspaceCreateModalOpen(false);
    setProjectPickerOpen(true);
  }, []);

  const handleOpenRemoteWorkspaceFolder = useCallback(() => {
    setWorkspaceCreateModalOpen(false);
    setWorkspaceRemotePickerOpen(true);
  }, []);

  const handleSelectRemoteWorkspaceFolder = useCallback(
    async (selection: RemoteWorkspaceSelection) => {
      if (!remoteWorkspaceBrowseClient) throw new Error("SSH session is not connected");
      // 选择器里确认过会话可用，但确认到落盘之间隧道可能被关掉；
      // 这里再验一次，避免存下指向死连接的远程工作空间。
      const sessions = await remoteWorkspaceBrowseClient.listSessions();
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
      // 立刻可见。不写这一步的话，用户之后得自己去面板里再勾一次。
      setSettings((prev) => updateSshProjectHostIds(prev, project.path, [selection.hostId]));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, remoteWorkspaceBrowseClient, setSettings, sidebarStore],
  );

  const handleCloneWorkspaceProject = useCallback(
    async (remoteUrl: string, parent: string, name: string, branch: string) => {
      if (!api) throw new Error("网关未连接。");
      const task = await api.gitRequest<WorkspaceCloneTask>("clone_start", parent, {
        name,
        remoteUrl,
        branch: branch || undefined,
      });
      dismissedWorkspaceCloneTaskIds.current.delete(task.id);
      setWorkspaceCloneTasks((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)]);
    },
    [api],
  );

  const refreshWorkspaceCloneTasks = useCallback(async () => {
    if (!api) return;
    const tasks = await api.gitRequest<WorkspaceCloneTask[]>("clone_tasks", "");
    setWorkspaceCloneTasks(
      tasks.filter((task) => !dismissedWorkspaceCloneTaskIds.current.has(task.id)),
    );
  }, [api]);

  useEffect(() => {
    void refreshWorkspaceCloneTasks().catch(() => undefined);
  }, [refreshWorkspaceCloneTasks]);

  const hasActiveWorkspaceCloneTask = workspaceCloneTasks.some(
    (task) => task.status === "running" || task.status === "cancelling",
  );
  useEffect(() => {
    if (!hasActiveWorkspaceCloneTask) return;
    const timer = window.setInterval(() => {
      void refreshWorkspaceCloneTasks().catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [hasActiveWorkspaceCloneTask, refreshWorkspaceCloneTasks]);

  const handleCancelWorkspaceCloneTask = useCallback(
    (taskId: string) => {
      if (!api) return;
      void api
        .gitRequest<WorkspaceCloneTask>("clone_cancel", "", { taskId })
        .then((task) =>
          setWorkspaceCloneTasks((tasks) =>
            tasks.map((item) => (item.id === task.id ? task : item)),
          ),
        )
        .catch(() => undefined);
    },
    [api],
  );

  const handleDismissWorkspaceCloneTask = useCallback(
    (taskId: string) => {
      dismissedWorkspaceCloneTaskIds.current.add(taskId);
      setWorkspaceCloneTasks((tasks) => tasks.filter((task) => task.id !== taskId));
      if (!api) return;
      void api
        .gitRequest<WorkspaceCloneTask[]>("clone_dismiss", "", { taskId })
        .then((tasks) => {
          dismissedWorkspaceCloneTaskIds.current.delete(taskId);
          setWorkspaceCloneTasks(
            tasks.filter((task) => !dismissedWorkspaceCloneTaskIds.current.has(task.id)),
          );
        })
        .catch(() => undefined);
    },
    [api],
  );

  const handleOpenClonedWorkspace = useCallback(
    (path: string) => {
      activateWorkspaceProject(createWorkspaceProjectFromPath(path, "managed"));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, sidebarStore],
  );
  const handleLoadWorkspaceRemoteBranches = useCallback(
    (remoteUrl: string) =>
      api?.gitRequest<{ defaultBranch: string; branches: string[] }>("list_remote_branches", "", {
        remoteUrl,
      }) ?? Promise.reject(new Error("网关未连接。")),
    [api],
  );
  const handleWorkdirPickerSelect = useCallback(
    (path: string) => {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      activateWorkspaceProject(createWorkspaceProjectFromPath(normalizedPath, "managed"));
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, sidebarStore],
  );

  const handleOpenWorktree = useCallback(
    (worktree: { path: string; repositoryPath: string; branch: string }) => {
      const path = worktree.path.trim();
      const repositoryPath = worktree.repositoryPath.trim();
      const worktreeKey = workspaceProjectPathKey(path);
      const currentProjectPath = displayedConversationWorkdirRef.current.trim();
      if (!path || !repositoryPath || !worktreeKey) return;
      const branch = worktree.branch.trim();
      const nextProject: WorkspaceProject = {
        ...createWorkspaceProjectFromPath(path, "managed"),
        worktree: { repositoryPath, ...(branch ? { branch } : {}) },
      };
      activateWorkspaceProject(nextProject);
      setSettings((prev) => {
        const sourceProject = prev.system.workspaceProjects.find(
          (project) =>
            workspaceProjectPathKey(project.path) === workspaceProjectPathKey(repositoryPath),
        );
        const ensured = ensureWorktreeProjectGroup(prev.system.workspaceProjectGroups, {
          name: sourceProject?.name || fallbackWorkspaceProjectName(repositoryPath),
          sourceProjectPath: repositoryPath,
        });
        let groups = assignWorkspaceProjectToGroup(ensured.groups, ensured.groupId, repositoryPath);
        if (currentProjectPath) {
          groups = assignWorkspaceProjectToGroup(groups, ensured.groupId, currentProjectPath);
        }
        groups = assignWorkspaceProjectToGroup(groups, ensured.groupId, path);
        return { ...prev, system: { ...prev.system, workspaceProjectGroups: groups } };
      });
      void sidebarStore.refreshWorkdirs("new-workdir");
    },
    [activateWorkspaceProject, displayedConversationWorkdirRef, setSettings, sidebarStore],
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
        { id: createUuid(), name, projectPaths: [], createdAt: now, updatedAt: now },
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
          return groups.map((group) => {
            const projectPaths = group.projectPaths.filter(
              (path) => workspaceProjectPathKey(path) !== pathKey,
            );
            return projectPaths.length === group.projectPaths.length
              ? group
              : { ...group, projectPaths, updatedAt: Date.now() };
          });
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
        const nextProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            { ...prev.system, workspaceProjects: nextProjects },
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
        if (!existing && !isPinned) return prev;
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
        const nextProjects = existing
          ? prev.system.workspaceProjects.map((item) =>
              item.id === existing.id || workspaceProjectPathKey(item.path) === pathKey
                ? updatedProject
                : item,
            )
          : [...prev.system.workspaceProjects, updatedProject];
        return {
          ...prev,
          system: resolveWorkspaceProjects(
            { ...prev.system, workspaceProjects: nextProjects },
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
          chatSidebar: { ...prev.customSettings.chatSidebar, projectsCollapsed },
        }),
      );
    },
    [setSettings],
  );
  const handleSidebarRecentCollapsedChange = useCallback(
    (recentCollapsed: boolean) => {
      setSettings((prev) =>
        updateCustomSettings(prev, {
          chatSidebar: { ...prev.customSettings.chatSidebar, recentCollapsed },
        }),
      );
    },
    [setSettings],
  );

  return {
    activateWorkspaceProject,
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    searchConversationWorkdir: searchCwd,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    archivedWorkspaceProjectPathKeys,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleCloneWorkspaceProject,
    handleCommitWorkspaceProjectRename: commitWorkspaceProjectRename,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDismissWorkspaceCloneTask,
    handleLoadWorkspaceRemoteBranches,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenWorkspaceFolder,
    handleOpenRemoteWorkspaceFolder,
    handleSelectRemoteWorkspaceFolder,
    workspaceRemotePickerOpen,
    setWorkspaceRemotePickerOpen,
    handleOpenWorktree,
    handleRenameWorkspaceGroup,
    handleSelectWorkspaceProject,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleToggleWorkspaceGroupCollapsed,
    handleWorkdirPickerSelect,
    missingWorkspaceProjectPathKeys,
    projectPickerOpen,
    setActiveWorkspaceProjectId,
    setProjectPickerOpen,
    setWorkspaceCreateModalOpen,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceProjects,
  };
}
