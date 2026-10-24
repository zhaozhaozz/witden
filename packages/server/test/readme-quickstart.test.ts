/**
 * The README quick start shows docker-compose.yml and a minimal .env in full, so people can start witden
 * without downloading anything. Keep those copies in step with the repository's files.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
const readme = read("README.md");
const quickStart = readme.slice(readme.indexOf("## 快速开始"), readme.indexOf("\n## ", readme.indexOf("## 快速开始")));

/** The quick start's one fenced block in `lang`. */
function block(lang: string): string {
  const blocks = [...quickStart.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))];
  expect(blocks, `${lang} blocks in the quick start`).toHaveLength(1);
  return blocks[0][1];
}

describe("README quick start", () => {
  it("shows the repository's docker-compose.yml verbatim", () => {
    expect(block("yaml")).toBe(read("docker-compose.yml"));
  });

  it("lists every value docker-compose.yml requires, under the names .env.example documents", () => {
    const names = block("dotenv")
      .split("\n")
      .filter((line) => /^\w+=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));
    const required = [...read("docker-compose.yml").matchAll(/\$\{(\w+):\?/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const name of required) expect(names, name).toContain(name);
    const example = read(".env.example");
    for (const name of names) expect(example, name).toMatch(new RegExp(`^(# )?${name}=`, "m"));
  });
});
