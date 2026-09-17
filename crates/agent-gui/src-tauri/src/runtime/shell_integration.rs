//! Windows 资源管理器右键菜单集成。
//!
//! 只写 `HKCU\Software\Classes`（NSIS 的 `installMode` 默认 `currentUser`，
//! 无需管理员权限），覆盖三种「文件夹」右键场景：
//!
//! - 文件夹本身上下文菜单 → `Directory\shell`
//! - 文件夹内空白处上下文菜单 → `Directory\Background\shell`
//! - 「此电脑」里的驱动器图标 → `Drive\shell`
//!
//! 三个类是照着本机注册表核对出来的完整集合：VS Code、CodeBuddy CN、Terax
//! 都恰好注册这三个，而 `Folder` / `AllFilesystemObjects` / `LibraryFolder` /
//! `DesktopBackground` 下没有任何编辑器项（已逐一枚举确认），所以不需要再铺开。
//!
//! 非 Windows 平台整体降级：`status` 返回不支持，注册是显式错误、注销是空操作。
//!
//! 已知限制：Windows 11 把传统 `Directory\shell` 项收进「显示更多选项」二级菜单。
//! 进一级菜单需要 IExplorerCommand + sparse MSIX 包，不在当前范围。
//!
//! 卸载残留：注册项写在 HKCU 且携带 exe 绝对路径，卸载 LiveAgent 后若未关闭
//! 开关，菜单项会指向已删除的 exe。重装到新路径后开关一次即可覆盖。

use std::path::Path;

/// 菜单项注册表子键（相对 `HKEY_CURRENT_USER`），三种场景共用同一项名。
///
/// 写 HKCU 而非 HKLM：免管理员权限，且与本机 VS Code / IntelliJ 等成熟产品的
/// 运行时注册做法一致（已核对本机注册表）。
///
/// `Drive\shell` 单独一条：`Directory\shell` 只作用于普通文件系统目录，
/// 「此电脑」里对 `C:\` `D:\` 右键走的是 `Drive` 类。少了这条，用户在驱动器
/// 图标上右键看不到菜单项。
///
/// 项名未按 Microsoft best-practices 加 `ISVName.verb` 前缀（用 `LiveAgent`
/// 而非 `LiveAgent.open`）：与 VS Code 的 `VSCode` 同构，碰撞概率可忽略。
///
/// 未设 `MultiSelectModel`：多选文件夹时的行为与 VS Code / IntelliJ 对齐
/// （本机注册表核对：两者都未设置该值）。
const CONTEXT_MENU_SUBKEYS: [&str; 3] = [
    r"Software\Classes\Directory\shell\LiveAgent",
    r"Software\Classes\Directory\Background\shell\LiveAgent",
    r"Software\Classes\Drive\shell\LiveAgent",
];

/// 命令行占位符：资源管理器把它替换成被点击的目录路径。
///
/// 用 `%V` 而非 `%1`：`Directory\Background` 场景下 `%V` 解析为当前目录，
/// 三种场景语义一致（`%1` 在 background 场景不可靠）。
///
/// 驱动器场景下 `%V` 展开成带尾随反斜杠的根路径（`C:\`）；前端按
/// `workspaceProjectPathKey` 归一化时会 trim 掉尾随斜杠，不会产生重复项目。
///
/// `%V` 不是 Microsoft 文档化的占位符（官方只定义 `%1`–`%9` / `%*` / `%L` / `%W`），
/// 而是 shell 实现的事实标准。已核对本机注册表确认：VS Code、CodeBuddy CN、
/// Terax、IntelliJ IDEA、cmd（`pushd "%V"`）、PowerShell（`-WorkingDirectory "%V"`）
/// 在三种场景下都用 `%V`。
const CONTEXT_MENU_PATH_PLACEHOLDER: &str = "%V";

/// 前端消费的动作名（经 `app:action` 事件转发，见 `lib.rs`）。
pub const OPEN_WORKSPACE_PATH_ACTION: &str = "open-workspace-path";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuStatus {
    /// 平台是否支持该功能（仅 Windows 为 true）。
    pub supported: bool,
    /// 是否已注册，且 `command` 指向当前可执行文件。
    pub enabled: bool,
}

/// `command` 键值：`"<exe>" "%V"`。
///
/// 两层引号都是必需的——安装路径与目录路径都可能含空格。
pub fn context_menu_command(exe_path: &str) -> String {
    format!("\"{}\" \"{CONTEXT_MENU_PATH_PLACEHOLDER}\"", exe_path.trim())
}

/// `Icon` 键值：`<exe>,0`（第 0 号图标资源）。
pub fn context_menu_icon(exe_path: &str) -> String {
    format!("{},0", exe_path.trim())
}

/// 从命令行参数里挑出待打开的目录路径。
///
/// `argv[0]` 是 exe 自身路径，跳过；其余候选项要求「不是开关」且
/// 「按 `is_dir` 判定为目录」。右键菜单只传一个路径，但用户手动
/// `liveagent.exe some\dir` 的解析对两者同样成立。
///
/// `is_dir` 由调用方注入，便于单测覆盖「不存在 / 是文件 / 是开关」分支。
pub fn workspace_path_from_args<I, S, F>(args: I, is_dir: F) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
    F: Fn(&str) -> bool,
{
    args.into_iter().skip(1).find_map(|raw| {
        let candidate = raw.as_ref().trim().trim_matches('"');
        if candidate.is_empty() || candidate.starts_with('-') {
            return None;
        }
        is_dir(candidate).then(|| candidate.to_string())
    })
}

/// 候选参数是否为已存在的目录。
///
/// 作为 [`workspace_path_from_args`] 的默认校验器，单实例回调与冷启动共用，
/// 避免两处各写一份闭包。
pub fn is_directory_path(candidate: &str) -> bool {
    Path::new(candidate).is_dir()
}

/// 从当前进程参数里解析待打开目录（冷启动路径）。
pub fn workspace_path_from_process_args() -> Option<String> {
    workspace_path_from_args(std::env::args(), is_directory_path)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE,
        REG_SZ,
    };

    /// 资源管理器显示的菜单文案，按系统 UI 语言二选一。
    ///
    /// 语言取自系统而非应用内的界面语言设置：菜单项是**资源管理器**渲染的，
    /// 它属于 Windows 的外壳，理应跟随系统 UI 语言。这也与 VS Code 一致——
    /// 中文 Windows 上装完显示「通过 Code 打开」，英文系统上是 "Open with Code"。
    ///
    /// `pub(super)` 是为了让父模块的测试能直接引用，不进 crate 公开 API。
    pub(super) const CONTEXT_MENU_LABEL_ZH_CN: &str = "在 LiveAgent 中打开";
    pub(super) const CONTEXT_MENU_LABEL_EN_US: &str = "Open in LiveAgent";

    /// 中文（简体 / 繁体 / 香港）的 primary language ID 都是 `0x04`。
    ///
    /// 只按 primary 判定、不细分地区：菜单文案只有简繁之别，而项目主语言是简体中文，
    /// zh-TW / zh-HK 用户看到简体文案属于可接受的降级（VS Code 的 MSI 同样只按
    /// 安装器语言出文案，不区分简繁）。
    const PRIMARY_LANG_CHINESE: u16 = 0x04;

    /// LANGID 的 primary language 位掩码（低 10 位）。
    const LANGID_PRIMARY_MASK: u16 = 0x03ff;

    /// 由 LANGID 决定菜单文案。抽成纯函数以便脱离注册表单测。
    pub(super) fn context_menu_label_for_language(langid: u16) -> &'static str {
        if langid & LANGID_PRIMARY_MASK == PRIMARY_LANG_CHINESE {
            CONTEXT_MENU_LABEL_ZH_CN
        } else {
            CONTEXT_MENU_LABEL_EN_US
        }
    }

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 写入一个 `REG_SZ` 值，必要时创建子键。`name` 为空串表示默认值。
    fn write_string_value(subkey: &str, name: &str, value: &str) -> Result<(), String> {
        let subkey_wide = to_wide(subkey);
        let name_wide = to_wide(name);
        let value_wide = to_wide(value);
        let mut hkey: HKEY = std::ptr::null_mut();
        let mut disposition: u32 = 0;
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey_wide.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_READ | KEY_WRITE,
                std::ptr::null(),
                &mut hkey,
                &mut disposition,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("RegCreateKeyExW({subkey}) failed (error={rc})"));
        }
        // REG_SZ 的 cbdata 含结尾 NUL。
        let bytes = (value_wide.len() * std::mem::size_of::<u16>()) as u32;
        let rc = unsafe {
            RegSetValueExW(
                hkey,
                name_wide.as_ptr(),
                0,
                REG_SZ,
                value_wide.as_ptr() as *const u8,
                bytes,
            )
        };
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        if rc != ERROR_SUCCESS {
            return Err(format!(
                "RegSetValueExW({subkey}\\{name}) failed (error={rc})"
            ));
        }
        Ok(())
    }

    /// 读取一个 `REG_SZ` 值。键或值不存在都返回 `None`。
    ///
    /// 缓冲区不足时（`ERROR_MORE_DATA`）按 `RegQueryValueExW` 回填的所需字节数
    /// 重试一次。不重试的后果不是「读不到」而是「读错」——`status_of` 把读失败
    /// 一律当成未注册，于是开关永远显示关闭，用户无从区分「没注册」和「读不到」。
    pub(super) fn read_string_value(subkey: &str, name: &str) -> Option<String> {
        let subkey_wide = to_wide(subkey);
        let name_wide = to_wide(name);
        let mut hkey: HKEY = std::ptr::null_mut();
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey_wide.as_ptr(),
                0,
                KEY_READ,
                &mut hkey,
            )
        };
        if rc != ERROR_SUCCESS {
            return None;
        }

        // 起始 1 KiB：`command` / `Icon` 实际只有几十字符，一次就够。
        let mut buffer = vec![0u8; 1024];
        let mut size = buffer.len() as u32;
        let mut rc = unsafe {
            RegQueryValueExW(
                hkey,
                name_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        if rc == ERROR_MORE_DATA {
            // 失败时 size 已被回填成所需字节数（含结尾 NUL）。
            buffer.resize(size as usize, 0);
            rc = unsafe {
                RegQueryValueExW(
                    hkey,
                    name_wide.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    buffer.as_mut_ptr(),
                    &mut size,
                )
            };
        }
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        if rc != ERROR_SUCCESS {
            return None;
        }
        let units: Vec<u16> = buffer[..size as usize]
            .chunks_exact(2)
            .map(|chunk| u16::from_ne_bytes([chunk[0], chunk[1]]))
            .collect();
        let end = units
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(units.len());
        String::from_utf16(&units[..end]).ok()
    }

    /// 删除整棵子树。键不存在视为已注销。
    fn delete_subtree(subkey: &str) -> Result<(), String> {
        let subkey_wide = to_wide(subkey);
        let rc = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, subkey_wide.as_ptr()) };
        if rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        Err(format!("RegDeleteTreeW({subkey}) failed (error={rc})"))
    }

    fn command_subkey(subkey: &str) -> String {
        format!(r"{subkey}\command")
    }

    /// 子键集合作为参数而非固定用 [`CONTEXT_MENU_SUBKEYS`]：测试要能在隔离的
    /// 子键上跑真实的注册表读写，绝不能碰用户资源管理器里可见的那两个键。
    pub(super) fn status_of(subkeys: &[&str], exe_path: &str) -> ContextMenuStatus {
        let expected = context_menu_command(exe_path);
        // 所有场景都指向当前 exe 才算启用：任一项缺失或过期都提示用户重新开关。
        let enabled = subkeys.iter().all(|subkey| {
            read_string_value(&command_subkey(subkey), "").as_deref() == Some(expected.as_str())
        });
        ContextMenuStatus {
            supported: true,
            enabled,
        }
    }

    pub(super) fn register_into(subkeys: &[&str], exe_path: &str) -> Result<(), String> {
        if exe_path.trim().is_empty() {
            return Err("无法解析当前可执行文件路径".to_string());
        }
        let command = context_menu_command(exe_path);
        let icon = context_menu_icon(exe_path);
        let label = context_menu_label();
        for subkey in subkeys {
            // 子键默认值是资源管理器显示的文案；command 是子键，其默认值才是命令行。
            write_string_value(subkey, "", label)?;
            write_string_value(subkey, "Icon", &icon)?;
            write_string_value(&command_subkey(subkey), "", &command)?;
        }
        Ok(())
    }

    pub(super) fn unregister_from(subkeys: &[&str]) -> Result<(), String> {
        for subkey in subkeys {
            delete_subtree(subkey)?;
        }
        Ok(())
    }

    /// 当前用户的 UI 语言 LANGID（`GetUserDefaultUILanguage`）。
    ///
    /// 取**用户偏好**而非系统安装语言：装了语言包的机器上两者不同，菜单项
    /// 要跟用户看得懂的那个走，所以用 `GetUserDefaultUILanguage` 而不是
    /// `GetSystemDefaultUILanguage`。
    pub(super) fn system_ui_language_id() -> u16 {
        use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
        // SAFETY: 无参数、无副作用、不触碰任何指针的只读查询。
        unsafe { GetUserDefaultUILanguage() }
    }

    /// 当前系统 UI 语言对应的菜单文案。
    ///
    /// 只服务于 [`register_into`]，不进公开 API——前端不需要知道菜单文案。
    pub(super) fn context_menu_label() -> &'static str {
        context_menu_label_for_language(system_ui_language_id())
    }

    pub fn status(exe_path: &str) -> ContextMenuStatus {
        status_of(&CONTEXT_MENU_SUBKEYS, exe_path)
    }

    pub fn register(exe_path: &str) -> Result<(), String> {
        register_into(&CONTEXT_MENU_SUBKEYS, exe_path)
    }

    pub fn unregister() -> Result<(), String> {
        unregister_from(&CONTEXT_MENU_SUBKEYS)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn status(_exe_path: &str) -> ContextMenuStatus {
        ContextMenuStatus {
            supported: false,
            enabled: false,
        }
    }

    pub fn register(_exe_path: &str) -> Result<(), String> {
        Err("资源管理器右键菜单集成仅支持 Windows".to_string())
    }

    pub fn unregister() -> Result<(), String> {
        Ok(())
    }
}

pub use platform::{register, status, unregister};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_quotes_both_exe_and_placeholder() {
        assert_eq!(
            context_menu_command(r"C:\Program Files\LiveAgent\LiveAgent.exe"),
            r#""C:\Program Files\LiveAgent\LiveAgent.exe" "%V""#
        );
    }

    #[test]
    fn command_trims_exe_path() {
        assert_eq!(
            context_menu_command("  C:\\app\\liveagent.exe  "),
            r#""C:\app\liveagent.exe" "%V""#
        );
    }

    #[test]
    fn icon_appends_zero_index() {
        assert_eq!(context_menu_icon(r"C:\app\liveagent.exe"), r"C:\app\liveagent.exe,0");
    }

    /// 固定住「覆盖哪几个 shell 类」这个契约。
    ///
    /// `Drive\shell` 不是可有可无的补充：少了它，「此电脑」里对驱动器右键不会
    /// 出现菜单项。而这类缺口在人工点测时极易漏掉——没人会顺手去点驱动器图标。
    /// 这条测试的作用是让任何一次「顺手精简常量」当场失败。
    #[test]
    fn context_menu_covers_directory_background_and_drive() {
        assert_eq!(
            CONTEXT_MENU_SUBKEYS,
            [
                r"Software\Classes\Directory\shell\LiveAgent",
                r"Software\Classes\Directory\Background\shell\LiveAgent",
                r"Software\Classes\Drive\shell\LiveAgent",
            ]
        );
    }

    #[test]
    fn args_skip_exe_and_reject_flags() {
        let args = [r"C:\app\liveagent.exe", "--some-flag", r"C:\work"];
        assert_eq!(
            workspace_path_from_args(args, |candidate| candidate == r"C:\work"),
            Some(r"C:\work".to_string())
        );
    }

    #[test]
    fn args_reject_non_directory() {
        let args = [r"C:\app\liveagent.exe", r"C:\not-a-dir"];
        assert_eq!(workspace_path_from_args(args, |_| false), None);
    }

    #[test]
    fn args_require_more_than_exe() {
        let args = [r"C:\app\liveagent.exe"];
        assert_eq!(workspace_path_from_args(args, |_| true), None);
    }

    #[test]
    fn args_strip_wrapping_quotes() {
        let args = ["liveagent.exe", "\"C:\\work dir\""];
        assert_eq!(
            workspace_path_from_args(args, |candidate| candidate == r"C:\work dir"),
            Some(r"C:\work dir".to_string())
        );
    }

    #[test]
    fn args_reject_blank_candidate() {
        let args = ["liveagent.exe", "   "];
        assert_eq!(workspace_path_from_args(args, |_| true), None);
    }

    /// 驱动器场景下 `%V` 展开成 `C:\`（带尾随反斜杠），解析必须原样保留。
    ///
    /// 这条不是形式主义：若哪天有人在解析里「顺手规范化」路径、把尾随分隔符
    /// 剪掉，`C:\` 会退化成 `C:`——而 Windows 上 `C:` 的含义是「C 盘的当前
    /// 目录」，与「C 盘根目录」不是一回事，会静默打开错误的目录。
    /// 尾随反斜杠的清理是前端 `workspaceProjectPathKey` 的职责，不该在这里做。
    #[test]
    fn args_preserve_trailing_separator() {
        let args = [r"C:\app\liveagent.exe", r"C:\"];
        assert_eq!(
            workspace_path_from_args(args, |candidate| candidate == r"C:\"),
            Some(r"C:\".to_string())
        );
    }

    #[test]
    fn non_windows_platform_is_unsupported() {
        let status = status(r"C:\app\liveagent.exe");
        assert_eq!(status.supported, cfg!(windows));
    }

    #[test]
    fn directory_check_accepts_existing_dir_and_rejects_file_and_missing() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let dir = temp.path().to_string_lossy().into_owned();
        assert!(is_directory_path(&dir));

        let file_path = temp.path().join("a.txt");
        std::fs::write(&file_path, b"x").expect("write temp file");
        assert!(!is_directory_path(&file_path.to_string_lossy()));

        let missing = temp.path().join("missing-dir");
        assert!(!is_directory_path(&missing.to_string_lossy()));
    }

    /// 菜单文案按系统 UI 语言二选一。
    ///
    /// LANGID 的低 10 位是 primary language：`0x04` = 中文。各地区变体
    /// （zh-CN `0x0804` / zh-TW `0x0404` / zh-HK `0x0C04`）都落进中文分支。
    #[cfg(windows)]
    #[test]
    fn label_follows_primary_language() {
        use super::platform::{
            context_menu_label_for_language, CONTEXT_MENU_LABEL_EN_US, CONTEXT_MENU_LABEL_ZH_CN,
        };
        assert_eq!(context_menu_label_for_language(0x0804), CONTEXT_MENU_LABEL_ZH_CN);
        assert_eq!(context_menu_label_for_language(0x0404), CONTEXT_MENU_LABEL_ZH_CN);
        assert_eq!(context_menu_label_for_language(0x0c04), CONTEXT_MENU_LABEL_ZH_CN);
        assert_eq!(context_menu_label_for_language(0x0409), CONTEXT_MENU_LABEL_EN_US);
        assert_eq!(context_menu_label_for_language(0x0411), CONTEXT_MENU_LABEL_EN_US);
        // 未初始化 / 读取失败时 LANGID 为 0：必须退回英文，而不是撞上中文分支。
        assert_eq!(context_menu_label_for_language(0), CONTEXT_MENU_LABEL_EN_US);
    }

    /// 地区变体不影响判定：primary 相同、region 位不同，必须给出同一文案。
    ///
    /// 反例是「拿完整 LANGID 精确比较」的写法（`langid == 0x0804`）——那样
    /// zh-TW / zh-HK 会掉进英文分支，en-GB / en-AU 会掉进中文分支。
    /// `0x1004` 额外验证高位（region / sort order）不参与判定。
    #[cfg(windows)]
    #[test]
    fn label_ignores_region_bits() {
        use super::platform::{
            context_menu_label_for_language, CONTEXT_MENU_LABEL_EN_US, CONTEXT_MENU_LABEL_ZH_CN,
        };
        for langid in [0x0804u16, 0x0404, 0x0c04, 0x1004] {
            assert_eq!(
                context_menu_label_for_language(langid),
                CONTEXT_MENU_LABEL_ZH_CN,
                "LANGID {langid:#06x} 的 primary language 是中文"
            );
        }
        for langid in [0x0409u16, 0x0809, 0x0c09] {
            assert_eq!(
                context_menu_label_for_language(langid),
                CONTEXT_MENU_LABEL_EN_US,
                "LANGID {langid:#06x} 的 primary language 是英文"
            );
        }
    }

    /// 真实调用一次 `GetUserDefaultUILanguage`，验证 FFI 声明与调用约定可用。
    ///
    /// 纯函数测试覆盖不到「LANGID 到底怎么取」这一段：若签名或 ABI 写错，
    /// 拿到的会是 0 或垃圾值，而垃圾值多半落到英文分支——表现为「中文系统上
    /// 菜单显示英文」，人工排查时几乎不会联想到是 FFI 的问题。
    #[cfg(windows)]
    #[test]
    fn system_ui_language_id_is_readable() {
        use super::platform;
        let langid = platform::system_ui_language_id();
        assert_ne!(langid, 0, "GetUserDefaultUILanguage 不该返回 0");
    }

    /// 走真实 FFI 取到的文案必须落在已知集合内。
    #[cfg(windows)]
    #[test]
    fn system_label_is_a_known_label() {
        use super::platform;
        let label = platform::context_menu_label();
        assert!(
            label == platform::CONTEXT_MENU_LABEL_ZH_CN
                || label == platform::CONTEXT_MENU_LABEL_EN_US,
            "系统文案必须落在已知集合内，实际 {label:?}"
        );
    }

    /// 走真实的 `RegCreateKeyExW` / `RegSetValueExW` / `RegQueryValueExW` /
    /// `RegDeleteTreeW`：纯函数测试覆盖不到宽字符编码与 `REG_SZ` 字节数计算，
    /// 而这两处错了只会表现为「注册成功但菜单点了没反应」。
    ///
    /// 用隔离子键而非默认路径——后者是用户在资源管理器里能看到的菜单项。
    /// `Software\Classes\LiveAgentContextMenuTest` 不对应任何文件类型或协议，
    /// 资源管理器不会显示它。
    #[cfg(windows)]
    #[test]
    fn registry_round_trip_writes_reads_and_removes() {
        use super::platform;

        const TEST_SUBKEY: &str = r"Software\Classes\LiveAgentContextMenuTest";
        let subkeys: [&str; 1] = [TEST_SUBKEY];
        let exe = r"C:\test\liveagent.exe";

        // 断言失败（panic）也要清理，否则会在用户注册表里留下垃圾键。
        struct Cleanup<'a> {
            subkeys: &'a [&'a str],
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = platform::unregister_from(self.subkeys);
            }
        }
        let _guard = Cleanup { subkeys: &subkeys };

        assert!(!platform::status_of(&subkeys, exe).enabled);

        platform::register_into(&subkeys, exe).expect("register should succeed");
        assert!(platform::status_of(&subkeys, exe).enabled);
        // 指向别的 exe 时不算启用——「重装到新路径后状态过期」就靠这条判定。
        assert!(!platform::status_of(&subkeys, r"C:\other\liveagent.exe").enabled);

        // 三个值都要真的落盘：菜单文案（子键默认值）、图标、命令行。
        //
        // 文案不写成 `Some(context_menu_label())`——那是同义反复，写错了也测不出来。
        // 断言它落在两种已知文案之内，既验证了真的写入，也验证了取到的是合法值。
        let label = platform::read_string_value(TEST_SUBKEY, "").expect("label should be written");
        assert!(
            label == platform::CONTEXT_MENU_LABEL_ZH_CN
                || label == platform::CONTEXT_MENU_LABEL_EN_US,
            "菜单文案必须是两种语言之一，实际写入 {label:?}"
        );
        assert_eq!(
            platform::read_string_value(TEST_SUBKEY, "Icon").as_deref(),
            Some(r"C:\test\liveagent.exe,0")
        );
        assert_eq!(
            platform::read_string_value(&format!(r"{TEST_SUBKEY}\command"), "").as_deref(),
            Some(r#""C:\test\liveagent.exe" "%V""#)
        );

        platform::unregister_from(&subkeys).expect("unregister should succeed");
        assert!(!platform::status_of(&subkeys, exe).enabled);
        // 键已不存在时再删一次不应报错（卸载路径会无条件调用）。
        platform::unregister_from(&subkeys).expect("unregister should be idempotent");
    }

    /// 超过初始缓冲区的值必须能完整读回。
    ///
    /// 不重试的话 `RegQueryValueExW` 返回 `ERROR_MORE_DATA`，而调用方把任何非
    /// `ERROR_SUCCESS` 都当成「未注册」——表现为开关永远显示关闭且没有任何错误
    /// 提示。真实安装路径下 `command` 只有几十字符，但「读不到」被静默当成
    /// 「没注册」是个会骗人的失败模式，值得堵上。
    #[cfg(windows)]
    #[test]
    fn registry_reads_values_longer_than_initial_buffer() {
        use super::platform;

        const TEST_SUBKEY: &str = r"Software\Classes\LiveAgentContextMenuLongValueTest";
        let subkeys: [&str; 1] = [TEST_SUBKEY];

        struct Cleanup<'a> {
            subkeys: &'a [&'a str],
        }
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = platform::unregister_from(self.subkeys);
            }
        }
        let _guard = Cleanup { subkeys: &subkeys };

        // 初始缓冲区 1024 字节 = 512 个 UTF-16 单元。用 600 个中文字符，
        // 编码后 1200 字节，必然触发 ERROR_MORE_DATA；用中文而非 ASCII 是为了
        // 同时确认宽字符路径没被截断成半个字符。
        let long_path: String = "在".repeat(600);
        platform::register_into(&subkeys, &long_path).expect("register should succeed");

        let command = platform::read_string_value(&format!(r"{TEST_SUBKEY}\command"), "")
            .expect("超过初始缓冲区的值必须能完整读回");
        assert_eq!(command, context_menu_command(&long_path));

        platform::unregister_from(&subkeys).expect("unregister should succeed");
    }
}
