import { useEffect, useMemo, useRef, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { processAST } from "@git-diff-view/shiki";
import type { DiffHighlighter } from "@git-diff-view/shiki";
import { createHighlighter } from "shiki";
import { createTwoFilesPatch } from "diff";
import "@git-diff-view/react/styles/diff-view.css";
import { getFileContent, patchFileLine, readWorkspaceFile } from "../lib/tauri";
import type { FileDiffData } from "../types";

// 自建 shiki highlighter —— 直接走 defaultColor: true,产出内联 color:#xxx,
// 绕开 @git-diff-view/shiki 默认的 cssVariablePrefix 模式(CSS 变量方案在 split
// 模式下右栏不稳)。语言集覆盖 src-tauri/src/git_ops.rs::guess_lang 全部返回值
// 加上前端的 "text" fallback 与几个保险 lang。
// shiki 的 langs 接受 (BundledLanguage | SpecialLanguage),用宽松 string[] 类型避免 TS 联合类型严格报错
const SHIKI_LANGS: string[] = [
  // guess_lang 全部 id
  "typescript", "javascript", "tsx", "jsx",
  "rust", "python", "go", "java", "c", "cpp", "csharp",
  "ruby", "php", "kotlin", "swift", "scala",
  "bash", "powershell",
  "json", "yaml", "toml", "xml",
  "html", "css", "scss", "less", "markdown",
  "sql", "lua", "vue", "svelte", "dockerfile",
  // 前端 fallback("text" 是 SpecialLanguage,shiki v3 的 PlainTextLanguage) + 保险 lang
  "text", "diff", "astro",
];

const buildInlineHighlighter = async (): Promise<DiffHighlighter> => {
  const shikiHighlighter = await createHighlighter({
    themes: ["github-dark"],
    langs: SHIKI_LANGS,
  });
  return {
    name: "shiki-inline",
    // "style" 而非 "class":@git-diff-view/react 的 getSyntaxDiffTemplate 对
    // type === "class" 会缓存模板(用 syntaxTemplateName 比对);"style" 每次重
    // 建,确保 split 两侧的 inner-span 颜色都生效
    type: "style",
    maxLineToIgnoreSyntax: 2000,
    setMaxLineToIgnoreSyntax: () => {},
    ignoreSyntaxHighlightList: [],
    setIgnoreSyntaxHighlightList: () => {},
    getAST: (raw, _fileName, lang) => {
      try {
        return shikiHighlighter.codeToHast(raw, {
          lang: (lang ?? "text") as any,
          theme: "github-dark",
          // 关键:defaultColor 接受 true(运行时 truthy 走内联 color),
          // 但 TS 类型只允许 false|"light"|"dark"|"light-dark()"。运行时 true
          // 会产出 inline color:#xxx,完全绕开 CSS 变量路径,避免 split 右栏丢色
          defaultColor: true as any,
          mergeWhitespaces: false,
        });
      } catch (e) {
        // 未知 lang 等场景静默降级,DiffFile 那边有 if (!this.ast) return 兜底
        console.warn("[DiffPanel] shiki codeToHast failed:", e);
        return undefined as any;
      }
    },
    processAST,
    hasRegisteredCurrentLang: (lang) =>
      shikiHighlighter.getLoadedLanguages().includes(lang),
    getHighlighterEngine: () => shikiHighlighter as any,
  };
};

interface DiffPanelProps {
  repoPath: string;
  filePath: string;
  /** 外部文件变更计数器 —— App.tsx 在 repo-changed 时 +1,触发 diff 重拉 */
  refreshKey: number;
  /** Viewer 模式路径(只读查看)—— 与 filePath 互斥,任一时刻只有一个非空 */
  viewerPath: string | null;
  /** Viewer 模式重拉信号 —— App.tsx 在 patch 落盘后 +1,触发 viewer effect 重读 */
  viewerRefreshKey: number;
}

export default function DiffPanel({
  repoPath,
  filePath,
  refreshKey,
  viewerPath,
  viewerRefreshKey,
}: DiffPanelProps) {
  const [highlighter, setHighlighter] = useState<DiffHighlighter | null>(null);
  const [diffData, setDiffData] = useState<FileDiffData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);

  // === Viewer 模式 state(viewer 三件套,与 diff 模式完全互斥) ===
  const [viewerContent, setViewerContent] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null); // "BINARY" 或其他错误消息

  // 初始化 shiki highlighter（只跑一次）—— 用自建 buildInlineHighlighter
  // 走 defaultColor: true,产出内联 color:#xxx,绕开 @git-diff-view/shiki
  // 默认 cssVariablePrefix 方案在 split 模式右栏不稳的 bug
  useEffect(() => {
    let mounted = true;
    buildInlineHighlighter().then((h) => {
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

  // === Viewer 模式 fetch —— viewerPath 变化时拉文件,清空时立即释放 viewer content 触发 GC ===
  useEffect(() => {
    if (!viewerPath) {
      // 切走 viewer → 一次性清空所有 viewer state,让 V8 GC 立刻回收老字符串
      setViewerContent(null);
      setViewerError(null);
      setViewerLoading(false);
      return;
    }
    let cancelled = false;
    setViewerLoading(true);
    setViewerError(null);
    setViewerContent(null);
    readWorkspaceFile(viewerPath)
      .then((c) => {
        if (!cancelled) setViewerContent(c);
      })
      .catch((e) => {
        if (!cancelled) {
          const msg = String(e);
          // BINARY_FILE_DETECTED 是后端约定字符串,转为 "BINARY" 标记
          setViewerError(msg.includes("BINARY_FILE_DETECTED") ? "BINARY" : msg);
        }
      })
      .finally(() => {
        if (!cancelled) setViewerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerPath, viewerRefreshKey]);

  // === Viewer 模式优先(viewerPath 非空时,完全不渲染 diff 模式分支) ===
  if (viewerPath) {
    const viewerHeader = (
      <div className="px-4 py-2 flex items-center flex-shrink-0 border-b border-[#262B37]">
        <div className="text-sm font-bold text-ink-base truncate flex-1 min-w-0 font-mono" title={viewerPath}>
          {viewerPath}
        </div>
      </div>
    );
    if (viewerLoading) {
      return (
        <div className="flex flex-col h-full bg-[#0A0D14]">
          {viewerHeader}
          <div className="flex items-center justify-center flex-1 text-ink-muted">加载中…</div>
        </div>
      );
    }
    if (viewerError === "BINARY") {
      return (
        <div className="flex flex-col h-full bg-[#0A0D14]">
          {viewerHeader}
          <BinaryPlaceholder />
        </div>
      );
    }
    if (viewerError) {
      return (
        <div className="flex flex-col h-full bg-[#0A0D14]">
          {viewerHeader}
          <div className="flex items-center justify-center flex-1 text-neon-red p-4">
            <div className="text-center">
              <div className="text-lg mb-2">❌ 错误</div>
              <div className="text-sm font-mono">{viewerError}</div>
            </div>
          </div>
        </div>
      );
    }
    if (viewerContent !== null) {
      return (
        <div className="flex flex-col h-full bg-[#0A0D14]">
          {viewerHeader}
          <VirtualFileViewer
            content={viewerContent}
            repoPath={repoPath}
            filePath={viewerPath}
          />
        </div>
      );
    }
  }

  // === 以下为原 diff 模式(行为不变) ===
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0A0D14] text-ink-muted">
        加载中...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0A0D14] text-neon-red p-4">
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
      <div className="flex items-center justify-center h-full bg-[#0A0D14] text-ink-muted">
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
      <div className="flex items-center justify-center h-full bg-[#0A0D14] text-ink-muted p-4 text-sm">
        {isUntracked ? "新文件,无历史版本" : "文件无变更"}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0A0D14]">
      {/* 顶部工具栏:工业紧凑,纯 Tailwind 工具类 + Segmented Control */}
      <div className="px-4 py-2 flex items-center justify-between flex-shrink-0 border-b border-[#262B37]">
        <div
          className="text-sm font-bold text-ink-base truncate flex-1 min-w-0 font-mono"
          title={filePath}
        >
          {filePath}
        </div>
        <div className="flex bg-[#13161C] border border-[#262B37] rounded-sm
                       p-0.5 flex-shrink-0 items-center">
          <button
            onClick={() => setMode(DiffModeEnum.SplitGitHub)}
            className={`px-2 py-0.5 text-[11px] font-medium rounded-sm transition-colors ${
              mode === DiffModeEnum.SplitGitHub
                ? "bg-[#1C1F26] text-white shadow-sm"
                : "text-gray-500 hover:text-zinc-300"
            }`}
          >
            Split
          </button>
          <button
            onClick={() => setMode(DiffModeEnum.Unified)}
            className={`px-2 py-0.5 text-[11px] font-medium rounded-sm transition-colors ${
              mode === DiffModeEnum.Unified
                ? "bg-[#1C1F26] text-white shadow-sm"
                : "text-gray-500 hover:text-zinc-300"
            }`}
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

// === Viewer 子组件 1:虚拟滚动纯文本查看器(支持就地单行修补) ===
// 行高固定 24px = h-6,只渲染视窗可见行 + 上下各 10 行 buffer
// ResizeObserver 监听容器高度,浏览器窗口大小变化时自动重算可见行数
// 双击任意行 → 行内 input → Enter 落盘(patch_file_line) → 全局 refresh 重拉
function VirtualFileViewer({
  content,
  repoPath,
  filePath,
}: {
  content: string;
  repoPath: string;
  filePath: string;
}) {
  const LINE_HEIGHT = 24; // h-6 = 24px,与 Tailwind h-6 对齐
  const BUFFER = 10; // 上下各多渲染 10 行,滚到边缘不空白

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // === 单行编辑态 ===
  const [editingLineIdx, setEditingLineIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  // 拆分行为常驻内存(几百 KB 文本 split 后 ~几 MB,可控)
  const lines = useMemo(() => content.split("\n"), [content]);
  const totalH = lines.length * LINE_HEIGHT;

  // 可见区间计算
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - BUFFER);
  const visibleCount = Math.ceil(containerH / LINE_HEIGHT) + BUFFER * 2;
  const endIdx = Math.min(lines.length, startIdx + visibleCount);

  // padding 占位让滚动条反映真实高度
  const paddingTop = startIdx * LINE_HEIGHT;
  const paddingBottom = Math.max(0, totalH - endIdx * LINE_HEIGHT);

  // ResizeObserver 监听容器高度变化
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight));
    ro.observe(el);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 切换文件时强制清空编辑态(避免跨文件残留)
  useEffect(() => {
    setEditingLineIdx(null);
    setEditingText("");
  }, [filePath]);

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="flex-1 overflow-auto bg-[#0A0D14] font-mono text-[12px] text-zinc-300"
    >
      <div style={{ height: paddingTop }} />
      {lines.slice(startIdx, endIdx).map((line, i) => {
        const idx = startIdx + i;
        const isEditing = idx === editingLineIdx;
        return (
          <div
            key={idx}
            className="flex h-6 hover:bg-white/[0.02] group"
            onDoubleClick={() => {
              if (isEditing) return;
              setEditingLineIdx(idx);
              setEditingText(line);
            }}
          >
            <span className="w-12 flex-shrink-0 text-right pr-3 text-zinc-600 select-none">
              {idx + 1}
            </span>
            {isEditing ? (
              <input
                autoFocus
                type="text"
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const saved = editingText;
                    setEditingLineIdx(null); // 立即关闭编辑态(视觉秒级响应)
                    try {
                      // 1-indexed 转换:idx (0-indexed) + 1
                      await patchFileLine(repoPath, filePath, idx + 1, saved);
                      // 触发全局 refresh —— 刷新 git status + viewer 内容
                      window.__REFRESH_GLOBAL__?.();
                    } catch (err) {
                      console.error("[LinePatch] 落盘失败:", err);
                    }
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingLineIdx(null);
                    setEditingText("");
                  }
                }}
                onBlur={() => {
                  // 失焦自动取消编辑(避免 input 残留半截内容)
                  setEditingLineIdx(null);
                  setEditingText("");
                }}
                className="flex-1 bg-[#202430] border border-zinc-700 text-zinc-200
                           text-[12px] font-mono px-1.5 py-0 rounded
                           outline-none h-5"
              />
            ) : (
              <span className="flex-1 whitespace-pre pl-2 leading-6">
                {line || " "}
              </span>
            )}
          </div>
        );
      })}
      <div style={{ height: paddingBottom }} />
    </div>
  );
}

// === Viewer 子组件 2:二进制文件占位 ===
function BinaryPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 text-zinc-500 gap-3">
      <div className="text-5xl opacity-40">📁</div>
      <div className="text-sm">二进制文件,请双击唤醒外部编辑器查看</div>
    </div>
  );
}