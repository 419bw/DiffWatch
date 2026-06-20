import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Sidebar from "./components/Sidebar";
import DiffPanel from "./components/DiffPanel";
import EmptyState from "./components/EmptyState";
import {
  getGitStatus,
  startWatching,
  stopWatching,
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
      <div className="w-[300px] flex-shrink-0 h-full border-r border-white/5">
        <Sidebar
          repoPath={repoPath}
          files={files}
          selectedFile={selectedFile}
          onSelectRepo={handleSelectRepo}
          onSelectFile={setSelectedFile}
          onRefresh={() => refresh()}
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