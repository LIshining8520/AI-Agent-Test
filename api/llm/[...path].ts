/**
 * LLM 同源代理 · `POST /api/llm/chat/completions`
 *
 * 存在的唯一理由：**把 API Key 从前端产物里拿掉**。
 *
 * 前端只会调 `/api/llm/chat/completions`（不带 Authorization），本函数在服务端
 * 补上 `DEEPSEEK_API_KEY` 后转发到 OpenAI 兼容端点，再把响应原样回给浏览器。
 *
 * 服务端环境变量（Vercel → Settings → Environment Variables）：
 *  - `DEEPSEEK_API_KEY`  必填，真正的 Key（注意**不要**加 VITE_ 前缀）
 *  - `DEEPSEEK_BASE_URL` 可选，默认 https://api.deepseek.com/v1
 *  - `LLM_ALLOWED_MODELS` 可选，逗号分隔的模型白名单，默认放行主流的三个
 *
 * 三道基础护栏（公开端点的必要防线，避免接口被人拿去当免费 API 刷）：
 *  1. 模型白名单：不允许调白名单外的（更贵的）模型；
 *  2. max_tokens 上限：钳到 8192；
 *  3. 单 IP 速率限制：默认 30 次/分钟（内存级，仅对同一函数实例生效）。
 */

type VercelRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
  end(): void;
};

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_ALLOWED_MODELS = [
  "deepseek-v4-flash",
  "deepseek-flash",
  "deepseek-v4-pro",
];
const MAX_TOKENS_CAP = 8192;
const RATE_LIMIT_PER_MIN = 30;

/** 单实例内存级限流，进程重建即清零（够用，不做分布式） */
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_MIN;
}

function allowedModels(): string[] {
  const raw = process.env.LLM_ALLOWED_MODELS;
  if (!raw) return DEFAULT_ALLOWED_MODELS;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_MODELS;
}

function jsonError(
  res: VercelResponse,
  status: number,
  message: string,
  type = "proxy_error",
) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify({ error: { message, type } }));
}

/** catch-all 参数归一化：`[...path]` 可能是 string 或 string[] */
function suffixOf(query: VercelRequest["query"]): string {
  const raw = query.path;
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const suffix = parts.filter(Boolean).join("/");
  return suffix || "chat/completions";
}

function clientIp(headers: VercelRequest["headers"], fallback: string): string {
  const xff = headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff;
  return (first ?? "").split(",")[0].trim() || fallback;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    jsonError(res, 405, "只接受 POST");
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    jsonError(
      res,
      500,
      "服务端未配置 DEEPSEEK_API_KEY（注意不要加 VITE_ 前缀）",
      "proxy_misconfigured",
    );
    return;
  }

  if (rateLimited(clientIp(req.headers, "unknown"))) {
    jsonError(res, 429, "请求过于频繁，请稍后再试", "rate_limited");
    return;
  }

  // Vercel 已把 JSON body 解析好；字符串则直接用
  let bodyText: string;
  if (typeof req.body === "string") {
    bodyText = req.body;
  } else if (req.body && typeof req.body === "object") {
    bodyText = JSON.stringify(req.body);
  } else {
    jsonError(res, 400, "请求体为空");
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    jsonError(res, 400, "请求体不是合法 JSON");
    return;
  }

  // 护栏 1：模型白名单
  const models = allowedModels();
  const model = typeof payload.model === "string" ? payload.model : "";
  if (model && !models.includes(model)) {
    jsonError(
      res,
      400,
      `不允许的模型 ${model}；可用：${models.join(", ")}`,
      "model_not_allowed",
    );
    return;
  }

  // 护栏 2：钳制输出长度，防止单次调用被放大
  const maxTokens = Number(payload.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > MAX_TOKENS_CAP) {
    payload.max_tokens = MAX_TOKENS_CAP;
  }

  const base = (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const url = `${base}/${suffixOf(req.query)}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    jsonError(res, 502, `上游不可达：${String(err)}`, "upstream_unreachable");
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader(
    "Content-Type",
    upstream.headers.get("content-type") || "application/json; charset=utf-8",
  );
  // 不让浏览器/中间层缓存任何 LLM 响应
  res.setHeader("Cache-Control", "no-store");
  res.send(text);
}
