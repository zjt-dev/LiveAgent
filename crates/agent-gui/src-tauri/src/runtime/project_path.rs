/// 远程工作空间身份串的 scheme，与前端 `REMOTE_WORKSPACE_PATH_SCHEME` 一致。
pub const REMOTE_WORKSPACE_PATH_SCHEME: &str = "ssh://";

pub fn project_path_key(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_windows_project_path_like(trimmed) {
        normalize_windows_project_path_key(trimmed)
    } else {
        normalize_posix_project_path_key(trimmed)
    }
}

/// 判断项目 key 是否为**远程工作空间身份串**（`ssh://<hostId>/<abs>`）。
///
/// 这类 key 不是本地路径：`Path::new("ssh://…").is_absolute()` 为假，任何把
/// 它当本地目录用的校验（`canonicalize_workdir`、containment 检查）都必然失败。
/// 远程工作空间在会话侧本来就**没有本地根**，所以按 key 的形态区分是唯一可靠的
/// 判据 —— 与前端 `isRemoteWorkspacePath` 同一口径。
///
/// 判据只取「scheme + 非空 host + 至少一个 `/`」：前端的 `parseRemoteWorkspacePath`
/// 还要求 `decodeURIComponent(hostId)` 成功，而这里不做百分号解码 —— 一个畸形的
/// `%` 序列在两侧的分歧方向是「Rust 更宽松」，而宽松的后果只是少做一次本地
/// containment（远程分支不会因此拿到任何本地访问权），不会放宽本地路径的校验。
pub fn is_remote_workspace_project_key(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(rest) = trimmed.strip_prefix(REMOTE_WORKSPACE_PATH_SCHEME) else {
        return false;
    };
    // `separator > 0`：`separator == 0` 时 hostId 为空（`ssh:///abs`），不是身份串。
    let Some(separator) = rest.find('/').filter(|index| *index > 0) else {
        return false;
    };
    !rest[..separator].trim().is_empty()
}

pub fn project_path_keys_equal(left: &str, right: &str) -> bool {
    project_path_key(left) == project_path_key(right)
}

fn is_windows_project_path_like(value: &str) -> bool {
    has_windows_extended_prefix(value)
        || has_windows_drive_prefix(value)
        || has_windows_unc_prefix(value)
}

fn normalize_windows_project_path_key(value: &str) -> String {
    let stripped = strip_windows_extended_prefix(value);
    let normalized = stripped.replace('\\', "/");
    trim_trailing_windows_project_slashes(&normalized).to_lowercase()
}

fn normalize_posix_project_path_key(value: &str) -> String {
    let mut next = value.to_string();
    while next.len() > 1 && next.ends_with('/') {
        next.pop();
    }
    next
}

fn strip_windows_extended_prefix(value: &str) -> String {
    if has_windows_extended_unc_prefix(value) {
        return format!("//{}", &value[8..]);
    }
    if has_windows_extended_prefix(value) {
        return value[4..].to_string();
    }
    value.to_string()
}

fn trim_trailing_windows_project_slashes(value: &str) -> String {
    let min_len = windows_project_root_len(value);
    let mut next = value.to_string();
    while next.len() > min_len && next.ends_with('/') {
        next.pop();
    }
    next
}

fn windows_project_root_len(value: &str) -> usize {
    let bytes = value.as_bytes();
    if bytes.len() >= 3 && is_ascii_alpha(bytes[0]) && bytes[1] == b':' && bytes[2] == b'/' {
        return 3;
    }
    if let Some(rest) = value.strip_prefix("//") {
        let mut parts = rest.split('/');
        let Some(server) = parts.next().filter(|part| !part.is_empty()) else {
            return 2;
        };
        let Some(share) = parts.next().filter(|part| !part.is_empty()) else {
            return 2;
        };
        return 2 + server.len() + 1 + share.len();
    }
    1
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && is_ascii_alpha(bytes[0])
        && bytes[1] == b':'
        && (bytes.len() == 2 || is_path_separator(bytes[2]))
}

fn has_windows_unc_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 2 || !is_path_separator(bytes[0]) || !is_path_separator(bytes[1]) {
        return false;
    }
    let rest = &value[2..];
    let mut parts = rest.split(['\\', '/']);
    let Some(server) = parts.next().filter(|part| !part.is_empty()) else {
        return false;
    };
    let Some(share) = parts.next().filter(|part| !part.is_empty()) else {
        return false;
    };
    !server.is_empty() && !share.is_empty()
}

fn has_windows_extended_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 4
        && is_path_separator(bytes[0])
        && is_path_separator(bytes[1])
        && bytes[2] == b'?'
        && is_path_separator(bytes[3])
}

fn has_windows_extended_unc_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 8
        && is_path_separator(bytes[0])
        && is_path_separator(bytes[1])
        && bytes[2] == b'?'
        && is_path_separator(bytes[3])
        && bytes[4].eq_ignore_ascii_case(&b'U')
        && bytes[5].eq_ignore_ascii_case(&b'N')
        && bytes[6].eq_ignore_ascii_case(&b'C')
        && is_path_separator(bytes[7])
}

fn is_path_separator(value: u8) -> bool {
    value == b'\\' || value == b'/'
}

fn is_ascii_alpha(value: u8) -> bool {
    value.is_ascii_alphabetic()
}

#[cfg(test)]
mod tests {
    use super::{is_remote_workspace_project_key, project_path_key, project_path_keys_equal};

    #[test]
    fn project_path_key_normalizes_windows_drive_paths() {
        assert_eq!(project_path_key(r" C:\Users\Me\Repo\ "), "c:/users/me/repo");
        assert_eq!(project_path_key("c:/USERS/me/REPO"), "c:/users/me/repo");
        assert_eq!(project_path_key(r"C:\"), "c:/");
    }

    #[test]
    fn project_path_key_normalizes_windows_unc_paths() {
        assert_eq!(
            project_path_key(r"\\Server\Share\Repo\"),
            "//server/share/repo"
        );
        assert_eq!(project_path_key(r"\\Server\Share\"), "//server/share");
    }

    #[test]
    fn project_path_key_strips_windows_extended_prefixes() {
        assert_eq!(
            project_path_key(r"\\?\C:\Users\Me\Repo\"),
            "c:/users/me/repo"
        );
        assert_eq!(
            project_path_key(r"\\?\UNC\Server\Share\Repo\"),
            "//server/share/repo"
        );
    }

    #[test]
    fn project_path_key_preserves_posix_case_and_backslashes() {
        assert_eq!(project_path_key(" /Users/A/App/ "), "/Users/A/App");
        assert_eq!(project_path_key("/tmp/Foo"), "/tmp/Foo");
        assert_eq!(project_path_key(r"/tmp/Foo\"), r"/tmp/Foo\");
        assert!(!project_path_keys_equal("/tmp/Foo", "/tmp/foo"));
    }

    #[test]
    fn project_path_keys_equal_compares_normalized_windows_shapes() {
        assert!(project_path_keys_equal(r"C:\Repo", "c:/repo/"));
        assert!(project_path_keys_equal(
            r"\\?\UNC\Server\Share\Repo",
            r"\\server\share\repo\"
        ));
    }

    #[test]
    fn remote_workspace_keys_are_recognized() {
        assert!(is_remote_workspace_project_key(
            "ssh://e9635c44-f026-41b7-8ca8-19e42d9b9fdf/data/cursor2api"
        ));
        // 根目录就是 `/` 的形态（`buildRemoteWorkspacePath` 在 rootPath 归一成 `/` 时产出）。
        assert!(is_remote_workspace_project_key("ssh://host/"));
        // hostId 允许被百分号编码，形态判据不看它的解码结果。
        assert!(is_remote_workspace_project_key("ssh://host%20a/data"));
    }

    #[test]
    fn remote_workspace_keys_reject_non_identity_shapes() {
        // 没有 `/` → 分不出 hostId 与远程根。
        assert!(!is_remote_workspace_project_key("ssh://host"));
        // hostId 为空（`separator == 0`）。
        assert!(!is_remote_workspace_project_key("ssh:///data"));
        assert!(!is_remote_workspace_project_key("ssh://   /data"));
        // scheme 必须完整匹配，不能靠前缀截断蒙对。
        assert!(!is_remote_workspace_project_key("ssh:/host/data"));
        assert!(!is_remote_workspace_project_key("sftp://host/data"));
        // 本地路径（含 Windows 盘符与 UNC）一律不是身份串。
        assert!(!is_remote_workspace_project_key(r"C:\Users\zjt\repo"));
        assert!(!is_remote_workspace_project_key("c:/users/zjt/repo"));
        assert!(!is_remote_workspace_project_key(r"\\server\share\repo"));
        assert!(!is_remote_workspace_project_key("/Users/zjt/repo"));
        assert!(!is_remote_workspace_project_key(""));
        assert!(!is_remote_workspace_project_key("   "));
    }

    #[test]
    fn remote_workspace_key_is_preserved_verbatim_by_project_path_key() {
        // 身份串必须原样返回：它既是分组键也是 SSH 关联键，任何折叠都会让两端错开。
        let identity = "ssh://e9635c44-f026-41b7-8ca8-19e42d9b9fdf/data/cursor2api";
        assert_eq!(project_path_key(identity), identity);
        assert!(is_remote_workspace_project_key(&project_path_key(identity)));
    }
}
