// Tauri 后端 invoke 封装 + dialog 文件夹选择
import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type { GitFile, FileDiffData, FileEntry, IgnorePattern } from "../types";

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

/** 把单个文件从暂存区撤回到工作区(等价 `git reset HEAD <path>`,Mixed reset,不动 worktree) */
export const unstageFile = (repoPath: string, filePath: string) =>
  invoke<void>("unstage_file", { repoPath, filePath });

/** 丢弃单个文件的改动（untracked 走物理删除,其它走 checkout_head 恢复 HEAD） */
export const discardFile = (repoPath: string, filePath: string, status: string) =>
  invoke<void>("discard_file", { repoPath, filePath, status });

/** 解析仓库根 .gitignore,返回结构化 pattern 列表 —— 给前端 Tree 用作 dim 渲染 */
export const parseGitignore = (repoPath: string) =>
  invoke<IgnorePattern[]>("parse_gitignore", { repoPath });

/** 获取当前已暂存区的全量 diff 文本（等价 `git diff --cached`） */
export const getStagedDiff = (repoPath: string) =>
  invoke<string>("get_staged_diff", { repoPath });

/** 用 message 提交当前暂存区 */
export const executeCommit = (repoPath: string, message: string) =>
  invoke<void>("execute_commit", { repoPath, message });

/** 丢弃前的二次确认弹窗 —— tauri-plugin-dialog 的 ask 原生系统对话框 */
export async function confirmDiscard(filePath: string): Promise<boolean> {
  return await ask(
    `确定要彻底抹去该文件的 AI 改动吗?\n\n${filePath}\n\n此操作不可逆`,
    { title: "丢弃改动", kind: "warning", okLabel: "丢弃", cancelLabel: "取消" }
  );
}

/** 读取单个工作区文件(只读查看器)。二进制返回 BINARY_FILE_DETECTED 错误。 */
export const readWorkspaceFile = (filePath: string) =>
  invoke<string>("read_workspace_file", { filePath });

/** 用 VS Code 打开文件。code 不存在时静默降级(后端 Ok(())),前端 catch 后无副作用。 */
export const openInVscode = (filePath: string) =>
  invoke<void>("open_in_vscode", { filePath });

/** 流式单行修补 —— 查看器内双击编辑落盘。line_num 为 1-indexed。 */
export const patchFileLine = (
  repoPath: string,
  filePath: string,
  lineNum: number,
  newContent: string
) =>
  invoke<void>("patch_file_line", { repoPath, filePath, lineNum, newContent });