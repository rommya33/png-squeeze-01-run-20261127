# PNG Squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/rommya33/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/rommya33/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lossless PNG rewriter that squeezes screenshots into the smallest PNG.
It reads each stored RGBA screenshot and rewrites it in its smallest exact
form — a palette when the image holds at most 256 colours, grey or
grey-and-alpha when every pixel is grey, RGB or RGBA otherwise, with a tRNS
key standing in for an alpha channel when exactly one fully transparent value
exists. Filters are picked per row by the PNG minimum-sum heuristic, and the
whole image is also tried with each single fixed filter; every candidate is
weighed by zlib at level 6 and the winner is written at level 9.

## Run

```sh
node main.ts
# reads /input/<id>/image.png, writes /output/<id>/image.png
```

`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` override `/input` and `/output`.
Node 22, standard library only. No network, no clock, no randomness.
Deterministic: two runs are byte-identical.
