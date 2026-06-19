/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // === 赛博黑曜石 (Cyber Obsidian) 色板 ===
        // 背景层:从深邃底色到浮起面板
        obsidian: {
          void: "#0B0F17",       // 画布最底层
          deep: "#10151F",       // 卡片之间留白
          panel: "#121826",      // 凝胶盒子基础色
          edge: "#1E2533",       // 按钮图标圆饼 / 内描边
          grid: "#1A212D",       // 网格暗线
          border: "#222B3D",     // 常规描边
          ridge: "#2A3245",      // 高亮描边
        },
        // 文字流:从隐藏到高亮
        ink: {
          muted: "#6B7585",      // text-gray-500 等价
          base: "#D8DEE9",       // text-gray-300 等价
          strong: "#FFFFFF",     // text-white
          ink: "#0B0F17",        // 深底按钮上的文字
        },
        // 霓虹态点 / accent
        neon: {
          green: "#3CFF8E",      // 霓虹绿 (modified)
          lime: "#CFFF52",       // 霓虹黄 (untracked)
          red: "#FF4D6A",        // 霓虹红 (deleted)
          cyan: "#46E6FF",       // 霓虹青 (staged)
        },
        // diff 行高亮(暗色预设)
        diff: {
          addBg: "rgba(60, 255, 142, 0.12)",
          delBg: "rgba(255, 77, 106, 0.12)",
          addLineBg: "rgba(60, 255, 142, 0.20)",
          delLineBg: "rgba(255, 77, 106, 0.20)",
          addFg: "#3CFF8E",
          delFg: "#FF4D6A",
        },
      },
    },
  },
  plugins: [],
};