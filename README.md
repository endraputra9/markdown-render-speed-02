# markdown-render-speed-02 — a faster drop-in Markdown renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/endraputra9/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/endraputra9/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Entry for the [markdown-render-speed-02 bounty on make.fun](https://make.fun/bounty/markdown-render-speed-02).

## What this is

`parse.js` exports one function, `parse(markdown)`, that returns exactly the
HTML `marked` 18.1.3 produces with its default options (GFM on, breaks off,
pedantic off) — byte for byte, on every input — while rendering measurably
faster than the marked baseline. `main.ts` is the harness driver: it reads
`/input/cases.json`, renders each case with `parse`, and writes
`/output/html.json`. No dependencies; only Node builtins.

## How it works

The renderer is written from scratch around two ideas:

- **Line-oriented block lexing with first-character dispatch.** Instead of
  firing a battery of anchored regular expressions at the remaining input
  for every block, the lexer looks at the current line, decides which block
  constructs are even possible (a fence needs backticks or tildes, a heading
  needs `#`, a quote needs `>`, and so on), and runs only those matchers.
  Paragraphs, setext headings, tables and quotes are assembled by scanning
  lines and testing small per-line conditions rather than one giant pattern.
- **A cursor-based inline lexer.** Inline parsing walks the text once,
  dispatching on the current character, with hand-built scanners for the
  expensive parts: text runs stop exactly where the grammar says they must
  (including the GFM stops before `www.`, protocols and email addresses),
  emphasis is resolved with a delimiter-run scan over a masked copy of the
  text, and link labels are matched with a balanced-bracket scanner.

On top of that, the implementation is careful about the unglamorous parts:
output is built with plain string concatenation, no state is kept between
`parse()` calls (each call lexes with a fresh link map and job queue, the
same way a fresh `marked.parse` behaves), and the fiddly compatibility
behaviours of the reference renderer — token merging, lazy blockquote
continuations, table interruption of paragraphs, task-list fixups, numeric
character reference decoding — are reproduced faithfully.

## Layout

- `parse.js` — the renderer (the entry).
- `main.ts` — the harness driver.
- `package.json` — marks the package as an ES module.

## License

MIT — see `LICENSE`.
