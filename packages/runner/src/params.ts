import { OpError } from "./errors.js";

type Params = Record<string, unknown>;

export function reqString(params: Params, key: string, maxLength = 1_000_000): string {
  const value = optString(params, key, maxLength);
  if (value === undefined) throw new OpError("invalid", `params.${key} is required`);
  return value;
}

export function optString(params: Params, key: string, maxLength = 1_000_000): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new OpError("invalid", `params.${key} must be a string`);
  if (value.length > maxLength) throw new OpError("invalid", `params.${key} is longer than ${maxLength} characters`);
  return value;
}

export function optInt(params: Params, key: string, min: number, max: number): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new OpError("invalid", `params.${key} must be a number`);
  const int = Math.trunc(value);
  if (int < min || int > max) throw new OpError("invalid", `params.${key} must be between ${min} and ${max}`);
  return int;
}

export function reqInt(params: Params, key: string, min: number, max: number): number {
  const value = optInt(params, key, min, max);
  if (value === undefined) throw new OpError("invalid", `params.${key} is required`);
  return value;
}

export function optBool(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new OpError("invalid", `params.${key} must be a boolean`);
  return value;
}

export function optEnum<T extends string>(params: Params, key: string, values: readonly T[]): T | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new OpError("invalid", `params.${key} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function optEnv(params: Params, key: string): Record<string, string> | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new OpError("invalid", `params.${key} must be an object`);
  const env: Record<string, string> = {};
  for (const [name, v] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) throw new OpError("invalid", `invalid environment variable name: ${name}`);
    if (typeof v !== "string") throw new OpError("invalid", `environment variable ${name} must be a string`);
    env[name] = v;
  }
  return env;
}
