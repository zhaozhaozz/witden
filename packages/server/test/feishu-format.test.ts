/** Message text between witden's Markdown and Feishu's rich text (the post's md element). */
import { describe, expect, it } from "vitest";
import { fromFeishuPost, toFeishu } from "../src/integrations/feishu-format.js";

const opts = { baseUrl: "https://witden.example.com", viewUrl: "https://witden.example.com/topics/top_1" };

describe("Markdown to Feishu", () => {
  it("keeps what Feishu renders as written", () => {
    const md =
      "**粗体**和*斜体*、~~删除~~、`a<b`\n第二行\n\n- 第一\n  - 嵌套\n- [x] 完成\n\n1. 甲\n2. 乙\n\n```ts\nconst a = 1;\n```\n\n---\n\n[site](https://x.dev) <https://y.dev>";
    expect(toFeishu(md, opts)).toBe(md);
  });

  it("puts blank lines around tables and after quotes", () => {
    expect(toFeishu("结果如下：\n| a | b |\n|---|---|\n| 1 | 2 |\n> 注", opts)).toBe(
      "结果如下：\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> 注",
    );
    expect(toFeishu("> 引用\n> 第二行\n- 列表", opts)).toBe("> 引用\n> 第二行\n\n- 列表");
  });

  it("links into witden get the console address; other schemes keep the label only", () => {
    expect(toFeishu("[任务](/tasks/t1) 和 [x](javascript:alert(1)) 和 [**信**](mailto:a@b.c)", opts)).toBe(
      "[任务](https://witden.example.com/tasks/t1) 和 x 和 **信**",
    );
    expect(toFeishu("见 [文件][f]\n\n[f]: /files/a.png", opts)).toBe(
      "见 [文件][f]\n\n[f]: https://witden.example.com/files/a.png",
    );
  });

  it("images become links, so Feishu fetches nothing a role wrote", () => {
    expect(
      toFeishu("看图 ![屏幕](https://evil.example/x.png?d=secret) 和 ![](/files/b.png) 和 ![本地](a.png)", opts),
    ).toBe(
      "看图 [🖼 屏幕](https://evil.example/x.png?d=secret) 和 [🖼 图片](https://witden.example.com/files/b.png) 和 \\[图片：本地\\]",
    );
    expect(toFeishu("![][ref]\n\n[ref]: https://x.dev/y.png", opts)).toBe("[🖼 ][ref]\n\n[ref]: https://x.dev/y.png");
    expect(toFeishu("```md\n![代码里](a.png)\n```", opts)).toBe("```md\n![代码里](a.png)\n```");
  });

  it("raw HTML shows as written, so a role cannot @ everyone; <u> is kept", () => {
    expect(toFeishu('<at user_id="all"></at> 注意 <u>重点</u> <br>', opts)).toBe(
      '&lt;at user_id="all">&lt;/at> 注意 <u>重点</u> &lt;br>',
    );
    expect(toFeishu("<details>\n<summary>更多</summary>\n</details>", opts)).toBe(
      "&lt;details>\n&lt;summary>更多&lt;/summary>\n&lt;/details>",
    );
  });

  it("headings come down to chat size; Setext ones become ATX", () => {
    expect(toFeishu("# 标题\n\n## 小节\n\n#### 细节", opts)).toBe("#### 标题\n\n##### 小节\n\n##### 细节");
    expect(toFeishu("#### 只有小标题", opts)).toBe("#### 只有小标题");
    expect(toFeishu("总结\n===\n\n正文", opts)).toBe("#### 总结\n\n正文");
  });

  it("a Mermaid diagram links to witden, where it is drawn", () => {
    expect(toFeishu("```mermaid\ngraph TD; A-->B\n```", opts)).toBe(
      "*流程图（飞书不能显示图形，[在 witden 中查看](https://witden.example.com/topics/top_1)）：*\n\n```mermaid\ngraph TD; A-->B\n```",
    );
  });

  it("linked people become Feishu mentions, not inside code", () => {
    const mentions = new Map([
      ["Alice 张", "ou_alice"],
      ["Al", "ou_al"],
    ]);
    expect(toFeishu("@Alice 张 和 @Al 看一下 `@Al`", { ...opts, mentions })).toBe(
      '<at user_id="ou_alice">Alice 张</at> 和 <at user_id="ou_al">Al</at> 看一下 `@Al`',
    );
  });
});

describe("Feishu posts to Markdown", () => {
  it("styles, links, code blocks and rules", () => {
    const post = {
      zh_cn: {
        title: "周报",
        content: [
          [
            { tag: "text", text: "完成 " },
            { tag: "text", text: "登录修复 ", style: ["bold"] },
            { tag: "text", text: "旧方案", style: ["lineThrough", "italic"] },
            { tag: "a", text: "PR", href: "https://github.com/acme/api/pull/1" },
          ],
          [{ tag: "code_block", language: "GO", text: "fmt.Println(1)\n" }],
          [{ tag: "hr" }],
          [
            { tag: "md", text: "- 列表" },
            { tag: "emotion", emoji_type: "SMILE" },
          ],
        ],
      },
    };
    expect(fromFeishuPost(post)).toBe(
      "周报\n完成 **登录修复** *~~旧方案~~*[PR](https://github.com/acme/api/pull/1)\n\n```GO\nfmt.Println(1)\n```\n\n---\n\n- 列表",
    );
    expect(fromFeishuPost({})).toBeNull();
  });
});
