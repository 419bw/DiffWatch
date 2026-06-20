# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

**AI Change Inspector** —— 本地 Git 变更评审工具。选一个 git 仓库，左侧分 WORKSPACE（懒加载目录树）/ CHANGES（变更文件列表）双面板，右侧显示选中文件的 split/unified diff，代码用 shiki 做 `github-dark` 主题高亮。

技术栈：**Tauri 2 + React 19 + Vite 6 + Tailwind 3 + Rust 1.96 (stable-x86_64-pc-windows-gnu) + git2 (vendored libgit2) + notify 6 + notify-debouncer-full 0.3**。

## 命令速查

> Windows PowerShell 专用。PATH 与 rustup 镜像已在系统级配置（HANDOFF 第 5 节）。

```powershell
# === 编译 + 启动 GUI（日常开发用这个）===
npm run tauri dev                     # vite 1420 + cargo build + tauri-app.exe 窗口

# === 类型 / 编译检查 ===
npx tsc --noEmit                      # 前端 TS 校验（秒级）
cd src-tauri; cargo check             # Rust 快速类型检查（增量 5-15s，首次 1m35s）

# === 单独编译 ===
cd src-tauri; cargo build             # 出 src-tauri/target/debug/tauri-app.exe
npm run build                         # 出 dist/（不产 tauri 二进制）
```

无单测、无 lint script、无 prettier。Rust 端用 `cargo check` 兜底类型，前端用 `npx tsc --noEmit`。

## 架构

### 进程边界

```
React 前端  ──invoke("xxx")──▶  Rust 后端 (tauri-app.exe)
     ▲                              │
     └────── emit("repo-changed") ──┘
```

### 前端 (src/)

| 文件 | 职责 |
|---|---|
| `App.tsx` | 顶层 state：repoPath / files / selectedFile / diffRefreshKey；启停 watchdog、订阅 `repo-changed` 事件、刷新 status + diff |
| `components/Sidebar.tsx` | 左侧栏：顶按钮行 + WORKSPACE 懒加载树 + CHANGES 列表 + 状态字母徽章 |
| `components/DiffPanel.tsx` | 右侧 diff：shiki highlighter init + getFileContent + `<DiffView>` 渲染 |
| `components/EmptyState.tsx` | 未选文件时的占位 |
| `lib/tauri.ts` | 所有 `invoke<T>()` 封装 |
| `types.ts` | 与 Rust serde 结构对齐的 TS 接口 |
| `index.css` | `.gel-box`（黑冰按钮）+ `.scrollbar-thin`（极细滚动条），body 纯 `#0B0F17` |

### 后端 (src-tauri/src/)

| 文件 | 模块 | 职责 |
|---|---|---|
| `lib.rs` | 入口 | 注册 plugin + `manage(WatcherState)` + `invoke_handler!` |
| `commands.rs` | 3 命令 | `get_git_status` / `get_file_content` / `read_directory` |
| `git_ops.rs` | git + 文件 IO | `list_changed_files`（git2）/`read_file_diff`（HEAD vs worktree）/`read_directory`（单层扫描）/`guess_lang`（扩展名 → shiki lang id） |
| `watcher.rs` | 文件监听 | `WatcherState`（Tauri State 持有 Debouncer）+ `start_watching` / `stop_watching` 命令 + `should_ignore` 过滤 target/node_modules |

**新增 Tauri 命令的标准路径**：
1. 在对应模块（`git_ops.rs` / `watcher.rs`）写函数
2. 在 `commands.rs` 用别名引入避免同名冲突：`use crate::git_ops::{read_directory as read_dir_impl, ...};`
3. 在 `commands.rs` 包 `#[tauri::command]` 壳，命名空间独立
4. 在 `lib.rs` 的 `invoke_handler!` 里加 `commands::xxx`

### Rust ↔ JS 命名约定

Rust 函数参数 `repo_path: String` ↔ JS invoke 参数 `{ repoPath: '...' }`，Tauri 2 自动 snake_case → camelCase 转换。**别自己起 camelCase 别名**。

## 关键约束（踩过的坑，必须遵守）

### HANDOFF 第 6 节列出过 11 个 known issues，下面是还在生效的：

1. **Vite 必须 ≤ 6** —— Vite 7 要求 Node 20.19+，本机 Node 20.10.0 不兼容。`vite@^6.4.3` 锁死。
2. **MinGW ld ordinal 错误** —— `src-tauri/.cargo/config.toml` 加了 `rustflags = ["-C", "link-arg=-Wl,--exclude-libs=ALL"]`，**别删**。
3. **`lib.rs` 必须注册全部 plugin 和命令** —— 缺 `tauri_plugin_dialog::init()` 或 `commands::xxx` → invoke 静默失败（只 F12 能看到）。
4. **shiki lang fallback 用 `"text"`** —— `"plaintext"` 不在 shiki 默认 bundle 里，`hasRegisteredCurrentLang` 返回 false，语法高亮静默失败。
5. **DiffView 用 `<DiffView data={...}>` + `createTwoFilesPatch` 喂 `hunks: [diffString]`** —— **不要**用 `generateDiffFile`，否则 `initRaw` 内部 composeFile 会触发 `composed identical` 警告 + `Invalid bundle data` 循环。
6. **`recurse_untracked_dirs(true)` 会列噪音** —— `src-tauri/` 整目录 untracked 时会被展开成 14+ 个文件。代码里现在是 `false`，**别改回 true**。
7. **notify 6.1 + notify-debouncer-full 0.3.2 API**：Debouncer **没有** `.watch()`，要走 `.watcher().watch(&path, RecursiveMode::Recursive)`。
8. **路径分隔符**：Rust → JS 一律用 POSIX 风格 `/`（用 `.replace('\\', "/")`），Windows 原生 `\` 会让前端 parse 翻车。

### `src-tauri/.cargo/config.toml` 内容（不能丢）

```toml
[target.x86_64-pc-windows-gnu]
linker = "G:\\mingw64\\bin\\gcc.exe"
rustflags = ["-C", "link-arg=-Wl,--exclude-libs=ALL"]
```

### `src-tauri/rust-toolchain.toml`（不能改）

锁定 `channel = "stable-x86_64-pc-windows-gnu"`。

## 工作流约定

### 改 Rust 后必须重启 tauri dev

Vite 会热重载前端，但 `tauri-app.exe` 是启动时一次性加载的。改任何 `src-tauri/` 文件后**必须**重启 `npm run tauri dev`，新命令/新结构才会生效。

### 改前端 JSX 后 Vite 自动 HMR

`Sidebar.tsx` / `App.tsx` 等保存后 Vite 秒级刷新，不用重启 GUI。

### 修改 Tauri 命令的 Rust 签名

要同步改前端 `src/types.ts` 和 `src/lib/tauri.ts` 的类型 + invoke 封装。**改完两边都跑一次** `npx tsc --noEmit` 和重启 `tauri dev`。

## .gitignore 约定

构建产物不进库（已配置）：
- `node_modules/` / `dist/` / `src-tauri/target/` / `src-tauri/Cargo.lock` / `src-tauri/gen/`
- `HANDOFF.md`（个人维护文档，不参与 diff 评审）

**前端代码（`src/` / `public/` / 所有 configs / `index.html`）全部入库**——之前 `.gitignore` 把它们排除掉了，初版 commit (`02ed0e6`) 时改掉了。现在保留这个状态。

## HANDOFF.md 是什么

仓库根的 `HANDOFF.md` 是早期交接文档，包含：
- 环境信息（PATH、Rust 版本、MinGW 位置）
- 完整编译启动流程（PowerShell 命令清单）
- 调试技巧（F12 devtools invoke 调用示例）
- 完整 known issues 列表

**遇到新问题时先读 HANDOFF.md**——大概率有现成的排查路径。HANDOFF 不会被 git 追踪，写调试笔记可以加在那。