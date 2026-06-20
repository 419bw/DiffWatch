import { useEffect, useMemo, useState } from "react";
import { pickRepoDir, readDirectory } from "../lib/tauri";
import type { GitFile, FileEntry, TreeItem } from "../types";

interface SidebarProps {
  repoPath: string | null;
  files: GitFile[];
  selectedFile: string | null;
  onSelectRepo: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
  onStageFile: (path: string) => void;
  onDiscardFile: (path: string, status: string) => void;
  loading: boolean;
}

// === 状态徽章:细体字母(无 blur / 无 contrast / 无 shadow) ===
const STATUS_LETTER: Record<string, string> = {
  modified: "M",
  untracked: "U",
  deleted: "D",
  staged: "S",
  renamed: "R",
  typechange: "T",
};

const STATUS_COLOR: Record<string, string> = {
  modified: "text-neon-green",
  untracked: "text-neon-lime",
  deleted: "text-neon-red",
  staged: "text-neon-cyan",
  renamed: "text-neon-green",
  typechange: "text-neon-green",
};

// 脏文件夹冒泡状态:modified 表示子树含 git-tracked 变更(M/S/R/T/D),
// untracked 表示子树含未追踪文件
type BubbleKind = "modified" | "untracked";

// 把 FileEntry 数组映射成 TreeItem 数组(初始全部折叠、未加载)
const toTreeItems = (entries: FileEntry[]): TreeItem[] =>
  entries.map((e) => ({
    ...e,
    isOpen: false,
    isLoaded: false,
  }));

export default function Sidebar({
  repoPath,
  files,
  selectedFile,
  onSelectRepo,
  onSelectFile,
  onRefresh,
  onStageFile,
  onDiscardFile,
  loading,
}: SidebarProps) {
  const [picking, setPicking] = useState(false);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  // === 派生:把 CHANGES 的脏路径冒泡到祖先文件夹 + 文件自身 ===
  // map 的 key 是节点绝对路径(文件夹或文件,与 TreeItem.path 同形),
  // value 是要展示的气泡颜色
  // modified 胜出冲突(已纳入 git 追踪 > 未追踪);算法从 i=1 起跳,
  // 天然排除根目录;循环到 i <= parts.length 把文件自身也带上
  const dirtyNodes = useMemo(() => {
    if (!repoPath) return new Map<string, BubbleKind>();
    const root = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const map = new Map<string, BubbleKind>();
    for (const f of files) {
      const kind: BubbleKind = f.status === "untracked" ? "untracked" : "modified";
      const parts = f.path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const abs = root + "/" + parts.slice(0, i).join("/");
        if (map.get(abs) !== "modified") map.set(abs, kind);
      }
    }
    return map;
  }, [files, repoPath]);

  // === 初始化流:repoPath 变化时,read_directory(repoPath) 拿根目录第一层 ===
  useEffect(() => {
    if (!repoPath) {
      setTree([]);
      setTreeError(null);
      return;
    }
    let cancelled = false;
    setTreeLoading(true);
    setTreeError(null);
    readDirectory(repoPath)
      .then((entries) => {
        if (!cancelled) {
          setTree(toTreeItems(entries));
          setTreeError(null);
        }
      })
      .catch((e) => {
        console.error("readDirectory 失败", e);
        if (!cancelled) {
          setTree([]);
          setTreeError(String(e?.message ?? e));
        }
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // === 按需加载流:点击文件夹 ===
  // - 若 isLoaded,只切 isOpen(秒开)
  // - 若 !isLoaded,异步拉子节点,挂到 children,再切 isOpen
  const toggleNode = async (targetPath: string) => {
    const findAndUpdate = (
      nodes: TreeItem[],
    ): { next: TreeItem[]; target: TreeItem | null } => {
      let found: TreeItem | null = null;
      const next = nodes.map((n) => {
        if (n.path === targetPath) {
          found = n;
          return n;
        }
        if (n.children) {
          const r = findAndUpdate(n.children);
          if (r.target) found = r.target;
          return { ...n, children: r.next };
        }
        return n;
      });
      return { next, target: found };
    };

    const { target } = findAndUpdate(tree);
    if (!target) return;

    // 已经加载过 → 只切 open/close
    if (target.isLoaded) {
      const flip = (nodes: TreeItem[]): TreeItem[] =>
        nodes.map((n) => {
          if (n.path === targetPath) return { ...n, isOpen: !n.isOpen };
          if (n.children) return { ...n, children: flip(n.children) };
          return n;
        });
      setTree(flip(tree));
      return;
    }

    // 未加载 → 立刻折叠收起,异步加载完成后展开
    const closeFirst = (nodes: TreeItem[]): TreeItem[] =>
      nodes.map((n) => {
        if (n.path === targetPath) return { ...n, isOpen: false };
        if (n.children) return { ...n, children: closeFirst(n.children) };
        return n;
      });
    setTree(closeFirst(tree));

    try {
      const entries = await readDirectory(targetPath);
      const children = toTreeItems(entries);
      const markLoaded = (nodes: TreeItem[]): TreeItem[] =>
        nodes.map((n) => {
          if (n.path === targetPath) {
            return { ...n, children, isLoaded: true, isOpen: true };
          }
          if (n.children) return { ...n, children: markLoaded(n.children) };
          return n;
        });
      setTree((prev) => markLoaded(prev));
    } catch (e) {
      console.error("readDirectory 子节点失败", e);
    }
  };

  const handlePickRepo = async () => {
    setPicking(true);
    try {
      const path = await pickRepoDir();
      if (path) onSelectRepo(path);
    } catch (e) {
      console.error("选仓库失败", e);
    } finally {
      setPicking(false);
    }
  };

  return (
    // Sidebar 外壳:h-full flex flex-col,父容器已带 border-r border-white/5
    <aside className="h-full flex flex-col bg-[#0B0F17]/40">
      {/* === 顶部按钮行:横向并排,无图标,纯文字,gel-box 黑冰质感 === */}
      <div className="flex flex-row w-full gap-2 px-4 pt-4 pb-3">
        <button
          onClick={handlePickRepo}
          disabled={picking}
          className="gel-box rounded-xl flex-1 h-8 text-xs font-bold text-ink-base
                     flex items-center justify-center disabled:opacity-50
                     hover:text-white transition-colors"
        >
          {picking ? "选择中…" : "选择仓库"}
        </button>
        <button
          onClick={onRefresh}
          disabled={!repoPath || loading}
          className="gel-box rounded-xl flex-1 h-8 text-xs font-bold text-ink-base
                     flex items-center justify-center disabled:opacity-40
                     hover:text-white transition-colors"
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {/* === Section 1:WORKSPACE(懒加载目录树) === */}
      <SectionHeader label="Workspace" />
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 py-1">
        {!repoPath ? (
          <div className="px-2 py-3 text-[11px] text-gray-500">
            请先选择仓库
          </div>
        ) : treeError ? (
          <div
            className="px-2 py-3 text-[11px] text-neon-red break-all"
            title={treeError}
          >
            错误:{treeError}
          </div>
        ) : treeLoading && tree.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-gray-500">加载中…</div>
        ) : tree.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-gray-500">空目录</div>
        ) : (
          tree.map((n) => (
            <TreeNodeView
              key={n.path}
              node={n}
              depth={0}
              onToggle={toggleNode}
              dirtyNodes={dirtyNodes}
            />
          ))
        )}
      </div>

      {/* === Section 2:CHANGES(变更文件) === */}
      <SectionHeader label="Changes" />
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 py-1">
        {files.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-gray-500">
            {repoPath ? (loading ? "加载中…" : "无变更") : "—"}
          </div>
        ) : (
          <ul>
            {files.map((f) => {
              const isSelected = selectedFile === f.path;
              return (
                <li
                  key={f.path}
                  onClick={() => onSelectFile(f.path)}
                  className={`group flex items-center h-6 px-2 text-[12px] font-mono rounded-sm cursor-pointer
                    ${
                      isSelected
                        ? "bg-white/[0.06] text-white"
                        : "text-ink-base hover:text-white hover:bg-white/[0.03]"
                    }`}
                  title={f.path}
                >
                  {/* 文件名 — min-w-0 让 truncate 在 flex 中正确生效 */}
                  <span className="truncate flex-1 min-w-0">{f.path}</span>

                  {/* 默认状态字母 — hover 时淡出,保留 20px 布局空间避免按钮跳位 */}
                  <span
                    className={`flex-shrink-0 ml-2 text-[10px] font-bold w-3 text-center transition-opacity duration-75
                      group-hover:opacity-0 ${
                      STATUS_COLOR[f.status] ?? "text-ink-muted"
                    }`}
                  >
                    {STATUS_LETTER[f.status] ?? "?"}
                  </span>

                  {/* Hover 动作条 — flex 子项,展开时把文件名往左挤,绝不覆盖 */}
                  <div className="flex-shrink-0 ml-0 group-hover:ml-2 max-w-0 group-hover:max-w-[160px] overflow-hidden opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-all duration-75 flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStageFile(f.path);
                      }}
                      title="暂存此改动"
                      className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 leading-none px-0.5 whitespace-nowrap"
                    >
                      ✓ Stage
                    </button>
                    <span className="text-ink-muted/40 text-[10px]">|</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscardFile(f.path, f.status);
                      }}
                      title="丢弃此改动"
                      className="text-[10px] font-bold text-red-400 hover:text-red-300 leading-none px-0.5 whitespace-nowrap"
                    >
                      ✕ Discard
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

// === 树节点视图(递归):每层 ml-4 缩进,文件夹用 ▸/▾ 三角 ===
function TreeNodeView({
  node,
  depth,
  onToggle,
  dirtyNodes,
}: {
  node: TreeItem;
  depth: number;
  onToggle: (path: string) => void;
  dirtyNodes: Map<string, BubbleKind>;
}) {
  // 文件夹 + 文件节点都查:map 里既有祖先文件夹也有文件自身
  const bubble = dirtyNodes.get(node.path);
  const baseText =
    bubble === "modified"
      ? "text-emerald-500/80"
      : bubble === "untracked"
      ? "text-amber-500/80"
      : "text-ink-base";
  const hoverText =
    bubble === "modified"
      ? "hover:text-emerald-400"
      : bubble === "untracked"
      ? "hover:text-amber-400"
      : "hover:text-white";

  return (
    <div>
      <div
        className={`flex items-center h-5 text-[12px] font-mono ${baseText} ${hoverText} cursor-pointer`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={node.is_dir ? () => onToggle(node.path) : undefined}
        title={node.path}
      >
        <span className="w-3 text-ink-muted text-[10px]">
          {node.is_dir ? (node.isOpen ? "▾" : "▸") : ""}
        </span>
        <span className="truncate">{node.name}</span>
      </div>
      {node.isOpen &&
        node.children?.map((child) => (
          <TreeNodeView
            key={child.path}
            node={child}
            depth={depth + 1}
            onToggle={onToggle}
            dirtyNodes={dirtyNodes}
          />
        ))}
    </div>
  );
}

// 面板小标题 —— WORKSPACE / CHANGES
function SectionHeader({ label }: { label: string }) {
  return (
    <div
      className="px-4 py-1.5 text-[11px] font-semibold tracking-wider uppercase
                 text-gray-500 border-t border-white/5 flex-shrink-0"
    >
      {label}
    </div>
  );
}