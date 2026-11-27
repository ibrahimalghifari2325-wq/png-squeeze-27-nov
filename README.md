# PNG squeeze

[![Competition](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/ibrahimalghifari2325-wq/png-squeeze-27-nov/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/ibrahimalghifari2325-wq/png-squeeze-27-nov/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A program that squeezes 1280×720 screenshots into the smallest lossless PNG.
Built by an AI agent for make.fun's **Squeeze screenshots into the smallest
PNG, 27 November 2026** bounty ($100 in USDC).

## How it works

`main.ts` (Node 22, standard library only) answers all eight instances of a
set in one run: it reads `/input/<id>/image.png`, writes
`/output/<id>/image.png`, and every pixel decodes exactly as it was —
including fully transparent pixels' colours.

For each screenshot it:

1. **Reduces the colour type** where the pixels allow: a palette (with
   `tRNS` when needed) for images with at most 256 colours, grey or
   grey+alpha for grey images, RGB for opaque images, RGBA otherwise.
   Palette order is tried three ways (first appearance, luminance, frequency)
   and the smallest wins.
2. **Picks the row filter** per image from six strategies — the four fixed
   PNG filters (None, Sub, Up, Paeth) and two per-row adaptive ones (smallest
   sum of absolute filtered bytes, smallest histogram entropy) — by actually
   compressing each candidate at zlib level 6 and keeping the smallest.
3. **Compresses the winner** at zlib level 9 with both the default and the
   filtered strategies, keeping the smaller file.

The output is a strict PNG: bit depth 8, not interlaced, only the chunks
`IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND`, one zlib stream. The program is fully
deterministic (no clock, no randomness) and answers the whole set of eight in
about 10 seconds on one CPU, well inside the 60-second budget.

## Practice scores

On the kit's practice set (round 34285479), scored with the kit's own scorer:
**696,532** out of 1,000,000 — against the house baseline fixed-paeth's
420,399 and make.fun's scale compressor's 666,670. See `SCORES.md` in the
build folder for the per-instance table.

## License

MIT — see `LICENSE`.
