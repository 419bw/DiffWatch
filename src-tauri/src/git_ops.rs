//! Git 状态读取与文件 diff 数据收集
//!
//! 不调用系统 `git` 命令行，纯 `git2` 库实现。

use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 仓库中某个变更文件的摘要
#[derive(Serialize, Clone, Debug)]
pub struct GitFile {
    pub path: String,
    /// `modified` / `untracked` / `deleted` / `staged` / `renamed` / `typechange`
    pub status: String,
}

/// 某个文件在 HEAD（旧）vs 工作区（新）之间的内容对
#[derive(Serialize, Clone, Debug)]
pub struct FileDiffData {
    pub old_content: String,
    pub new_content: String,
    pub old_path: Option<String>,
    pub new_path: String,
    /// shiki 支持的语言 id；未识别 / 二进制为 `None`
    pub lang: Option<String>,
}

/// 单层目录条目 —— 前端懒加载树的最小数据单元
#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    /// 文件 / 文件夹路径；统一用 POSIX 风格 "/" 分隔
    pub path: String,
    pub is_dir: bool,
}

/// 列出仓库中所有变更（工作区 + 暂存区）
pub fn list_changed_files(repo_path: &str) -> Result<Vec<GitFile>, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        // 不递归进 untracked 目录,否则 src-tauri/ 这种整个未跟踪目录会展开
        // 出 Cargo.toml/build.rs/tauri.conf.json/icons/* 等一堆噪音
        .recurse_untracked_dirs(false)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("读取状态失败: {e}"))?;

    let mut out = Vec::new();
    for entry in statuses.iter() {
        let st = entry.status();
        if st.is_conflicted() {
            continue;
        }
        // 兜底:虽然 include_ignored(false) 应已过滤,git2 0.19 + Windows
        // 偶发把 ignored 当 untracked 返,这里再卡一道
        if st.is_ignored() {
            continue;
        }
        // 优先级：staged > 工作区
        let label = if st.is_index_new()
            || st.is_index_modified()
            || st.is_index_deleted()
            || st.is_index_renamed()
            || st.is_index_typechange()
        {
            "staged"
        } else if st.is_wt_new() {
            "untracked"
        } else if st.is_wt_modified() {
            "modified"
        } else if st.is_wt_deleted() {
            "deleted"
        } else if st.is_wt_renamed() {
            "renamed"
        } else if st.is_wt_typechange() {
            "typechange"
        } else {
            continue;
        };
        if let Some(p) = entry.path() {
            out.push(GitFile {
                path: p.to_string(),
                status: label.to_string(),
            });
        }
    }
    Ok(out)
}

/// 读取指定文件在 HEAD 与工作区之间的内容对
///
/// - HEAD 不存在（unborn）→ 旧内容空字符串
/// - 文件在工作区不存在（已删除 / 二进制无法 UTF-8 解码）→ 新内容空字符串
pub fn read_file_diff(repo_path: &str, file_path: &str) -> Result<FileDiffData, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;

    // 旧内容：从 HEAD tree 拿
    let old_content = normalize_eol(&read_head_blob(&repo, file_path));

    // 新内容：直接读磁盘（对二进制 / 不存在用空串兜底）
    let new_path: PathBuf = Path::new(repo_path).join(file_path);
    let new_content = std::fs::read_to_string(&new_path)
        .map(|s| normalize_eol(&s))
        .unwrap_or_default();

    let lang = guess_lang(file_path);

    Ok(FileDiffData {
        old_content,
        new_content,
        old_path: Some(file_path.to_string()),
        new_path: file_path.to_string(),
        lang,
    })
}

fn read_head_blob(repo: &Repository, file_path: &str) -> String {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return String::new(), // Unborn HEAD 兜底
    };
    let commit = match head.peel_to_commit() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let tree = match commit.tree() {
        Ok(t) => t,
        Err(_) => return String::new(),
    };
    tree.get_path(Path::new(file_path))
        .ok()
        .and_then(|entry| entry.to_object(repo).ok())
        .and_then(|o| o.as_blob().map(|b| String::from_utf8_lossy(b.content()).into_owned()))
        .unwrap_or_default()
}

/// 把 CRLF / 单独 CR 都规范成 LF,避免 git autocrlf 让工作区(CRLF)与 HEAD(LF)
/// 行尾不一致,导致 DiffView 报 content mismatch
fn normalize_eol(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 根据后缀名猜 shiki 支持的语言。未知 / 二进制 → None
fn guess_lang(path: &str) -> Option<String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    let lang = match ext.as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cxx" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "scala" => "scala",
        "sh" | "bash" | "zsh" => "bash",
        "ps1" => "powershell",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "md" | "markdown" => "markdown",
        "sql" => "sql",
        "lua" => "lua",
        "vue" => "vue",
        "svelte" => "svelte",
        "dockerfile" => "dockerfile",
        _ => return None,
    };
    Some(lang.to_string())
}

/// 读取单个目录的单层条目（懒加载：每次只读一层）
///
/// 设计目标：
/// - 替代旧的 list_workspace_tree 全量扫描（性能差、大仓库秒卡）
/// - 前端展开文件夹时才发起新一轮读取
///
/// 过滤规则：
/// - 任何深度都强制过滤 `.git` / `node_modules` / `target`
///   （防止 monorepo 嵌套 node_modules 把树跑死）
/// - 单个读取错误吞掉不致命（权限拒绝等）
///
/// 排序：目录优先 + 文件次之，各自按名字（大小写不敏感）升序
pub fn read_directory(dir_path: &str) -> Result<Vec<FileEntry>, String> {
    const HEAVY_DIRS: &[&str] = &[".git", "node_modules", "target"];

    let root = PathBuf::from(dir_path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不可读: {dir_path}"));
    }

    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) => return Err(format!("读取目录失败: {e}")),
    };

    let mut collected: Vec<(String, bool, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if HEAVY_DIRS.iter().any(|s| *s == name) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // symlink 当文件处理，避免前端递归展开时再次 read_dir 跟进去
        let is_dir = ft.is_dir() && !ft.is_symlink();
        collected.push((name, is_dir, entry.path()));
    }

    collected.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()),
    });

    Ok(collected
        .into_iter()
        .map(|(name, is_dir, p)| {
            // 统一用 "/" 分隔，前端跨平台解析稳定
            let path_str = p.to_string_lossy().replace('\\', "/");
            FileEntry {
                name,
                path: path_str,
                is_dir,
            }
        })
        .collect())
}
