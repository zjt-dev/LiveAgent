import fs from "node:fs";
const [inFile, ...outs] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(inFile, "utf8"));
const commonKeys = ["chat.runtime.thinkingTooltip","chat.runtime.webSearchTooltip","chat.tool.aborted","chat.tool.todoEmpty","chat.tool.todoTitle","chat.workspaceRemoveConfirmClose","chat.workspaceRemoveConfirmContinue","chat.workspaceRemoveTerminalDescription","projectTools.gitReview.dismiss","projectTools.gitReview.generateCommitMessageEmpty","projectTools.gitReview.generateCommitMessageFailed","projectTools.gitReview.generateCommitMessageSuccess","projectTools.terminalAddToConversation","projectTools.terminalContextMenu","projectTools.terminalCopy","workspaceFilePreview.rotateImage"];
const settingsKeys = ["settings.skillsInstalledPreviewTitle","settings.themePreset.default","settings.themePreset.defaultHint","settings.themePreset.ocean","settings.themePreset.oceanHint","settings.themePreset.midnight","settings.themePreset.midnightHint","settings.themePreset.forest","settings.themePreset.forestHint","settings.themePreset.sunset","settings.themePreset.sunsetHint"];
const all = [...commonKeys, ...settingsKeys];
function blockFor(keys, locale, indent) {
  return keys.map(k => indent + JSON.stringify(k) + ": " + JSON.stringify(data.gui.find(r => r.k === k)[locale]) + ",").join(String.fromCharCode(10));
}
const guiKeep = data.gui.map(r => r.k).filter(k => !all.includes(k));
const zhCommon = blockFor(commonKeys, "zh", "  ");
const enCommon = blockFor(commonKeys, "en", "  ");
const zhSettings = blockFor(settingsKeys, "zh", "  ");
const enSettings = blockFor(settingsKeys, "en", "  ");
const guiZh = "    /* Owen 分支独有键（合并自 main→Owen，zh-CN） */\n" + blockFor(guiKeep, "zh", "    ");
const guiEn = "    /* Owen 分支独有键（合并自 main→Owen，en-US） */\n" + blockFor(guiKeep, "en", "    ");
fs.writeFileSync(outs[0], zhCommon);
fs.writeFileSync(outs[1], enCommon);
fs.writeFileSync(outs[2], zhSettings);
fs.writeFileSync(outs[3], enSettings);
fs.writeFileSync(outs[4], guiZh);
fs.writeFileSync(outs[5], guiEn);
console.log("guiKeep:", guiKeep.length, JSON.stringify(guiKeep));