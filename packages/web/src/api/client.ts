// Thin fetch wrapper around the witden REST API.

const TOKEN_KEY = "witden.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Error raised for any non-2xx response; mirrors `{"error": {code, message, detail}}`. */
export class ApiError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail ?? {};
  }
}

let onUnauthorized: (() => void) | null = null;

/** The auth layer registers a handler so an expired session sends the user back to login. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// Frequent backend messages (English) shown to people in Chinese; anything else passes through unchanged.
const MESSAGE_ZH: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^authentication required$/, () => "登录已失效，请重新登录"],
  [/^invalid email or password$/, () => "邮箱或密码不正确"],
  [/^this approval no longer belongs to the task's current wait/, () => "这条审批已不属于当前运行，请刷新后重试。"],
  [/^missing permission ([\w.]+)( on (\S+))?$/, (m) => `缺少权限：${m[1]}${m[3] ? `（对象 ${m[3]}）` : ""}`],
  [/^this file draws on material you are not allowed to see$/, () => "这个文件用到了你无权查看的资料，不能下载"],
  [/^this task has read material you are not allowed to see/, () => "该任务读取了你无权查看的资料，执行日志已隐藏"],
  [
    /^you are not a \(verified\) member of that conversation$/,
    () => "你不是该会话的（已验证）成员，不能把话题发布到这里",
  ],
  [/^only console accounts/, () => "只有控制台账号可以执行这个操作"],
  [/^you cannot view this topic$/, () => "你无权查看这个话题"],
];

function localize(message: string): string {
  for (const [re, fn] of MESSAGE_ZH) {
    const m = message.match(re);
    if (m) return fn(m);
  }
  return message;
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  if (body && typeof body === "object") {
    const err = (body as { error?: { code?: string; message?: string; detail?: Record<string, unknown> } }).error;
    if (err) return new ApiError(res.status, err.code ?? "error", localize(err.message ?? res.statusText), err.detail);
    // Bodies without an `error` object: {"detail": [{loc, msg}]} or {"detail": "..."}
    const detail = (body as { detail?: unknown }).detail;
    if (Array.isArray(detail)) {
      const msg = detail
        .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg ?? ""}`)
        .join("; ");
      return new ApiError(res.status, "validation_error", `请求参数有误：${msg}`);
    }
    if (typeof detail === "string") return new ApiError(res.status, "error", detail);
  }
  return new ApiError(res.status, "http_error", `请求失败（HTTP ${res.status}）`);
}

async function send(method: string, path: string, body?: unknown, query?: Query): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "network_error", "无法连接服务器，请检查网络或服务是否运行");
  }
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw err;
  }
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GETs are idempotent: retry once on a transient server or network failure. */
async function sendWithRetry(method: string, path: string, body?: unknown, query?: Query): Promise<Response> {
  try {
    return await send(method, path, body, query);
  } catch (err) {
    const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
    if (method !== "GET" || !transient) throw err;
    await sleep(250 + Math.random() * 250);
    return await send(method, path, body, query);
  }
}

async function json<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await sendWithRetry(method, path, body, query);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => json<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown, query?: Query) => json<T>("POST", path, body ?? {}, query),
  patch: <T>(path: string, body?: unknown) => json<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => json<T>("PUT", path, body ?? {}),
  del: <T>(path: string, body?: unknown) => json<T>("DELETE", path, body),
  upload: <T>(path: string, form: FormData) => json<T>("POST", path, form),
  /** Authenticated binary download (files, screenshots); the caller owns the returned object URL. */
  blob: async (path: string, query?: Query): Promise<Blob> => {
    const res = await sendWithRetry("GET", path, undefined, query);
    return await res.blob();
  },
};

/** Download an authenticated file by streaming it into an object URL and clicking a temporary link. */
export async function downloadFile(fileId: string, name: string): Promise<void> {
  const blob = await api.blob(`/api/files/${encodeURIComponent(fileId)}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
