/**
 * The README quick start writes docker-compose.yml and a minimal .env from here-documents, so people can start
 * witden without downloading anything. Keep those copies in step with the repository's files.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");
const readme = read("README.md");

/** The body of the README's here-document that writes `file` (`cat > file <<EOF` or `(...; cat > file) <<EOF`). */
function heredoc(file: string): string {
  const name = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`cat > ${name}\\)? <<'?EOF'?\\n([\\s\\S]*?)\\nEOF\\n`).exec(readme);
  if (!match) throw new Error(`README has no here-document writing ${file}`);
  return match[1];
}

describe("README quick start", () => {
  it("writes the repository's docker-compose.yml verbatim", () => {
    expect(`${heredoc("docker-compose.yml")}\n`).toBe(read("docker-compose.yml"));
  });

  it("sets every value docker-compose.yml requires, under the names .env.example documents", () => {
    const env = new Map(
      heredoc(".env")
        .split("\n")
        .map((line) => line.split(/=(.*)/s, 2) as [string, string]),
    );
    const required = [...read("docker-compose.yml").matchAll(/\$\{(\w+):\?/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const name of new Set(required)) expect(env.get(name), name).toBeTruthy();
    const example = read(".env.example");
    for (const name of env.keys()) expect(example, name).toMatch(new RegExp(`^(# )?${name}=`, "m"));
  });
});
