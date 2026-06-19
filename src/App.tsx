import { useCallback, useState } from "react";
import Sidebar from "./components/Sidebar";
import DiffPanel from "./components/DiffPanel";
import EmptyState from "./components/EmptyState";
import { getGitStatus } from "./lib/tauri";
import type { GitFile } from "./types";

export default function App() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    // Full-Bleed 骨架:零 padding / 零 gap / 零圆角
    // 屏幕四边直接贴 body 的暗色微光网格背景
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
          <DiffPanel repoPath={repoPath} filePath={selectedFile} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}