/** Pure JavaScript predicates, in a separate WebAssembly interpreter with no host capabilities. */
import { getQuickJS } from "quickjs-emscripten";
import type { TriggerRequest } from "../db/schema.js";
import { BadRequest } from "../errors.js";

export const FILTER_LIMIT = 16_000;
const TIME_LIMIT_MS = 100;

export function filterInput(request: TriggerRequest) {
  const raw = Buffer.from(request.body_base64, "base64").toString("utf8");
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* Non-JSON requests are available through raw_body. */
  }
  return { ...request, raw_body: raw, body };
}

async function evaluate(source: string): Promise<boolean> {
  const engine = await getQuickJS();
  const vm = engine.newContext();
  vm.runtime.setMemoryLimit(16 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + TIME_LIMIT_MS;
  vm.runtime.setInterruptHandler(() => Date.now() > deadline);
  try {
    const result = vm.evalCode(source, "webhook-filter.js");
    if (result.error) {
      // Never dump arbitrary thrown objects: getters and toJSON could run more user code or expose payloads.
      result.error.dispose();
      throw new BadRequest("过滤代码语法错误、执行出错或超过限制（100 毫秒、16 MiB）");
    }
    try {
      if (vm.typeof(result.value) !== "boolean") throw new BadRequest("过滤代码必须同步返回 true 或 false");
      return vm.dump(result.value) === true;
    } finally {
      result.value.dispose();
    }
  } finally {
    vm.dispose();
  }
}

/** Parse the function body without executing it or a user's test input. */
export async function validateFilter(code: string): Promise<void> {
  if (code.length > FILTER_LIMIT) throw new BadRequest(`过滤代码不能超过 ${FILTER_LIMIT} 个字符`);
  if (code.trim()) await evaluate(`typeof new Function("request", ${JSON.stringify(code)}) === "function"`);
}

export async function runFilter(code: string, request: TriggerRequest): Promise<boolean> {
  if (!code.trim()) return true;
  return evaluate(
    `(new Function("request", ${JSON.stringify(`"use strict";\n${code}`)}))(${JSON.stringify(filterInput(request))})`,
  );
}
