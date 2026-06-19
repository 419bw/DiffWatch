//! Tauri Commands — 前端 invoke 入口
//!
//! 命名规范：snake_case（Rust）↔ camelCase（前端 invoke 参数自动转换）
//! 例如：`get_file_content(repo_path, file_path)` 在前端调用时写：
//!     invoke('get_file_content', { repoPath: '...', filePath: '...' })

use crate::git_ops::{
    list_changed_files, read_directory as read_dir_impl, read_file_diff, FileDiffData, FileEntry,
    GitFile,
};

/// 获取仓库变更文件列表
#[tauri::command]
pub fn get_git_status(repo_path: String) -> Result<Vec<GitFile>, String> {
    list_changed_files(&repo_path)
}

/// 获取某个文件在 HEAD（旧）vs 工作区（新）之间的内容对
#[tauri::command]
pub fn get_file_content(repo_path: String, file_path: String) -> Result<FileDiffData, String> {
    read_file_diff(&repo_path, &file_path)
}

/// 读取单个目录的单层条目 —— 前端 WORKSPACE 懒加载树每次展开都调一次
#[tauri::command]
pub fn read_directory(dir_path: String) -> Result<Vec<FileEntry>, String> {
    read_dir_impl(&dir_path)
}