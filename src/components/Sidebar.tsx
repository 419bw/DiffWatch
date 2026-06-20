import { useEffect, useMemo, useRef, useState } from "react";
import picomatch from "picomatch";
import { message } from "@tauri-apps/plugin-dialog";
import {
  executeCommit,
  getStagedDiff,
  parseGitignore,
  pickRepoDir,
  readDirectory,
} from "../lib/tauri";
import {
  AI_DEFAULTS,
  generateCommitMessage,
  STORAGE_KEYS as AI_STORAGE_KEYS,
} from "../lib/ai";
import type { GitFile, FileEntry, IgnorePattern, TreeItem } from "../types";

interface SidebarProps {
  repoPath: string | null;
  files: GitFile[];
  selectedFile: string | null;
  onSelectRepo: (path: string) => void;
  onSelectFile: (path: string) => void;
  onReadOnlyFile: (path: string) => void;
  onOpenInVscode: (path: string) => void;
  onRefresh: () => void;
  onStageFile: (path: string) => void;
  onDiscardFile: (path: string, status: string) => void;
  onUnstageFile: (path: string) => void;
  onCommitDone: () => void;
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

// === WAAPI 离场助手:把行盒子坍塌到 0 高度 + 透明 + 微缩,onfinish 由浏览器合成线程触发 ===
// 好处:不依赖 React state、不受 setState batching/并发模式影响、精度 ±1ms。
//      fill: 'forwards' 让元素停在终态,调用方在 onFinish 里负责 row.remove()。
function animateExit(rowEl: HTMLElement, onFinish: () => void) {
  const anim = rowEl.animate(
    [
      { height: "26px", opacity: 1, transform: "scale(1)" },
      { height: "0px", opacity: 0, transform: "scale(0.95)" },
    ],
    { duration: 200, easing: "ease-out", fill: "forwards" }
  );
  anim.onfinish = onFinish;
}

// 脏文件夹冒泡状态:modified 表示子树含 git-tracked 变更(M/S/R/T/D),
// untracked 表示子树含未追踪文件
type BubbleKind = "modified" | "untracked";

// === AI Commit 栏内联图标与小组件 ===

// 极简齿轮图标 14×14
const GearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// 极简 sparkles 图标 14×14
const SparklesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

// 极简刷新图标 12×12 —— 沿用 GearIcon 风格规范;支持 className 传入 animate-spin
const RefreshIcon = ({ className = "" }: { className?: string }) => (
  <svg
    width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    className={className}
  >
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>
);

// 极简文件夹图标 13×13 —— 被调用处可通过 className 注入 opacity-40
const FolderIcon = ({ className = "" }: { className?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round"
       className={`text-zinc-500 flex-shrink-0 ${className}`}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
  </svg>
);

// 极简文件图标 13×13
const FileIcon = ({ className = "" }: { className?: string }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round"
       className={`text-zinc-500/80 flex-shrink-0 ${className}`}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

// 14×14 空心 chevron —— 折叠态 >,展开时 90° 旋转成 v;
// 默认 zinc-400 + 行 hover 变白,跟文件夹 hover 状态联动
const ChevronIcon = ({
  expanded,
  className = "",
}: {
  expanded: boolean;
  className?: string;
}) => (
  <svg
    width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    className={`text-zinc-400 group-hover:text-white flex-shrink-0 transition-all duration-150 ${
      expanded ? "rotate-90" : ""
    } ${className}`}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// AI 加载三点动画
const LoadingDots = () => (
  <span className="inline-flex gap-0.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="w-1 h-1 rounded-full bg-current animate-pulse"
        style={{ animationDelay: `${i * 150}ms` }}
      />
    ))}
  </span>
);

// AI 设置抽屉的小字段(Label + Input 同行)
const Field = ({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) => (
  <div className="flex items-center gap-2">
    <label className="text-[11px] text-gray-500 w-20 flex-shrink-0">
      {label}
    </label>
    <input
      ref={inputRef}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 min-w-0 bg-[#202430] border border-[#262B37] rounded
                 px-2 py-1 text-[11px] font-mono text-ink-base
                 placeholder:text-ink-muted focus:outline-none focus:border-[#3A4050]"
    />
  </div>
);

// 把 FileEntry 数组映射成 TreeItem 数组(初始全部折叠、未加载)
const toTreeItems = (entries: FileEntry[]): TreeItem[] =>
  entries.map((e) => ({
    ...e,
    isOpen: false,
    isLoaded: false,
  }));

// === 收集所有"已展开 且 已加载"的文件夹节点(递归深入其 children) ===
// 用于在 watcher 触发刷新时,精准定位需要重新扫描的目录
const collectExpandedLoadedDirs = (nodes: TreeItem[]): TreeItem[] => {
  const dirs: TreeItem[] = [];
  const walk = (ns: TreeItem[]) => {
    for (const n of ns) {
      if (n.isOpen && n.isLoaded && n.children) {
        dirs.push(n);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return dirs;
};

// === 用 fresh 作为"内容"真相源,递归合并到 prev,保留 isOpen/isLoaded/已加载子树 ===
// - fresh 里有,prev 里也有 → 保留状态;若双方都有 children,继续递归合并
// - fresh 里有,prev 里没有 → 新增,默认折叠未加载
// - prev 里有,fresh 里没有 → 丢弃(文件/文件夹被删)
//
// freshMap:每个"已展开目录"的最新 children 内容,merge 时按路径查询递归展开
const mergeTreeRecursive = (
  prev: TreeItem[],
  fresh: TreeItem[],
  freshMap: Map<string, TreeItem[]>,
): TreeItem[] => {
  return fresh.map((fItem) => {
    const prevItem = prev.find((p) => p.path === fItem.path);
    if (!prevItem) return fItem;

    const freshChildren = freshMap.get(fItem.path);
    const prevChildren = prevItem.children;

    if (freshChildren && prevChildren) {
      return {
        ...fItem,
        isOpen: prevItem.isOpen,
        isLoaded: prevItem.isLoaded,
        children: mergeTreeRecursive(prevChildren, freshChildren, freshMap),
      };
    }

    // 此目录没拿到 fresh 内容(不在 expanded 列表里) —— 保留 prev 的 children
    return {
      ...fItem,
      isOpen: prevItem.isOpen,
      isLoaded: prevItem.isLoaded,
      children: prevChildren,
    };
  });
};

export default function Sidebar({
  repoPath,
  files,
  selectedFile,
  onSelectRepo,
  onSelectFile,
  onReadOnlyFile,
  onOpenInVscode,
  onRefresh,
  onStageFile,
  onDiscardFile,
  onUnstageFile,
  onCommitDone,
  loading,
}: SidebarProps) {
  const [picking, setPicking] = useState(false);
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  // 🌟 核心防御:treeRef 永远映射最新树结构,切断 useEffect 闭包陷阱 + 死循环
  // - tree 不进 [repoPath, files] deps,避免 setTree → 自身重跑 → CPU 烧光
  // - 读 tree 时走 treeRef.current,绕过闭包过期问题
  const treeRef = useRef<TreeItem[]>(tree);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  // 跟踪上次扫描的 repo —— 区分"repo 切换的初始加载"和"files 变化的刷新合并"
  const lastScannedRepoRef = useRef<string | null>(null);

  // === .gitignore 解析结果 —— Tree 节点 dim 渲染的唯一真相源 ===
  // repoPath 变化时拉一次,后续所有 tree 节点都通过 ignoreMatcher(node.path) 判断
  const [ignorePatterns, setIgnorePatterns] = useState<IgnorePattern[]>([]);
  useEffect(() => {
    if (!repoPath) {
      setIgnorePatterns([]);
      return;
    }
    let cancelled = false;
    parseGitignore(repoPath)
      .then((patterns) => {
        if (!cancelled) setIgnorePatterns(patterns);
      })
      .catch((e) => {
        console.error("parse_gitignore 失败", e);
        if (!cancelled) setIgnorePatterns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  // === 把 gitignore 语义翻译成 picomatch 匹配的 matcher(双轨 glob 扩展) ===
  // 关键陷阱防御:picomatch 的 matchBase 只比对路径最后一段 basename,
  // 会让"target/debug/main.d"这种嵌套子节点逃过 ignore。
  // 这里每个 pattern 拆成两条:自身一条 + 递归子孙一条,还原"一人得道全家变灰"。
  const ignoreMatcher = useMemo(() => {
    const expanded = ignorePatterns.flatMap((p) => {
      const isUnanchored = !p.pattern.includes("/");
      if (isUnanchored) {
        // 未锚定项(target / node_modules / HANDOFF.md 等):
        // 任意层级下的同名节点 + 它的所有子孙
        return [
          { test: picomatch(`**/${p.pattern}`, { dot: true }), negated: p.negated },
          { test: picomatch(`**/${p.pattern}/**`, { dot: true }), negated: p.negated },
        ];
      }
      // 已锚定项(如 src/generated/):从仓库根锚定 + 它的所有子孙
      return [
        { test: picomatch(p.pattern, { dot: true }), negated: p.negated },
        { test: picomatch(`${p.pattern}/**`, { dot: true }), negated: p.negated },
      ];
    });

    return (nodePath: string) => {
      let ignored = false;
      // gitignore 语义:后面的规则覆盖前面,! 取消之前的 ignore
      for (const m of expanded) {
        if (m.test(nodePath)) ignored = !m.negated;
      }
      return ignored;
    };
  }, [ignorePatterns]);

  // === AI Commit 栏 state ===
  const [commitMessage, setCommitMessage] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // === 双选项卡 ===
  type Tab = "changes" | "staged";
  const [activeTab, setActiveTab] = useState<Tab>("changes");

  // 单源数据流:files prop 包含全部已暂存+未暂存,客户端分流
  const changesFiles = useMemo(
    () => files.filter((f) => f.status !== "staged"),
    [files]
  );
  const stagedFiles = useMemo(
    () => files.filter((f) => f.status === "staged"),
    [files]
  );

  // AI 配置 —— 从 localStorage 初始化,任意字段变化立刻持久化
  const [aiBaseUrl, setAiBaseUrl] = useState(
    () => localStorage.getItem(AI_STORAGE_KEYS.baseUrl) ?? AI_DEFAULTS.baseUrl
  );
  const [aiApiKey, setAiApiKey] = useState(
    () => localStorage.getItem(AI_STORAGE_KEYS.apiKey) ?? ""
  );
  const [aiModel, setAiModel] = useState(
    () => localStorage.getItem(AI_STORAGE_KEYS.model) ?? AI_DEFAULTS.model
  );

  useEffect(() => {
    localStorage.setItem(AI_STORAGE_KEYS.baseUrl, aiBaseUrl);
  }, [aiBaseUrl]);
  useEffect(() => {
    localStorage.setItem(AI_STORAGE_KEYS.apiKey, aiApiKey);
  }, [aiApiKey]);
  useEffect(() => {
    localStorage.setItem(AI_STORAGE_KEYS.model, aiModel);
  }, [aiModel]);

  // 用于 API Key 空时自动聚焦
  const apiKeyInputRef = useRef<HTMLInputElement>(null);

  // textarea 自适应高度:auto-glow 的标准两步法
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto"; // 先归零让浏览器算自然 scrollHeight
    el.style.height = `${el.scrollHeight}px`; // 再赋值为内容高度(超出被 max-h 截断)
  }, [commitMessage]);

  const handleAiGenerate = async () => {
    if (!repoPath || aiLoading) return;
    // 🔒 防错拦截:API Key 为空时直接弹设置面板并聚焦 Key 输入框
    if (!localStorage.getItem(AI_STORAGE_KEYS.apiKey)) {
      setShowSettings(true);
      setTimeout(() => apiKeyInputRef.current?.focus(), 50);
      return;
    }
    setAiLoading(true);
    try {
      const diff = await getStagedDiff(repoPath);
      if (!diff.trim()) {
        await message("暂存区为空,请先 Stage 留住文件", {
          title: "暂存区为空",
          kind: "info",
        });
        return;
      }
      const msg = await generateCommitMessage(diff);
      setCommitMessage(msg);
    } catch (e) {
      console.error("AI 生成失败", e);
      await message(`AI 生成失败:\n${String(e)}`, {
        title: "错误",
        kind: "error",
      });
    } finally {
      setAiLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!repoPath || committing) return;
    const msg = commitMessage.trim();
    if (!msg) {
      await message("请先输入 commit 信息", {
        title: "提交信息为空",
        kind: "warning",
      });
      return;
    }
    setCommitting(true);
    try {
      await executeCommit(repoPath, msg);
      setCommitMessage("");
      onCommitDone();
    } catch (e) {
      console.error("commit 失败", e);
      await message(`提交失败:\n${String(e)}`, {
        title: "错误",
        kind: "error",
      });
    } finally {
      setCommitting(false);
    }
  };

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

  // === 树扫描流:repoPath 切换走初始加载(整树替换为 fresh);
//                  files 变化走刷新(merge 保留展开状态) ===
// 依赖数组刻意只有 [repoPath, files]:
// - tree 不进 deps,避免 setTree → tree 变 → effect 重跑 → 死循环
// - 读 tree 时走 treeRef.current,绕过闭包陷阱,拿到屏幕上的真值
useEffect(() => {
    if (!repoPath) {
      setTree([]);
      setTreeError(null);
      lastScannedRepoRef.current = null;
      return;
    }

    const isRepoChange = lastScannedRepoRef.current !== repoPath;
    let cancelled = false;

    // 仅初始加载显示 loading,后台静默刷新不打扰用户
    if (isRepoChange) setTreeLoading(true);
    setTreeError(null);

    (async () => {
      try {
        // 1. 根目录
        const rootEntries = await readDirectory(repoPath);
        if (cancelled) return;

        // 2. 收集所有已展开+已加载的文件夹(从 treeRef 取,绝对最新)
        const expandedDirs = collectExpandedLoadedDirs(treeRef.current);

        // 3. 并发拉取这些文件夹的最新内容(失败的静默跳过,可能是被删了)
        const dirResults = await Promise.all(
          expandedDirs.map(async (dir) => {
            try {
              const entries = await readDirectory(dir.path);
              return [dir.path, toTreeItems(entries)] as const;
            } catch {
              return null;
            }
          })
        );
        if (cancelled) return;

        // 4. 构建 freshMap + 应用 merge / 替换
        const freshMap = new Map<string, TreeItem[]>(
          dirResults.filter(
            (r): r is readonly [string, TreeItem[]] => r !== null
          )
        );

        if (isRepoChange) {
          // repo 切换:整树替换,丢掉旧状态
          setTree(toTreeItems(rootEntries));
        } else {
          // files 触发刷新:merge 保留展开
          setTree((prev) =>
            mergeTreeRecursive(prev, toTreeItems(rootEntries), freshMap)
          );
        }
        lastScannedRepoRef.current = repoPath;
        setTreeError(null);
      } catch (e) {
        console.error("readDirectory 失败", e);
        if (!cancelled) {
          setTree([]);
          setTreeError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setTreeLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repoPath, files]);

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
    // Sidebar 外壳:h-full flex flex-col,父容器已带 border-r border-[#262B37]
    <aside className="h-full flex flex-col bg-[#161920]">
      {/* === 顶部 36px 紧凑工具轨 —— 选择仓库 + 刷新,微差色层与底部 commit 太空舱对称 === */}
      <div className="flex items-center justify-between h-9 px-3 border-b border-[#262B37] flex-shrink-0">
        <button
          onClick={handlePickRepo}
          disabled={picking}
          className="bg-[#1C1F26] border border-[#262B37] text-[11px] text-zinc-300
                     hover:text-white px-2 py-0.5 rounded transition-colors
                     disabled:opacity-50"
        >
          {picking ? "选择中…" : "选择仓库"}
        </button>
        <button
          onClick={onRefresh}
          disabled={!repoPath || loading}
          title="刷新"
          className="w-6 h-6 flex items-center justify-center text-zinc-300
                     hover:text-white disabled:opacity-30 rounded transition-colors"
        >
          <RefreshIcon className={loading ? "animate-spin" : ""} />
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
          <>
            {tree.map((n) => (
              <TreeNodeView
                key={n.path}
                node={n}
                depth={0}
                onToggle={toggleNode}
                dirtyNodes={dirtyNodes}
                files={files}
                onSelectFile={onSelectFile}
                onReadOnlyFile={onReadOnlyFile}
                onOpenInVscode={onOpenInVscode}
                ignoreMatcher={ignoreMatcher}
              />
            ))}
          </>
        )}
      </div>

      {/* === 双选项卡:CHANGES / STAGED === */}
      <div className="flex border-t border-[#262B37] flex-shrink-0 relative">
        {/* 滑动绿色高亮条:Changes 位 ↔ Staged 位,200ms ease-out 横向滑移 */}
        <div
          className={`absolute bottom-0 left-0 w-1/2 h-px bg-emerald-500
                      transition-transform duration-200 ease-out
                      ${activeTab === "changes" ? "translate-x-0" : "translate-x-full"}`}
        />
        <button
          onClick={() => setActiveTab("changes")}
          className={`flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
            activeTab === "changes"
              ? "text-white"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Changes ({changesFiles.length})
        </button>
        <button
          onClick={() => setActiveTab("staged")}
          className={`flex-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
            activeTab === "staged"
              ? "text-white"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          Staged ({stagedFiles.length})
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 py-1">
        {activeTab === "changes" ? (
          changesFiles.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-gray-500">
              {repoPath ? (loading ? "加载中…" : "无未暂存变更") : "—"}
            </div>
          ) : (
            <ul className="overflow-hidden">
              {changesFiles.map((f) => {
                const isSelected = selectedFile === f.path;
                return (
                  <li
                    key={f.path}
                    onClick={() => onSelectFile(f.path)}
                    className={`group flex items-center h-[26px] overflow-hidden flex-shrink-0 px-2 text-[12px] font-mono rounded-sm cursor-pointer
                                ${isSelected
                                  ? "bg-[#202430] text-white"
                                  : "text-zinc-400 hover:text-white hover:bg-white/[0.03]"}`}
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
                    <div className="flex-shrink-0 ml-0 group-hover:ml-2 max-w-0 group-hover:max-w-[160px] overflow-hidden opacity-0 -translate-x-1 filter blur-[1px] group-hover:opacity-100 group-hover:translate-x-0 group-hover:filter-none pointer-events-none group-hover:pointer-events-auto transition-all duration-150 flex items-center gap-1.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const row = e.currentTarget.closest("li");
                          if (row) animateExit(row, () => onStageFile(f.path));
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
                          const row = e.currentTarget.closest("li");
                          if (row) animateExit(row, () => onDiscardFile(f.path, f.status));
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
          )
        ) : stagedFiles.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-gray-500">
            {repoPath ? "暂存区为空" : "—"}
          </div>
        ) : (
          <ul className="overflow-hidden">
            {stagedFiles.map((f) => {
              const isSelected = selectedFile === f.path;
              return (
                <li
                  key={f.path}
                  onClick={() => onSelectFile(f.path)}
                  className={`group flex items-center h-[26px] overflow-hidden flex-shrink-0 px-2 text-[12px] font-mono rounded-sm cursor-pointer
                              ${isSelected
                                ? "bg-[#202430] text-white"
                                : "text-zinc-400 hover:text-white hover:bg-white/[0.03]"}`}
                  title={f.path}
                >
                  <span className="truncate flex-1 min-w-0">{f.path}</span>

                  {/* Staged 状态固定 "S" + neon-cyan */}
                  <span
                    className={`flex-shrink-0 ml-2 text-[10px] font-bold w-3 text-center transition-opacity duration-75
                      group-hover:opacity-0 text-neon-cyan`}
                  >
                    S
                  </span>

                  {/* Hover 动作条 —— Staged 专属 ↺ Unstage 单按钮 */}
                  <div className="flex-shrink-0 ml-0 group-hover:ml-2 max-w-0 group-hover:max-w-[110px] overflow-hidden opacity-0 -translate-x-1 filter blur-[1px] group-hover:opacity-100 group-hover:translate-x-0 group-hover:filter-none pointer-events-none group-hover:pointer-events-auto transition-all duration-150 flex items-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const row = e.currentTarget.closest("li");
                        if (row) animateExit(row, () => onUnstageFile(f.path));
                      }}
                      title="取消暂存"
                      className="text-[10px] font-bold text-amber-400 hover:text-amber-300 leading-none px-0.5 whitespace-nowrap"
                    >
                      ↺ Unstage
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* === AI 智能 Commit 栏 + 设置抽屉 === */}
      <div className="relative flex-shrink-0">
        {/* 抽屉常驻 DOM,通过类名切换显隐 + 滑入动画(200ms ease-out) */}
        <div
          className={`absolute bottom-full left-0 w-full z-10
                      bg-[#161920] border-t border-[#262B37] p-3
                      flex flex-col gap-2 shadow-lg
                      transition-all duration-200 ease-out
                      ${showSettings
                        ? "translate-y-0 opacity-100 pointer-events-auto scale-100"
                        : "translate-y-2 opacity-0 pointer-events-none scale-[0.99]"}`}
        >
          <Field
            label="Base URL"
            value={aiBaseUrl}
            onChange={setAiBaseUrl}
            placeholder={AI_DEFAULTS.baseUrl}
          />
          <Field
            label="API Key"
            type="password"
            value={aiApiKey}
            onChange={setAiApiKey}
            placeholder="sk-..."
            inputRef={apiKeyInputRef}
          />
          <Field
            label="Model"
            value={aiModel}
            onChange={setAiModel}
            placeholder={AI_DEFAULTS.model}
          />
        </div>

        {/* 外凹槽:刻意比侧栏壳 #161920 更暗一档,营造凹陷轨道 */}
        <div className="p-2 border-t border-[#262B37] bg-[#13161C]">
          {/* 内卡:聚焦色 #1C1F26,浮于外凹槽之上 */}
          <div className="flex flex-col w-full bg-[#1C1F26] border border-[#262B37] rounded-md p-2
                          focus-within:border-zinc-700 transition-all duration-200 ease-out">

            {/* 顶层:纯净 textarea —— 边框/bg 全由内卡提供 */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                // textarea 下 Enter 换行;只有 Ctrl/Cmd+Enter 提交
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleCommit();
                }
              }}
              placeholder="Commit message (Ctrl+Enter)..."
              title="输入 commit 信息,或点 ✦ AI 生成 (Ctrl+Enter 提交)"
              disabled={committing}
              className="w-full bg-transparent resize-none outline-none
                         text-[12px] font-mono text-ink-base
                         placeholder:text-gray-600 disabled:opacity-50
                         transition-[height] duration-150 ease-out
                         min-h-[24px] max-h-[120px] overflow-y-auto"
            />

            {/* 底层:内嵌工具栏 —— 纳米级分隔 (2% 白) */}
            <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-white/[0.02]">
              {/* 左槽:齿轮 + AI 生成 / LoadingDots */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowSettings((s) => !s)}
                  title="AI 设置"
                  className="text-gray-500 hover:text-white transition-colors"
                >
                  <GearIcon />
                </button>
                {commitMessage === "" && !aiLoading && (
                  <button
                    onClick={handleAiGenerate}
                    title="AI 生成 commit 信息"
                    className="text-[11px] font-medium text-gray-500 hover:text-emerald-400
                               transition-colors duration-200 flex items-center gap-0.5"
                  >
                    <SparklesIcon />
                    AI 生成
                  </button>
                )}
                {aiLoading && <LoadingDots />}
              </div>

              {/* 右槽:Commit 主操作 */}
              <button
                onClick={handleCommit}
                disabled={committing || !commitMessage.trim() || stagedFiles.length === 0}
                className="bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-30
                           text-white rounded px-2.5 py-0.5 text-[11px] font-semibold
                           transition-colors"
              >
                {committing ? "提交中…" : "Commit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// === 树节点视图(递归):VS Code 风格 —— chevron + 图标 + 文件名 ===
function TreeNodeView({
  node,
  depth,
  onToggle,
  dirtyNodes,
  files,
  onSelectFile,
  onReadOnlyFile,
  onOpenInVscode,
  ignoreMatcher,
}: {
  node: TreeItem;
  depth: number;
  onToggle: (path: string) => void;
  dirtyNodes: Map<string, BubbleKind>;
  files: GitFile[];
  onSelectFile: (path: string) => void;
  onReadOnlyFile: (path: string) => void;
  onOpenInVscode: (path: string) => void;
  ignoreMatcher: (path: string) => boolean;
}) {
  // 文件夹 + 文件节点都查:map 里既有祖先文件夹也有文件自身
  const bubble = dirtyNodes.get(node.path);
  // dim 判定走 .gitignore 解析后的 glob matcher,覆盖目标节点自身 + 所有子孙
  const isIgnored = ignoreMatcher(node.path);

  // 文字色优先级:dirty > ignored > clean(folder/file)
  const baseText =
    bubble === "modified"
      ? "text-emerald-500/80"
      : bubble === "untracked"
      ? "text-amber-500/80"
      : isIgnored
      ? "text-zinc-600"
      : node.is_dir
      ? "text-zinc-200 font-medium"
      : "text-zinc-400";

  // hover 文字色:dirty 色加深;ignored 保持低调(不变);folder 变白;file 变 zinc-100
  const hoverText =
    bubble === "modified"
      ? "hover:text-emerald-400"
      : bubble === "untracked"
      ? "hover:text-amber-400"
      : isIgnored
      ? ""
      : node.is_dir
      ? "hover:text-white"
      : "hover:text-zinc-100";

  // 图标透明度独立判定 —— 仅看 isIgnored,不被 dirty 压过
  const iconClass = isIgnored ? "opacity-40" : "";

  // === 单击 / 双击智能分流 ===
  // 单击:目录 → toggle 展开/折叠;文件 → modified 走 diff,clean 走 viewer
  // 双击:文件 → 唤起 VS Code(目录双击无副作用)
  const handleClick = () => {
    if (node.is_dir) {
      onToggle(node.path);
      return;
    }
    const isChanged = files.some((f) => f.path === node.path);
    if (isChanged) {
      onSelectFile(node.path);
    } else {
      onReadOnlyFile(node.path);
    }
  };
  const handleDoubleClick = () => {
    if (!node.is_dir) {
      onOpenInVscode(node.path);
    }
  };

  return (
    <div>
      <div
        className={`group flex items-center h-7 gap-2 pr-2 py-0.5 rounded-sm
                    hover:bg-white/[0.03] transition-colors duration-150 ease-in-out cursor-pointer
                    ${baseText} ${hoverText}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        title={node.path}
      >
        {node.is_dir ? (
          <ChevronIcon expanded={node.isOpen} />
        ) : (
          <span className="w-[14px] flex-shrink-0" />
        )}
        {node.is_dir ? (
          <FolderIcon className={iconClass} />
        ) : (
          <FileIcon className={iconClass} />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {/* === CSS Grid 卷轴展开:grid-template-rows 在 1fr ↔ 0fr 之间过渡 === */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          node.isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          {node.children?.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              onToggle={onToggle}
              dirtyNodes={dirtyNodes}
              files={files}
              onSelectFile={onSelectFile}
              onReadOnlyFile={onReadOnlyFile}
              onOpenInVscode={onOpenInVscode}
              ignoreMatcher={ignoreMatcher}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// 面板小标题 —— WORKSPACE / CHANGES
function SectionHeader({ label }: { label: string }) {
  return (
    <div
      className="px-4 py-1.5 text-[11px] font-semibold tracking-wider uppercase
                 text-gray-500 flex-shrink-0"
    >
      {label}
    </div>
  );
}