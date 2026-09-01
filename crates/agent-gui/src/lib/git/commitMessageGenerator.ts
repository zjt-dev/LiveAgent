// Commit-message generator for the Git Review panel.
//
// This is a desktop-only module (no web mirror): it calls the same text-only
// completion pipeline the compaction summarizer uses (completeAssistantMessage),
// so it needs the real provider runtime config that only exists on the GUI side.
// The web Git Review panel renders the "generate" button but leaves it disabled
// (no onGenerateCommitMessage callback), so the mirrored components stay
// byte-for-byte identical.

import type { GitDiffResponse } from "@liveagent/ui/lib/git/types";
import { resolveEffectiveChatModelSelection } from "../../pages/chat/runtime/modelSelection";
import {
  assistantMessageToText,
  completeAssistantMessage,
  createProviderRuntimeConfig,
} from "../providers/llm";
import type { AppSettings } from "../settings";

export type GeneratedCommitMessage = {
  /** Single-line subject (conventional-commit prefix when inferable). */
  title: string;
  /** Optional multi-line body, empty when none. */
  body: string;
};

export type GenerateCommitMessageResult = {
  message: GeneratedCommitMessage;
  /** Provider/model actually used, so failures can name the culprit. */
  model: string;
};

const MAX_DIFF_CHARS = 60_000;

function buildSystemPrompt(): string {
  return [
    "You are a precise commit-message writer for a Git repository.",
    "Analyze the staged diff and produce a clear, concise commit message.",
    "Rules:",
    "- First line: a short imperative title (≤ 72 chars), conventional-commit prefix",
    "  (feat:, fix:, refactor:, chore:, docs:, test:, perf:, style:) only when it clearly fits.",
    "- Optionally a body after a blank line explaining the why, in the same language as the code/comments when meaningful.",
    '- Respond with ONLY a JSON object: {"title": "...", "body": "..."}.',
    '  "body" may be an empty string when a single line suffices.',
    "- No markdown fences, no commentary around the JSON.",
  ].join("\n");
}

function buildUserPrompt(diff: GitDiffResponse): string {
  const truncated = diff.patch.length > MAX_DIFF_CHARS;
  const patch = truncated ? diff.patch.slice(0, MAX_DIFF_CHARS) : diff.patch;
  const parts: string[] = [];
  if (diff.stat.trim()) {
    parts.push(`## Diff stat\n${diff.stat.trim()}`);
  }
  if (patch.trim()) {
    parts.push(`## Diff\n${patch.trim()}`);
  }
  if (diff.binaryFiles.length > 0) {
    parts.push(`## Binary files (skipped)\n${diff.binaryFiles.join("\n")}`);
  }
  if (truncated) {
    parts.push("## Note\nDiff was truncated; summarize the visible portion.");
  }
  if (parts.length === 0) {
    parts.push("No textual diff available.");
  }
  return parts.join("\n\n");
}

/** Extract {title, body} from the model's output, tolerating JSON or plain text. */
export function parseCommitMessage(text: string): GeneratedCommitMessage {
  const trimmed = text.trim();
  // Try JSON first (wrapped or bare).
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { title?: unknown; body?: unknown };
      const title = String(parsed.title ?? "").trim();
      const body = String(parsed.body ?? "").trim();
      if (title) return { title, body };
    } catch {
      // fall through to the plain-text parser below
    }
  }
  // Plain-text fallback: first non-empty line is the title, the rest the body.
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  const title = lines.find((line) => line.length > 0) ?? "";
  const body = lines
    .slice(lines.indexOf(title) + 1)
    .filter((line) => line.length > 0)
    .join("\n");
  return { title, body };
}

export async function generateCommitMessage(params: {
  settings: AppSettings;
  diff: GitDiffResponse;
  signal?: AbortSignal;
}): Promise<GenerateCommitMessageResult> {
  const { settings, diff } = params;
  const selection = resolveEffectiveChatModelSelection({ settings });
  const { provider, providerId, model } = selection;

  const runtime = createProviderRuntimeConfig(provider, model, settings.chatRuntimeControls);

  const customPrompt = settings.customSettings.gitCommitMessagePrompt?.trim();
  const systemPrompt = customPrompt || buildSystemPrompt();

  const assistant = await completeAssistantMessage({
    providerId,
    model,
    runtime,
    context: {
      systemPrompt,
      messages: [{ role: "user", content: buildUserPrompt(diff), timestamp: Date.now() }],
    },
    signal: params.signal,
    allowJsonOutput: true,
  });

  return {
    message: parseCommitMessage(assistantMessageToText(assistant)),
    model,
  };
}
