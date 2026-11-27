# PNG Squeeze v2

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/rommya33/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/rommya33/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lossless PNG rewriter that squeezes screenshots into the smallest exact PNG.
It rewrites each image in its best form — palette, grey, RGB or RGBA, with a
tRNS key when one transparent value can stand in for an alpha channel — and
picks each row's filter from the five fixed filters, the minimum-sum and
fewest-pairs heuristics, and a brute-force zlib weighing, then writes the
winning stream at zlib level 9 (also tried with the filtered-data strategy
and the deepest memory).

## Run

```sh
node main.ts
# reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR (default /output)
```

Node 22, standard library only. No network, no clock, no randomness.
Deterministic: two runs are byte-identical. One run answers all 8 images
in well under 60 seconds.
