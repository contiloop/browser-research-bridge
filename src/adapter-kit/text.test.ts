import { describe, expect, it } from "vitest";
import { decodeEntities, tokenizeHtml } from "./html.js";
import { cleanInlineText, clipText, extractText, snapshotToText } from "./text.js";

describe("tokenizeHtml / decodeEntities", () => {
  it("splits tags, attributes, comments and text", () => {
    const tokens = tokenizeHtml(`<a href="x?a=1&amp;b=2" data-x='y' hidden>hi</a><!-- c --><br/>`);
    expect(tokens).toEqual([
      {
        type: "start",
        name: "a",
        attrs: { href: "x?a=1&b=2", "data-x": "y", hidden: "" },
        selfClosing: false,
      },
      { type: "text", text: "hi" },
      { type: "end", name: "a" },
      { type: "comment", text: " c " },
      { type: "start", name: "br", attrs: {}, selfClosing: true },
    ]);
  });

  it("keeps raw-text element content as one text token", () => {
    const tokens = tokenizeHtml(`<script>if (a < b) { x = "</p><div>"; }</script><p>t</p>`);
    expect(tokens[1]).toEqual({ type: "text", text: `if (a < b) { x = "</p><div>"; }` });
    expect(tokens[2]).toEqual({ type: "end", name: "script" });
  });

  it("treats a stray < and an unterminated tag as text", () => {
    expect(tokenizeHtml("a < b")).toEqual([{ type: "text", text: "a < b" }]);
    expect(tokenizeHtml("x <div class='y")).toEqual([{ type: "text", text: "x <div class='y" }]);
  });

  it("decodes named and numeric references", () => {
    expect(
      decodeEntities("&lt;a&gt; &amp; &quot;q&quot; &#39;s&#x27; &mdash; &nbsp;&hellip; &unknown;"),
    ).toBe(`<a> & "q" 's' \u2014 \u00a0\u2026 &unknown;`);
    expect(decodeEntities("&#0; &#xD800;")).toBe("\ufffd \ufffd");
  });
});

describe("extractText", () => {
  it("renders headings, paragraphs (unclosed <p>), line breaks and inline markup", () => {
    const html = `<h1>Title &amp; more</h1><p>First   para<br>line two<p>Second <b>bold</b> and <a href="/x">a link</a>.`;
    expect(extractText(html)).toBe("# Title & more\n\nFirst para\nline two\n\nSecond bold and a link.");
  });

  it("renders nested and ordered lists", () => {
    const html = `<p>Intro</p><ul><li>one<li>two<ol start="3"><li>a</li><li>b</li></ol></li></ul><p>After</p>`;
    expect(extractText(html)).toBe("Intro\n\n- one\n- two\n  3. a\n  4. b\n\nAfter");
  });

  it("fences pre blocks and keeps their whitespace", () => {
    expect(extractText(`<p>Code:</p><pre><code>if x:\n    y()\n</code></pre><p>end</p>`)).toBe(
      "Code:\n\n```\nif x:\n    y()\n```\n\nend",
    );
  });

  it("joins table cells with pipes", () => {
    expect(extractText(`<table><tr><th>a</th><th>b</th></tr><tr><td>1<td>2</tr></table>`)).toBe(
      "a | b\n1 | 2",
    );
  });

  it("drops navigation, asides, footers, ads, comments, hidden and script regions", () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head><body>
      <nav><a href="/">Home</a></nav>
      <div role="banner">Site banner</div>
      <article><h2>Story</h2><p>Body text.</p>
        <div class="ad-slot">BUY NOW</div>
        <div class="share-bar">Share</div>
        <aside>Related</aside>
        <div hidden>secret</div><div aria-hidden="true">icon</div><div style="display: none">x</div>
        <p>More body.</p>
      </article>
      <section id="comments"><p>a comment</p><div><p>nested</p></div></section>
      <footer>© site</footer>
      <script>document.write("<p>injected</p>")</script><noscript>enable js</noscript>
      <button>Subscribe</button>
    </body></html>`;
    expect(extractText(html)).toBe("## Story\n\nBody text.\n\nMore body.");
  });

  it("keeps boilerplate when asked and drops extra class names", () => {
    const html = `<nav>Menu</nav><div class="x-promo-box">Promo</div><p>Body</p>`;
    expect(extractText(html, { keepBoilerplate: true })).toBe("Menu\n\nPromo\n\nBody");
    expect(extractText(html, { keepBoilerplate: true, dropClassNames: ["X-Promo-Box"] })).toBe(
      "Menu\n\nBody",
    );
  });

  it("can keep link targets inline", () => {
    const html = `<p>See <a href="/doc">the docs</a> and <a href="https://e.com/x">https://e.com/x</a>.</p>`;
    expect(extractText(html, { links: "inline", baseUrl: "https://site.example/a/" })).toBe(
      "See the docs (https://site.example/doc) and https://e.com/x.",
    );
  });

  it("never treats optional-end-tag elements as droppable containers", () => {
    expect(extractText(`<p class="comment">kept<p>next`)).toBe("kept\n\nnext");
  });

  it("returns an empty string for markup without text", () => {
    expect(extractText("<div><script>x</script></div>")).toBe("");
  });
});

describe("snapshotToText", () => {
  it("renders an Aside accessibility snapshot without navigation and controls", () => {
    const snapshot = [
      '- title: "Story | Site" [url=https://site.example/a]',
      "- navigation:",
      '  - link "Home" [ref=e1]',
      '- heading "Big news" [level=1] [ref=e2]',
      "- paragraph:",
      '  - text: "First"',
      '  - link "linked words" [ref=e3]',
      '  - text: "end."',
      '- button "Share" [ref=e4]',
      "- list:",
      '  - listitem: "one"',
      '  - listitem: "two"',
      '- paragraph: "Second paragraph."',
    ].join("\n");
    expect(snapshotToText(snapshot)).toBe(
      "# Big news\n\nFirst linked words end.\n\n- one\n- two\n\nSecond paragraph.",
    );
  });
});

describe("cleanInlineText / clipText", () => {
  it("collapses whitespace and decodes entities", () => {
    expect(cleanInlineText("  a\n\t b&nbsp;&amp; c ")).toBe("a b & c");
    expect(cleanInlineText(null)).toBe("");
  });

  it("clips at a word boundary with an ellipsis", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("the quick brown fox jumps", 16)).toBe("the quick brown…");
    expect(clipText("abcdefghijklmnop", 8)).toBe("abcdefg…");
  });
});
