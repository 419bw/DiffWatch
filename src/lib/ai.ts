// AI Commit 信息生成 —— 从 localStorage 动态读三项配置,支持任意 OpenAI-compatible 端点
// 配置由 src/components/Sidebar.tsx 里的 ⚙️ 设置抽屉持久化,不在此处硬编码

const MAX_DIFF_CHARS = 12_000;
/** fetch 超时阈值(毫秒) —— 防止 Base URL 错误或网络极差时 fetch 挂死,LoadingDots 永远转 */
const FETCH_TIMEOUT_MS = 15_000;

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

export const STORAGE_KEYS = {
  baseUrl: "ai_base_url",
  apiKey: "ai_api_key",
  model: "ai_model",
} as const;

export const AI_DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
} as const;

function truncateDiff(s: string): string {
  if (s.length <= MAX_DIFF_CHARS) return s;
  return s.slice(0, MAX_DIFF_CHARS) + "\n\n...(diff truncated)...";
}

/** 生成 commit 信息 —— 全部配置从 localStorage 动态取,带 15s AbortController 超时 */
export async function generateCommitMessage(diff: string): Promise<string> {
  const apiKey = localStorage.getItem(STORAGE_KEYS.apiKey) ?? "";
  const baseUrl = (
    localStorage.getItem(STORAGE_KEYS.baseUrl) ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const model = localStorage.getItem(STORAGE_KEYS.model) ?? DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error("AI_API_KEY 未配置,请先在设置面板(⚙️)填写");
  }

  const endpoint = `${baseUrl}/chat/completions`;

  const prompt = [
    "你是一个高级 Git Commit 信息生成助手,擅长透过代码差异 (Diff) 洞察深层的工程意图。",
    "请站在资深架构师的视角,严格按照以下硬性要求输出:",
    "",
    "硬性要求:",
    "- 拒绝流水账:严禁单纯罗列修改的文件名、函数名或组件名 (那是 Changelog,不是 Commit)。",
    "- 阐述动机 (Why):重点说明这次改动是为了解决什么本质问题、消除了什么隐患,或带来了什么核心工程价值。",
    "- 提炼关键设计决策 (若 Diff 中存在,必须重点体现):",
    "  · 范围控制与副作用规避:采用了何种特定策略来锁定操作范围,如何做到不误伤其他模块。",
    "  · 边界与极端状态防御:代码中如何对空状态、错误边界、权限缺失或异常输入进行优雅兜底。",
    "  · 状态耦合与系统联动:多组件/多数据源之间的数据分流、双向一致性或状态守门 (禁用/启用) 的关联逻辑。",
    "  · 错误传播与失败语义:系统发生问题时,是如何将错误传导给用户的 (如弹窗阻断、日志记录或静默降级)。",
    "- 关注系统不变量:必要时提及此次改动打破、建立或维持了哪些核心的系统不变量 (Invariant)。",
    "- 格式规范:严格遵守 Conventional Commits 规范 (如 feat:、fix: 等)。标题 ≤ 72 字符,body 简明扼要。",
    "- 纯文本输出:直接返回最终文本,严禁包含 markdown 代码块包裹 (如 ```)。",
    "",
    "Diff:",
    truncateDiff(diff),
  ].join("\n");

  // AbortController + setTimeout 双重防护:超时后 controller.abort() 触发 fetch 立即 reject
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        // reasoning 模型(DeepSeek-R1/Flash 等)需要给推理留 2-3x token 预算,
        // 否则 finish_reason=length 截断 → content 为空。1000 留 600 推理 + 400 输出。
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`AI 请求失败 ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const msg = data?.choices?.[0]?.message?.content?.trim();
    if (!msg) throw new Error("AI 返回内容为空");
    return msg;
  } catch (e) {
    // 超时分支:AbortError 是 DOMException,name === "AbortError"
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        `网络请求超时(${FETCH_TIMEOUT_MS / 1000}s),请检查 Base URL 是否可达`
      );
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}