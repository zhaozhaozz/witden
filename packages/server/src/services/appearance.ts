/**
 * How roles and computers look: badge colours and role avatars. Uploaded avatars are stored by content hash
 * and served without authentication (they work in <img> tags and as Slack icons); the hash makes the URL
 * unguessable, and only raster formats are accepted (no SVG, which could carry script).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { settings } from "../config.js";
import { BadRequest } from "../errors.js";

const COLOR = /^#[0-9a-f]{6}$/i;
const AVATAR_FILE = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;
export const MAX_AVATAR_BYTES = 1024 * 1024;

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** "#rrggbb" (lower case) or null; anything else is refused. */
export function parseColor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (!COLOR.test(s)) throw new BadRequest("color must be a hex colour like #3366cc");
  return s.toLowerCase();
}

/** An uploaded avatar (/api/avatars/...), an http(s) image URL, or null. */
export function parseAvatarUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (s.startsWith("/api/avatars/") && AVATAR_FILE.test(s.slice("/api/avatars/".length))) return s;
  if (/^https?:\/\/\S+$/i.test(s) && s.length <= 2000) return s;
  throw new BadRequest("avatar_url must be an http(s) image URL or an uploaded avatar");
}

function sniff(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "webp";
  return null;
}

const avatarDir = () => path.join(settings().dataDir, "avatars");

/** Store an image and return its URL. The same image always gets the same URL. */
export function saveAvatar(buf: Buffer): string {
  if (buf.length > MAX_AVATAR_BYTES) throw new BadRequest("the avatar must be at most 1 MB");
  const ext = sniff(buf);
  if (!ext) throw new BadRequest("the avatar must be a PNG, JPEG, GIF or WebP image");
  const name = `${createHash("sha256").update(buf).digest("hex")}.${ext}`;
  const file = path.join(avatarDir(), name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(avatarDir(), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
  }
  return `/api/avatars/${name}`;
}

/** The stored file for a served name, or null. */
export function avatarFile(name: string): { file: string; type: string } | null {
  const m = AVATAR_FILE.exec(name);
  if (!m) return null;
  const file = path.join(avatarDir(), name);
  return fs.existsSync(file) ? { file, type: TYPES[m[1]] } : null;
}

/** Absolute form of an avatar URL for places outside the console (e.g. Slack icons). */
export function absoluteAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("/") ? settings().publicUrl.replace(/\/+$/, "") + url : url;
}
