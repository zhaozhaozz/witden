import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../config.js";

/** AES-256-GCM encryption for credentials stored in the database (model keys, bot tokens). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) throw new Error("secret key must be 32 bytes, base64 encoded (witden gen-key)");
    this.key = key;
  }

  static generateKey(): string {
    return randomBytes(32).toString("base64");
  }

  static fromSettings(settings: Settings): SecretBox {
    if (settings.secretKey) return new SecretBox(settings.secretKey);
    const file = path.join(settings.dataDir, "secret.key");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(settings.dataDir, { recursive: true });
      fs.writeFileSync(file, SecretBox.generateKey(), { mode: 0o600 });
    }
    return new SecretBox(fs.readFileSync(file, "utf8").trim());
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
  }

  decrypt(token: string): string {
    const [version, iv, tag, data] = token.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("malformed secret");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("cannot decrypt secret (master key changed?)");
    }
  }
}

let box: SecretBox | null = null;

export function initSecretBox(settings: Settings): SecretBox {
  box = SecretBox.fromSettings(settings);
  return box;
}

export function secretBox(): SecretBox {
  if (!box) throw new Error("secret box not initialised");
  return box;
}

// --- passwords & tokens ---------------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64, { N: 2 ** 14, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, salt, digest] = stored.split("$");
  const expected = Buffer.from(digest, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: 2 ** 14, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export function newToken(prefix = "wdn_"): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- redaction ------------------------------------------------------------------------------------------

const PLAIN_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /wdn_[A-Za-z0-9_-]{20,}/g,
  /wdr_[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];
const PREFIXED_PATTERNS = [
  /(bearer\s+)[A-Za-z0-9._-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)['"]?[^\s'"]{6,}/gi,
];

/** Mask credentials before text reaches logs, audit records or chat messages. */
export function redact(text: string, extra: string[] = []): string {
  if (!text) return text;
  let out = text;
  for (const value of extra) if (value && value.length >= 6) out = out.split(value).join("[REDACTED]");
  for (const p of PLAIN_PATTERNS) out = out.replace(p, "[REDACTED]");
  for (const p of PREFIXED_PATTERNS) out = out.replace(p, (_m, prefix: string) => `${prefix}[REDACTED]`);
  return out;
}

export function redactDeep<T>(value: T, extra: string[] = []): T {
  if (typeof value === "string") return redact(value, extra) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, extra)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, extra)])) as T;
  }
  return value;
}
