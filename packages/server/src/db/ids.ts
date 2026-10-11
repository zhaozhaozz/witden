import { randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Readable random id such as `role_8k2m4x...`; the prefix tells what kind of object it is. */
export function newId(prefix: string): string {
  let out = "";
  for (let i = 0; i < 14; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}_${out}`;
}
