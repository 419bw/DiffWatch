<div align="center">

# diffWatch

**桌面级 Git 变更检视与暂存工具**

[![Tauri 2](https://img.shields.io/badge/Tauri-2.x-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.96-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](#)

基于 **Tauri + Rust + React**。左侧工作区文件树，中栏 CHANGES / STAGED 双面板，右侧 split / unified diff。所有数据本地处理，代码不出本机。

</div>

---

## 特性

### 轻量

Tauri 2 + 系统 WebView，不引入 Chromium 内嵌。打开多个实例也不会让机器发烫。

### 文件级暂存

行尾 Stage / Discard / Unstage 按钮，整文件粒度管理暂存区。AI 自动起草 commit message（可选）。

### 原生 60 帧动效

行离场、标签切换、折叠展开全部走浏览器原生 Web Animations API，不引入第三方动效库。动画由 GPU 合成线程接管，主线程只声明、不计算。

### 智能增量同步

工作区文件树接入 debounce 文件监听管线，磁盘变化自动同步到 UI。已展开的文件夹状态不会被刷新破坏 —— 用户不需要手动重展开。

---

## 快速开始

### 下载

前往 [GitHub Releases](https://github.com/419bw/DiffWatch/releases) 下载：

| 文件 | 用途 |
|---|---|
| `diffWatch-x.x.x-setup.exe` | NSIS 安装版 |
| `diffWatch-x.x.x-x64.msi` | Windows Installer |
| `diffWatch-x.x.x.exe` | 绿色版（portable） |

### 使用

1. 双击启动
2. 点击「打开仓库」按钮，选择 Git 仓库根目录
3. 左侧树加载工作区，中栏列出变更文件，右栏展示 diff

### 系统要求

Windows 10 / 11（x64）。不需要预装 Node.js。
运行时也无需任何全局 Git 环境依赖 —— Tauri 静态链接了 libgit2，即使系统未配置 Git 环境变量，也能直接读取并操作现有的 .git 存储库。

---

## 从源码构建

需要：

- Node.js ≥ 20
- Rust 1.96（stable-x86_64-pc-windows-gnu toolchain）
- MinGW-w64（Windows GCC）

```bash
npm install
npm run tauri dev     # 开发模式（前端 HMR + Rust 增量编译）
npm run tauri build   # 生产构建
```

---

## 键盘流

| 快捷键 | 动作 |
|---|---|
| `Ctrl + Enter` | 提交 commit message |
| `Enter` | 在 diff 视图保存行编辑 |
| `Esc` | 取消行编辑 |

---

## 技术栈

| 层级 | 选型 |
|---|---|
| Shell | Tauri 2 |
| 后端 | Rust · `git2`（vendored libgit2） · `notify` 6 · `notify-debouncer-full` 0.3 |
| 前端 | React 19 · Vite 6 · Tailwind 3 |
| Diff 渲染 | `@git-diff-view/react` |
| 语法高亮 | shiki（github-dark） |

---

## 开源协议

MIT License。

```
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

底层 Git 操作的边缘情况、文件监听的 race condition、动画时序的毫秒级漂移 —— 都可能存在尚未发现的 corner case。遇到请到 [Issues](https://github.com/419bw/DiffWatch/issues) 提交，附最小复现仓库最受欢迎。

**欢迎 PR。** 提交前请保证代码质量 —— 命名清晰、结构合理、注释克制。

```bash
npx tsc --noEmit
cd src-tauri && cargo check
```

---

<div align="center">

**Keep it small. Keep it fast. Keep it local.**

</div>