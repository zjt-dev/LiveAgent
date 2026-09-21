import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { createTextComposerDraft } from "@liveagent/ui/lib/chat/composerDraft";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { SidebarShortcutId } from "@liveagent/ui/lib/settings/sidebarShortcuts";
import type { ConversationOpenOptions } from "@liveagent/ui/lib/sidebar/openController";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { isRemoteWorkspacePath } from "@liveagent/ui/lib/workspaceRemoteProject";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { HistoryWindowState } from "@/lib/chat/historyWindow";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { HistoryDetail } from "@/lib/gatewayTypes";
import { normalizeGatewayConversationSummary } from "@/lib/sidebar/webSidebarBackend";
import { clearLiveTrajectory } from "@/lib/trajectory/liveTrajectory";

import { asErrorMessage } from "./chatEventUtils";
import { PROTECTED_DRAFT_CONVERSATION } from "./constants";
import { isMobileSidebarLayout } from "./historyUtils";
import type { SendChatFn } from "./types";

/**
 * 新建会话时下发给 gateway 的 workdir。远程工作空间的身份串（`ssh://<hostId>/<abs>`）
 * 不是本地路径，会被 gateway 的文件/命令子系统拒绝，所以留空而不是原样下发。
 *
 * 抽成一处：这个表达式在新建、删除后重建、草稿删除后重建三条路径上重复出现，
 * 桌面端就是因为只拦了一个入口而漏掉另外两条。
 */
function newConversationWorkdir(isAgentMode: boolean, activeWorkspaceProjectPath: string) {
  if (!isAgentMode) return undefined;
  return (
    (isRemoteWorkspacePath(activeWorkspaceProjectPath) ? "" : activeWorkspaceProjectPath) ||
    undefined
  );
}

type CreateGatewayConversationActionsOptions = {
  activateSearchConversationWorkspace: (cwd?: string) => void;
  clearSearchConversationWorkspace: () => void;
  activeView: ApplicationViewId;
  activeWorkspaceProjectPath: string;
  api: GatewayWebSocketClient | null;
  branchFailureMessage: string;
  branchInFlightRef: MutableRefObject<boolean>;
  cacheVisibleComposerDraft: (conversationId?: string) => void;
  clearCachedComposerDraft: (conversationId?: string) => void;
  composerDraftCacheRef: MutableRefObject<Map<string, MentionComposerDraft>>;
  composerDraftOwnerRef: MutableRefObject<string>;
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  conversationIdRef: MutableRefObject<string>;
  conversationWorkdirsRef: MutableRefObject<Map<string, string>>;
  createLocalDraftConversationId: () => string;
  getDisplayedConversationId: () => string;
  getVisibleComposerConversationId: () => string;
  historyWindowStatesRef: MutableRefObject<Map<string, HistoryWindowState>>;
  invalidateHistoryLoad: () => number;
  isAgentMode: boolean;
  isConversationBusy: (conversationId: string) => boolean;
  isLocalDraftConversationId: (conversationId: string) => boolean;
  markVisibleConversationRevision: () => number;
  openController: {
    cancel: () => void;
    open: (conversationId: string, options?: ConversationOpenOptions) => void;
  };
  pendingDisplayedConversationAutoBottomRef: MutableRefObject<string | null>;
  prepareComposerForConversationChange: () => void;
  protectedConversationRef: MutableRefObject<string>;
  removeSharedHistoryItems: (ids: ReadonlySet<string>) => void;
  restoreCachedComposerDraft: (conversationId: string) => void;
  selectedHistoryIdRef: MutableRefObject<string>;
  sendChatRef: MutableRefObject<SendChatFn | null>;
  setActiveView: Dispatch<SetStateAction<ApplicationViewId>>;
  setBranchPendingMessageId: Dispatch<SetStateAction<string | null>>;
  setChatError: Dispatch<SetStateAction<string | null>>;
  setConversationId: Dispatch<SetStateAction<string>>;
  setPendingUploadsForConversation: (conversationId: string, files: PendingUploadedFile[]) => void;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedHistory: Dispatch<SetStateAction<HistoryDetail | null>>;
  setSelectedHistoryId: Dispatch<SetStateAction<string>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  sidebarStore: SidebarStore;
  submitInFlightRef: MutableRefObject<boolean>;
  transcriptStoreRegistry: TranscriptStoreRegistry;
};

export function createGatewayConversationActions(options: CreateGatewayConversationActionsOptions) {
  const startNewConversation = (startOptions?: {
    workdir?: string;
    preserveCurrentComposerDraft?: boolean;
  }) => {
    const currentConversationId = options.getVisibleComposerConversationId().trim();
    if (currentConversationId) {
      options.transcriptStoreRegistry.peek(currentConversationId)?.foldSettledTurns();
      if (startOptions?.preserveCurrentComposerDraft) {
        options.cacheVisibleComposerDraft(currentConversationId);
      } else {
        options.clearCachedComposerDraft(currentConversationId);
      }
    }
    options.invalidateHistoryLoad();
    options.markVisibleConversationRevision();
    options.openController.cancel();
    const nextConversationId = options.createLocalDraftConversationId();
    options.protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    options.submitInFlightRef.current = false;
    options.composerDraftOwnerRef.current = "";
    options.composerRef.current?.clear();
    const nextWorkdir = startOptions?.workdir?.trim() || "";
    if (!options.isAgentMode || nextWorkdir) options.clearSearchConversationWorkspace();
    if (nextWorkdir) options.conversationWorkdirsRef.current.set(nextConversationId, nextWorkdir);
    options.conversationIdRef.current = nextConversationId;
    options.selectedHistoryIdRef.current = nextConversationId;
    options.setConversationId(nextConversationId);
    options.setSelectedHistoryId(nextConversationId);
    options.setChatError(null);
    options.setSelectedHistory(null);
    options.setPendingUploadsForConversation(nextConversationId, []);
    // 返回新草稿 id，供“无会话时先上传”的兜底路径立即取用（state 尚未
    // 重渲染，调用方拿不到最新的 displayedConversationId）。
    return nextConversationId;
  };

  const handleSidebarNewConversation = () => {
    if (isMobileSidebarLayout()) options.setSidebarOpen(false);
    options.setActiveView("chat");
    const visibleConversationId = options.getVisibleComposerConversationId();
    if (
      options.activeView !== "chat" &&
      (!visibleConversationId || options.isLocalDraftConversationId(visibleConversationId))
    ) {
      return;
    }
    startNewConversation({
      workdir: newConversationWorkdir(options.isAgentMode, options.activeWorkspaceProjectPath),
      preserveCurrentComposerDraft: true,
    });
  };

  const handleSidebarSelectConversation = (id: string, openOptions?: ConversationOpenOptions) => {
    if (isMobileSidebarLayout()) options.setSidebarOpen(false);
    options.setActiveView("chat");
    const targetConversationId = id.trim();
    if (!targetConversationId) return;
    if (openOptions?.source === "search") {
      options.openController.open(targetConversationId, {
        source: "search",
        beforeCommit: (conversation) => {
          options.activateSearchConversationWorkspace(conversation.cwd);
          options.sidebarStore.upsertLocal(conversation, { reveal: true });
          options.prepareComposerForConversationChange();
        },
        afterCommit: () => {
          options.restoreCachedComposerDraft(targetConversationId);
          openOptions.afterCommit?.();
        },
      });
      return;
    }
    const currentConversationId = options.getVisibleComposerConversationId().trim();
    if (currentConversationId !== targetConversationId) {
      options.prepareComposerForConversationChange();
    }
    options.pendingDisplayedConversationAutoBottomRef.current = targetConversationId;
    if (options.isLocalDraftConversationId(targetConversationId)) {
      options.openController.cancel();
      options.invalidateHistoryLoad();
      options.markVisibleConversationRevision();
      if (currentConversationId && currentConversationId !== targetConversationId) {
        options.transcriptStoreRegistry.peek(currentConversationId)?.foldSettledTurns();
      }
      options.protectedConversationRef.current = targetConversationId;
      options.conversationIdRef.current = targetConversationId;
      options.selectedHistoryIdRef.current = targetConversationId;
      options.setConversationId(targetConversationId);
      options.setSelectedHistoryId(targetConversationId);
      options.setChatError(null);
      options.setSelectedHistory(null);
      options.restoreCachedComposerDraft(targetConversationId);
      return;
    }
    options.openController.open(targetConversationId);
    options.restoreCachedComposerDraft(targetConversationId);
  };

  const handleSidebarConversationsRemoved = (ids: readonly string[]) => {
    const displayedId = options.getDisplayedConversationId();
    let displayedRemoved = false;
    const removedIds = new Set<string>();
    for (const id of ids) {
      if (options.isLocalDraftConversationId(id)) continue;
      removedIds.add(id);
      options.transcriptStoreRegistry.remove(id);
      clearLiveTrajectory(id);
      options.historyWindowStatesRef.current.delete(id);
      options.conversationWorkdirsRef.current.delete(id);
      options.composerDraftCacheRef.current.delete(id);
      options.setPendingUploadsForConversation(id, []);
      if (id === displayedId) displayedRemoved = true;
    }
    if (removedIds.size === 0) return;
    options.removeSharedHistoryItems(removedIds);
    if (displayedRemoved) {
      startNewConversation({
        workdir: newConversationWorkdir(options.isAgentMode, options.activeWorkspaceProjectPath),
      });
    }
  };

  const handleSidebarLocalDraftDeleted = (id: string) => {
    options.transcriptStoreRegistry.remove(id);
    clearLiveTrajectory(id);
    options.historyWindowStatesRef.current.delete(id);
    options.conversationWorkdirsRef.current.delete(id);
    options.composerDraftCacheRef.current.delete(id);
    options.setPendingUploadsForConversation(id, []);
    if (options.conversationIdRef.current === id || options.selectedHistoryIdRef.current === id) {
      startNewConversation({
        workdir: newConversationWorkdir(options.isAgentMode, options.activeWorkspaceProjectPath),
      });
    }
  };
  const openHub = (view: Exclude<ApplicationViewId, "chat">) => {
    options.setRightDockOpen(false);
    if (isMobileSidebarLayout()) options.setSidebarOpen(false);
    options.cacheVisibleComposerDraft();
    options.setActiveView(view);
  };
  const handleResendFromEdit = async (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => {
    const activeConversationId = options.conversationIdRef.current.trim();
    if (
      !options.api ||
      !activeConversationId ||
      options.isLocalDraftConversationId(activeConversationId) ||
      options.isConversationBusy(activeConversationId)
    ) {
      return;
    }
    const normalized = text.trim();
    if (!normalized && uploadedFiles.length === 0) return;
    options.setChatError(null);
    options.composerRef.current?.clear();
    options.setPendingUploadsForConversation(activeConversationId, []);
    try {
      const editedDraft = createTextComposerDraft(normalized, referencedConversations);
      await options.sendChatRef.current?.(normalized, {
        conversationId: activeConversationId,
        uploadedFiles,
        referencedConversations: editedDraft.conversationMentions,
        editMessageRef: messageRef,
      });
    } catch (error) {
      options.setChatError(asErrorMessage(error, "编辑后重发失败"));
    }
  };

  const handleBranchConversation = async (messageRef: HistoryMessageRef) => {
    if (!options.api) return;
    const activeConversationId = options.conversationIdRef.current.trim();
    if (
      !activeConversationId ||
      options.isLocalDraftConversationId(activeConversationId) ||
      options.isConversationBusy(activeConversationId) ||
      options.branchInFlightRef.current
    ) {
      return;
    }
    options.branchInFlightRef.current = true;
    options.setBranchPendingMessageId(messageRef.messageId);
    try {
      const summary = await options.api.branchHistory(activeConversationId, messageRef);
      options.sidebarStore.upsertLocal(normalizeGatewayConversationSummary(summary));
      handleSidebarSelectConversation(summary.id);
    } catch (error) {
      options.setChatError(asErrorMessage(error, options.branchFailureMessage));
    } finally {
      options.branchInFlightRef.current = false;
      options.setBranchPendingMessageId(null);
    }
  };
  const handleLoadUploadedImagePreview = async (workspaceRoot: string, absolutePath: string) => {
    if (!options.api) return null;
    const result = await options.api.readUploadedImagePreview(workspaceRoot, absolutePath);
    return result.data.trim() ? result : null;
  };

  return {
    handleBranchConversation,
    handleLoadUploadedImagePreview,
    handleResendFromEdit,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenResourceHub: (resource: SidebarShortcutId) => openHub(`${resource}-hub`),
    handleSidebarSelectConversation,
    startNewConversation,
  };
}
