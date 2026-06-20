//! Git 状态读取与文件 diff 数据收集
//!
//! 不调用系统 `git` 命令行，纯 `git2` 库实现。

use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::fs;
use std::io::Read;
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

/// 把指定文件写入暂存区（index）。
///
/// 用 git2 的 `Index::add_path` + `Index::write` 完成,跨平台走 git2 内部路径处理。
/// file_path 前端传来是 POSIX "/" 风格,git2 会做平台转换。
pub fn stage_file(repo_path: &str, file_path: &str) -> Result<(), String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("读取索引失败: {e}"))?;
    index
        .add_path(Path::new(file_path))
        .map_err(|e| format!("暂存失败: {e}"))?;
    index.write().map_err(|e| format!("写入索引失败: {e}"))?;
    Ok(())
}

/// 丢弃指定文件的改动,根据 status 走不同路径。
///
/// - `untracked`：物理删除(目录走 `remove_dir_all`,文件走 `remove_file`)
/// - 其它 git-tracked 状态(modified / staged / deleted / renamed / typechange)：
///   用 `CheckoutBuilder::path()` 精准锁定单文件,`force` 模式从 HEAD 恢复
///   —— 绝不会误伤工作区其他文件
pub fn discard_file(repo_path: &str, file_path: &str, status: &str) -> Result<(), String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;

    match status {
        "untracked" => {
            let full = Path::new(repo_path).join(file_path);
            if full.is_dir() {
                fs::remove_dir_all(&full).map_err(|e| format!("删除目录失败: {e}"))?;
            } else {
                fs::remove_file(&full).map_err(|e| format!("删除文件失败: {e}"))?;
            }
            Ok(())
        }
        "modified" | "staged" | "deleted" | "renamed" | "typechange" => {
            let mut opts = git2::build::CheckoutBuilder::new();
            opts.force();
            opts.path(Path::new(file_path)); // 🚨 精准锁定单文件
            repo.checkout_head(Some(&mut opts))
                .map_err(|e| format!("恢复 HEAD 失败: {e}"))?;
            Ok(())
        }
        _ => Err(format!("未知状态: {status}")),
    }
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

/// 获取当前已暂存区的全量 diff 文本(等价 `git diff --cached`)。
/// unborn HEAD 自动退化(empty tree vs index),不报错 —— 仍然返回空字符串。
pub fn get_staged_diff(repo_path: &str) -> Result<String, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;

    // HEAD tree(若 unborn 则 None,git2 内部用空树兜底)
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok());

    let index = repo.index().map_err(|e| format!("读取索引失败: {e}"))?;

    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(|e| format!("计算 diff 失败: {e}"))?;

    let mut output = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        output.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| format!("序列化 diff 失败: {e}"))?;

    Ok(output)
}

/// 把当前 index 落地为一次 commit。
/// 自动从 repo config 读 user.name / user.email 构造签名;若未配置返回明确错误。
/// unborn HEAD 也能正确处理(空 parents,生成 root commit)。
pub fn execute_commit(repo_path: &str, message: &str) -> Result<(), String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("读取索引失败: {e}"))?;
    let tree_id = index.write_tree().map_err(|e| format!("写入树失败: {e}"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("查找树失败: {e}"))?;

    let sig = repo.signature().map_err(|e| {
        format!("读取签名失败(请先 `git config user.name` 和 `user.email`): {e}")
    })?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.as_ref().map(|c| vec![c]).unwrap_or_default();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| format!("提交失败: {e}"))?;
    Ok(())
}

/// 取消暂存指定文件 —— 把文件从暂存区(index)撤回到工作区,不动文件内容。
///
/// - HEAD 存在:用 `repo.reset_default` 做 single-pathspec Mixed reset
///   (libgit2 层 hardcoded,只更新 index 不过 worktree)
/// - Unborn HEAD(刚 `git init` 还没首次 commit):用 `index.remove_path`
///   直接从索引移除
pub fn unstage_file(repo_path: &str, file_path: &str) -> Result<(), String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("打开仓库失败: {e}"))?;
    let path = Path::new(file_path);

    match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(head_commit) => {
            let target = head_commit.as_object();
            repo.reset_default(Some(target), [path])
                .map_err(|e| format!("取消暂存失败: {e}"))?;
        }
        None => {
            let mut index = repo.index().map_err(|e| format!("读取索引失败: {e}"))?;
            index
                .remove_path(path)
                .map_err(|e| format!("从索引移除失败(可能未暂存): {e}"))?;
            index
                .write()
                .map_err(|e| format!("写入索引失败: {e}"))?;
        }
    }
    Ok(())
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
/// - **不过滤任何目录** —— node_modules / target / .git / dist / .venv 等
///   都会进树（懒加载保底，未展开就不会卡）
/// - 单个读取错误吞掉不致命（权限拒绝等）
///
/// 排序：目录优先 + 文件次之，各自按名字（大小写不敏感）升序
pub fn read_directory(dir_path: &str) -> Result<Vec<FileEntry>, String> {
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

/// 读取单个工作区文件(只读查看器用)。
/// 二进制拦截:打开后读前 1024 字节,遇 \0 立即返回 BINARY_FILE_DETECTED。
/// 通过后用 fs::read_to_string 全量读取,经 normalize_eol 规范化行尾。
pub fn read_workspace_file(file_path: &str) -> Result<String, String> {
    let path = Path::new(file_path);

    // 1. 打开文件 + 读取前 1024 字节做二进制嗅探
    let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut sniff = [0u8; 1024];
    let n = file
        .read(&mut sniff)
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if sniff[..n].contains(&0u8) {
        return Err("BINARY_FILE_DETECTED".to_string());
    }

    // 2. 文本安全,全量读取并规范化行尾
    let raw = fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(normalize_eol(&raw))
}

/// 用 `code <path>` 静默唤起 VS Code。
/// 完美兼容 Windows (处理 code.cmd 批处理) 与 Unix 系统,执行失败时静默降级。
pub fn open_in_vscode(file_path: &str) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.args(["/C", "code"]);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new("code");

    // 异步拉起进程,吞掉错误实现安全降级
    let _ = cmd.arg(file_path).spawn();
    Ok(())
}
