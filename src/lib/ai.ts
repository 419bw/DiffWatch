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
    "你是一个 git commit 信息生成助手。根据下面的 diff 输出简洁的 conventional commit 信息。",
    "要求:",
    "- 第一行 ≤ 72 字符,概括改动",
    "- 必要时附简短 body 解释动机",
    "- 纯文本输出,不要 markdown 代码块包裹",
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
        max_tokens: 300,
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