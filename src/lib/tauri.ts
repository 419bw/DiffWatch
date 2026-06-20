// Tauri 后端 invoke 封装 + dialog 文件夹选择
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
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

// === Stage / Discard 操作闭环 ===

/** 把单个文件加入暂存区 */
export const stageFile = (repoPath: string, filePath: string) =>
  invoke<void>("stage_file", { repoPath, filePath });

/** 丢弃单个文件的改动（untracked 走物理删除,其它走 checkout_head 恢复 HEAD） */
export const discardFile = (repoPath: string, filePath: string, status: string) =>
  invoke<void>("discard_file", { repoPath, filePath, status });

/** 丢弃前的二次确认弹窗 —— tauri-plugin-dialog 的 ask 原生系统对话框 */
export async function confirmDiscard(filePath: string): Promise<boolean> {
  return await ask(
    `确定要彻底抹去该文件的 AI 改动吗?\n\n${filePath}\n\n此操作不可逆`,
    { title: "丢弃改动", kind: "warning", okLabel: "丢弃", cancelLabel: "取消" }
  );
}