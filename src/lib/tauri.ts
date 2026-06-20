// Tauri 后端 invoke 封装 + dialog 文件夹选择
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { GitFile, FileDiffData, FileEntry } from "../types";

/** 弹原生系统文件夹选择对话框，返回用户选中的目录或 null */
export async function pickRepoDir(): Promise<string | null> {
  const result = await open({ directory: true, multiple: false });
  if (typeof result === "string") return result;
  return null;
}

export const getGitStatus = (repoPath: string) =>
  invoke<GitFile[]>("get_git_status", { repoPath });

export const getFileContent = (repoPath: string, filePath: string) =>
  invoke<FileDiffData>("get_file_content", { repoPath, filePath });

/** 读取单个目录的单层条目 —— WORKSPACE 懒加载树每次展开都调一次 */
export const readDirectory = (dirPath: string) =>
  invoke<FileEntry[]>("read_directory", { dirPath });

/** 启动 / 替换仓库目录监听器 —— 前端在 repoPath 变化时调用 */
export const startWatching = (repoPath: string) =>
  invoke<void>("start_watching", { repoPath });

/** 停止监听(可选 —— 前端不需要时调用) */
export const stopWatching = () => invoke<void>("stop_watching");