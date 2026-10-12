/** Message text between witden's Markdown and Slack's mrkdwn. */
import { describe, expect, it } from "vitest";
import { fromSlack, toSlack } from "../src/integrations/slack-format.js";

const opts = { baseUrl: "https://witden.example.com", viewUrl: "https://witden.example.com/topics/top_1" };
const ZW = "​";

describe("Markdown to Slack", () => {
  it("inline marks, links, code and escaping", () => {
    expect(toSlack("**bold** and *it* and ~~gone~~ and `a<b`", opts)).toBe("*bold* and _it_ and ~gone~ and `a&lt;b`");
    expect(toSlack("[任务](/tasks/t1) 和 [site](https://x.dev) 和 https://y.dev", opts)).toBe(
      "<https://witden.example.com/tasks/t1|任务> 和 <https://x.dev|site> 和 <https://y.dev>",
    );
    expect(toSlack("a < b & c > d", opts)).toBe("a &lt; b &amp; c &gt; d");
    expect(toSlack("[x](javascript:alert(1))", opts)).toBe("x");
  });

  it("marks next to CJK text get zero-width boundaries so Slack applies them", () => {
    expect(toSlack("这是**粗体**文字", opts)).toBe(`这是${ZW}*粗体*${ZW}文字`);
    expect(toSlack("**粗体** 开头", opts)).toBe("*粗体* 开头");
  });

  it("headings, lists, task lists, quotes and rules", () => {
    const md =
      "## 发布清单\n\n- 第一\n  - 嵌套\n- 第二\n\n1. 甲\n2. 乙\n\n- [x] 构建\n- [ ] 文档\n\n> 引用\n> 第二行\n\n---";
    expect(toSlack(md, opts)).toBe(
      [
        "*发布清单*",
        "• 第一\n    ◦ 嵌套\n• 第二",
        "1. 甲\n2. 乙",
        "☑ 构建\n☐ 文档",
        "> 引用\n> 第二行",
        "──────────",
      ].join("\n\n"),
    );
  });

  it("code blocks lose the language tag; Mermaid points back to witden", () => {
    expect(toSlack("```bash\nnpm ci && echo <ok>\n```", opts)).toBe("```\nnpm ci &amp;&amp; echo &lt;ok&gt;\n```");
    expect(toSlack("```mermaid\nflowchart LR\n  A --> B\n```", opts)).toBe(
      "_流程图（Slack 不能显示图形，<https://witden.example.com/topics/top_1|在 witden 中查看>）：_\n```\nflowchart LR\n  A --&gt; B\n```",
    );
  });

  it("tables become aligned monospace blocks (CJK counts double)", () => {
    expect(toSlack("| 项目 | 状态 |\n|---|---:|\n| 构建 | ok |\n| CHANGELOG | 待更新 |", opts)).toBe(
      "```\n项目      |   状态\n----------|-------\n构建      |     ok\nCHANGELOG | 待更新\n```",
    );
  });

  it("images become links; platform files get the public address", () => {
    expect(toSlack("![截图](/api/files/file_1) ![x](data:image/png;base64,AAAA)", opts)).toBe(
      "<https://witden.example.com/api/files/file_1|🖼 截图> [图片：x]",
    );
  });
});

describe("Slack to Markdown", () => {
  it("marks, links, mentions and escapes", () => {
    const names = new Map([["U1", "alice"]]);
    expect(fromSlack("*粗体* _斜体_ ~删除~ <@U1> <@U9> <#C1|general> <!here>", names)).toBe(
      "**粗体** *斜体* ~~删除~~ @alice @U9 #general @here",
    );
    expect(fromSlack("see <https://x.dev|the site> and <https://y.dev> or <mailto:a@b.c|a@b.c>")).toBe(
      "see [the site](https://x.dev) and https://y.dev or a@b.c",
    );
    expect(fromSlack("a &lt;b&gt; &amp; c")).toBe("a <b> & c");
  });

  it("code is kept verbatim; bullets become lists; a leading # stays text", () => {
    expect(fromSlack("run ```npm *ci*``` then `a_b_c`")).toBe("run \n```\nnpm *ci*\n```\n then `a_b_c`");
    expect(fromSlack("• one\n    ◦ two\n# not a heading")).toBe("- one\n  - two\n\\# not a heading");
  });
});
