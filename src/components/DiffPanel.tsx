import { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { createTwoFilesPatch } from "diff";
import "@git-diff-view/react/styles/diff-view.css";
import { getFileContent } from "../lib/tauri";
import type { FileDiffData } from "../types";

interface DiffPanelProps {
  repoPath: string;
  filePath: string;
  /** 外部文件变更计数器 —— App.tsx 在 repo-changed 时 +1,触发 diff 重拉 */
  refreshKey: number;
}

export default function DiffPanel({ repoPath, filePath, refreshKey }: DiffPanelProps) {
  const [highlighter, setHighlighter] = useState<any>(null);
  const [diffData, setDiffData] = useState<FileDiffData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);

  // 初始化 shiki highlighter（只跑一次）
  // getDiffViewHighlighter 内部已经默认 bundle 了 github-light + github-dark,
  // 所以切 diffViewTheme="dark" 时,语法高亮会自动走 github-dark 主题。
  useEffect(() => {
    let mounted = true;
    getDiffViewHighlighter().then((h) => {
      if (mounted) setHighlighter(h);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // 文件变化时拉数据 —— repoPath / filePath / refreshKey 任一变化都重拉
  useEffect(() => {
    if (!repoPath || !filePath) {
      setDiffData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFileContent(repoPath, filePath)
      .then((d) => {
        if (!cancelled) setDiffData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, filePath, refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted">
        加载中...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-neon-red p-4">
        <div className="text-center">
          <div className="text-lg mb-2">❌ 错误</div>
          <div className="text-sm font-mono">{error}</div>
        </div>
      </div>
    );
  }
  if (!diffData) return null;

  // 判二进制：旧/新都空 + lang 为 null
  const isBinary =
    diffData.new_content === "" &&
    diffData.old_content === "" &&
    diffData.lang === null;
  if (isBinary) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted">
        <div className="text-center">
          <div className="text-4xl mb-2 opacity-50">📦</div>
          <div>暂不支持二进制文件预览</div>
        </div>
      </div>
    );
  }

  // 用 "text" 而非 "plaintext",因为 shiki 默认 bundle 里只有 "text",
  // "plaintext" 会让 hasRegisteredCurrentLang 返回 false,语法高亮静默失败
  const lang = diffData.lang ?? "text";
  const oldName = diffData.old_path ?? filePath;
  const newName = diffData.new_path;

  // 前端用 jsdiff createTwoFilesPatch 算 unified diff 文本,直接喂给
  // <DiffView data.hunks>。不用 generateDiffFile 是因为后者把 content
  // 和 patch 同时塞进 DiffFile,initRaw 内部 composeFile 又从 hunks 重新构造
  // content,会触发 "composed oldFileContent and newFileContent are identical"
  // 警告 + "Invalid bundle data" 错误循环。
  const diffString = createTwoFilesPatch(
    oldName,
    newName,
    diffData.old_content,
    diffData.new_content,
    "", // oldHeader
    ""  // newHeader
  );

  // 无变更(untracked 时 old_content 为空、new_content 与其相同)、或 patch 没有 hunk
  // 都显示占位,不渲染 DiffView
  const hasHunk = diffString.includes("@@");
  const isUntracked = diffData.old_content === "";
  if (!hasHunk || !diffString) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted p-4 text-sm">
        {isUntracked ? "新文件,无历史版本" : "文件无变更"}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏:工业紧凑,纯 Tailwind 工具类,无 gel-box 阴影 */}
      <div className="px-4 py-2 flex items-center justify-between flex-shrink-0 border-b border-white/5">
        <div
          className="text-sm font-bold text-ink-base truncate flex-1 min-w-0 font-mono"
          title={filePath}
        >
          {filePath}
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={() => setMode(DiffModeEnum.SplitGitHub)}
            className={`gel-box rounded-xl px-3 py-1 text-xs font-bold transition-colors ${
              mode === DiffModeEnum.SplitGitHub
                ? "text-white"
                : "text-ink-muted hover:text-white"
            }`}
            style={
              mode === DiffModeEnum.SplitGitHub
                ? {
                    background: "rgba(255,255,255,0.06)",
                    boxShadow:
                      "inset 0 0 0 1px rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.4)",
                  }
                : undefined
            }
          >
            Split
          </button>
          <button
            onClick={() => setMode(DiffModeEnum.Unified)}
            className={`gel-box rounded-xl px-3 py-1 text-xs font-bold transition-colors ${
              mode === DiffModeEnum.Unified
                ? "text-white"
                : "text-ink-muted hover:text-white"
            }`}
            style={
              mode === DiffModeEnum.Unified
                ? {
                    background: "rgba(255,255,255,0.06)",
                    boxShadow:
                      "inset 0 0 0 1px rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.4)",
                  }
                : undefined
            }
          >
            Unified
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto diff-view-host">
        {highlighter ? (
          <DiffView
            data={{
              oldFile: {
                fileName: oldName,
                content: diffData.old_content,
                fileLang: lang,
              },
              newFile: {
                fileName: newName,
                content: diffData.new_content,
                fileLang: lang,
              },
              hunks: [diffString],
            }}
            // 黑曜石主题 —— DiffView 内部会切到 github-dark 高亮
            diffViewTheme="dark"
            diffViewMode={mode}
            diffViewHighlight={true}
            registerHighlighter={highlighter}
          />
        ) : (
          <div className="p-4 text-ink-muted text-sm">
            初始化语法高亮...
          </div>
        )}
      </div>
    </div>
  );
}