// 与 Rust 端 serde 结构保持一致（snake_case）

// === 全局桥接:Line Patcher 单行落盘后由 VirtualFileViewer 调用,触发 App.tsx 整体重拉 ===
declare global {
  interface Window {
    __REFRESH_GLOBAL__?: () => void;
  }
}

export interface GitFile {
  path: string;
  /** 'modified' | 'untracked' | 'deleted' | 'staged' | 'renamed' | 'typechange' */
  status: string;
}

export interface FileDiffData {
  old_content: string;
  new_content: string;
  old_path: string | null;
  new_path: string;
  /** shiki 支持的语言 id，未知 / 二进制为 null */
  lang: string | null;
}

/** 单层目录条目 —— Rust 端 read_directory 返回的最小数据单元 */
export interface FileEntry {
  /** 节点名（不含父路径） */
  name: string;
  /** 文件 / 文件夹绝对路径；POSIX 风格 "/" 分隔 */
  path: string;
  is_dir: boolean;
}

/**
 * 前端懒加载树节点 —— 在 FileEntry 基础上叠加 UI 状态
 * - `children` 仅在 isLoaded 后才挂载
 * - `isOpen` 控制折叠 / 展开
 * - `isLoaded` 防止重复 invoke
 */
export interface TreeItem extends FileEntry {
  children?: TreeItem[];
  isOpen: boolean;
  isLoaded: boolean;
}