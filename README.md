# makefun-sitegen-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/muhammadaldy198/makefun-sitegen-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/muhammadaldy198/makefun-sitegen-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0: it builds the same static site output tree, byte for byte, in a fraction of the CPU time. Dependency-free ES module (`solve.js`) plus a small Node driver (`main.ts`).

## How it works

`run(input)` in `solve.js` reimplements the whole makefun-site build from scratch — front matter, Markdown, templates, collections, permalinks, the report — with the same semantics, tuned for speed:

- **No per-line regexes.** Front matter is scanned with `indexOf` and hand-checked character classes; the closing `---` is found before any line is read, so an unclosed block refuses with that reason.
- **Markdown is one fused pass.** A first-character dispatch picks the block kind (fence, heading, break, quote, list, paragraph) without a chain of classifier calls; inline markup jumps between structural characters with `indexOf` instead of a per-character loop, and backslash-escape parity is decided by counting the run of backslashes before a match.
- **Templates are parsed once and rendered by an interpreter** with reusable per-`for` scopes (saved and restored per render, so no allocation per loop iteration) and one shared root scope per site.
- **Hot values are cached:** slugs, long dates, tag and link views, and the cards of every post. Word counting inlines the whitespace test instead of calling it per character.

Measured on the practice set (3 cases, median CPU per case): ~120 ms against the house baseline's ~590 ms, about 5× faster, with byte-identical output on the practice cases, 30 fresh generator draws and a set of adversarial inputs (backslash runs, unclosed front matter, template include cycles, loop variables named `loop`).

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=3p0axm2p&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
