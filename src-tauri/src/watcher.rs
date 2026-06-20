//! 文件系统监听 —— 让前端能自动感知外部代码变更
//!
//! 设计要点：
//! - 用 `notify-debouncer-full` 自带防抖,200ms 内合并多次写事件
//! - 监听 `repo_path` 整个目录(递归)
//! - 路径中含 `target` 或 `node_modules` 段的事件直接丢弃(编译垃圾)
//! - 通过 Tauri event channel 把过滤后的事件 payload 推给前端
//! - 用 Tauri State 持有 Debouncer,切换仓库时 drop 旧的、起新的

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent, Debouncer, FileIdMap};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// 全局 watchdog 句柄 —— Tauri State 持有
/// 切换仓库时 drop 旧的、起新的,所以用 Option
pub struct WatcherState {
    inner: Mutex<Option<Debouncer<RecommendedWatcher, FileIdMap>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
struct RepoChangedPayload {
    /// 被修改的文件路径(已过滤 target / node_modules),POSIX 风格
    paths: Vec<String>,
}

/// 启动 / 替换仓库目录监听器 —— 前端在 repoPath 变化时调用
///
/// 行为：
/// - 若已有旧 watcher,先 drop
/// - 起新 debouncer,200ms 防抖
/// - 在回调线程里:过滤 target/node_modules,统一 POSIX 分隔,通过 app_handle.emit 推给前端
/// - 把 debouncer 句柄存到 State
#[tauri::command]
pub fn start_watching(
    repo_path: String,
    app_handle: AppHandle,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let root = PathBuf::from(&repo_path);
    if !root.is_dir() {
        return Err(format!("仓库路径不存在: {repo_path}"));
    }

    // 1) drop 旧的(若存在)
    {
        let mut g = state.inner.lock().map_err(|e| e.to_string())?;
        *g = None;
    }

    // 2) 起新的 debouncer
    let app_handle_for_cb = app_handle.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |res: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
            let events = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            // 过滤 target / node_modules,统一 "/" 分隔
            let filtered: Vec<String> = events
                .into_iter()
                .flat_map(|ev| ev.event.paths)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .filter(|p| !should_ignore(p))
                .collect();
            if filtered.is_empty() {
                return;
            }
            let _ = app_handle_for_cb.emit(
                "repo-changed",
                RepoChangedPayload { paths: filtered },
            );
        },
    )
    .map_err(|e| format!("创建监听器失败: {e}"))?;

    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("启动监听失败: {e}"))?;

    // 3) 存到 State
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    *g = Some(debouncer);
    Ok(())
}

/// 显式停止(可选 —— 前端不需要时调用)
#[tauri::command]
pub fn stop_watching(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    *g = None;
    Ok(())
}

/// 过滤 `target` 或 `node_modules` 路径段
/// - 匹配目录内文件:`/path/to/repo/target/debug/foo`
/// - 匹配目录本身:`/path/to/repo/target`(罕见,防编辑器重命名/删除整目录时漏报)
fn should_ignore(path: &str) -> bool {
    path.split(|c: char| c == '/' || c == '\\')
        .any(|seg| seg == "target" || seg == "node_modules")
}