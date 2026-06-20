import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Sidebar from "./components/Sidebar";
import DiffPanel from "./components/DiffPanel";
import EmptyState from "./components/EmptyState";
import {
  confirmDiscard,
  discardFile,
  getGitStatus,
  stageFile,
  startWatching,
  stopWatching,
  unstageFile,
} from "./lib/tauri";
import type { GitFile } from "./types";

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * 外部文件变更时 +1,作为 DiffPanel 的 useEffect 依赖,触发 diff 重拉。
   * App.tsx 收到 repo-changed 后,若 payload 含当前选中文件就 bump 它。
   */
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);

  const refresh = useCallback(
    async (path: string | null = repoPath) => {
      if (!path) return;
      setLoading(true);
      try {
        const list = await getGitStatus(path);
        setFiles(list);
      } catch (e) {
        console.error("getGitStatus 失败", e);
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [repoPath]
  );

  const handleSelectRepo = (path: string) => {
    setRepoPath(path);
    setSelectedFile(null);
    refresh(path);
  };

  // === Stage / Discard 操作闭环 ===
  // 手动 refresh() 是立即的兜底,watcher 的 repo-changed 几百毫秒后也会再触发一次,
  // 两次拉取无害(React 引用未变则跳过 re-render)
  const handleStageFile = useCallback(
    async (filePath: string) => {
      if (!repoPath) return;
      try {
        await stageFile(repoPath, filePath);
        refresh();
      } catch (e) {
        console.error("stage 失败", e);
      }
    },
    [repoPath, refresh]
  );

  const handleDiscardFile = useCallback(
    async (filePath: string, status: string) => {
      if (!repoPath) return;
      const yes = await confirmDiscard(filePath);
      if (!yes) return;
      try {
        await discardFile(repoPath, filePath, status);
        // 丢弃的是当前正在看的文件 → 清空选择(否则 DiffPanel 会去拉不存在的文件)
        setSelectedFile((cur) => (cur === filePath ? null : cur));
        refresh();
      } catch (e) {
        console.error("discard 失败", e);
      }
    },
    [repoPath, refresh]
  );

  // === Commit 完成后 refresh + 清空选中(diff 已落地 HEAD,旧内容不再有意义) ===
  const handleCommitDone = useCallback(() => {
    refresh();
    setSelectedFile(null);
  }, [refresh]);

  // === Unstage 操作 — 把文件从暂存区撤回,refresh 后自动归位到 CHANGES tab ===
  const handleUnstageFile = useCallback(
    async (filePath: string) => {
      if (!repoPath) return;
      try {
        await unstageFile(repoPath, filePath);
        refresh();
      } catch (e) {
        console.error("unstage 失败", e);
      }
    },
    [repoPath, refresh]
  );

  // === repoPath 变化时,启停 watchdog ===
  useEffect(() => {
    if (!repoPath) {
      stopWatching().catch(() => {});
      return;
    }
    startWatching(repoPath).catch((e) =>
      console.error("startWatching 失败", e)
    );
    // 卸载 / 切换 repoPath 时停掉旧的(debouncer 句柄在 Rust 端被新 watcher 替换)
    return () => {
      // 注意:这里不需要主动 stop_watching,因为下次 start_watching 会 drop 旧的
    };
  }, [repoPath]);

  // === 监听 repo-changed 事件 ===
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const u = await listen<{ paths: string[] }>(
        "repo-changed",
        (event) => {
          const paths = event.payload?.paths ?? [];
          if (paths.length === 0) return;
          // 总是刷新 status 列表(便宜,O(repo 大小))
          refresh();
          // 若当前选中文件被修改,触发 diff 重拉
          setSelectedFile((currentSelected) => {
            if (!currentSelected) return currentSelected;
            const touched = paths.some(
              (p) =>
                p === currentSelected ||
                p.endsWith("/" + currentSelected) ||
                p.endsWith("\\" + currentSelected)
            );
            if (touched) setDiffRefreshKey((k) => k + 1);
            return currentSelected;
          });
        }
      );
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  return (
    // Full-Bleed 骨架:零 padding / 零 gap / 零圆角
    <div className="h-screen w-screen flex">
      {/* 左栏:固定 300px,自带右边框作硬朗分割线 */}
      <div className="w-[300px] flex-shrink-0 h-full border-r border-[#262B37]">
        <Sidebar
          repoPath={repoPath}
          files={files}
          selectedFile={selectedFile}
          onSelectRepo={handleSelectRepo}
          onSelectFile={setSelectedFile}
          onRefresh={() => refresh()}
          onStageFile={handleStageFile}
          onDiscardFile={handleDiscardFile}
          onUnstageFile={handleUnstageFile}
          onCommitDone={handleCommitDone}
          loading={loading}
        />
      </div>

      {/* 右栏:吃满剩余宽度,无圆角无内边距,直接展示代码 */}
      <main className="flex-1 min-w-0 h-full overflow-hidden">
        {repoPath && selectedFile ? (
          <DiffPanel
            repoPath={repoPath}
            filePath={selectedFile}
            refreshKey={diffRefreshKey}
          />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}