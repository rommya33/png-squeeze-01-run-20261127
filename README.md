[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/rommya33/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/rommya33/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# PNG Squeeze v4

A lossless PNG rewriter for the make.fun bounty
"Squeeze screenshots into the smallest PNG, 27 November 2026".
It reads each stored RGBA screenshot and rewrites it in the smallest exact
form it can take: a palette when the image holds at most 256 colours, grey
or grey-and-alpha when every pixel is grey, RGB or RGBA otherwise, with a
tRNS key standing in for an alpha channel when exactly one fully transparent
value exists and no opaque pixel uses it.

v4 keeps v3's correct optimal-parse DEFLATE (shortest-path dynamic program,
hash-chain LZ77 matcher, length-limited Huffman codes) and adds the thing
v3 lacked: a hard time budget. v3 scored 713,779 on the practice set but
took 66.9 s on the hardest generated set — past the 60 s wall, which would
score 0. v4 measures each set's hardness up front from the screen itself
and spends its optimal-parse work where it buys the most points per second,
so the run finishes well under 60 s on any set while never scoring below v2.

Measured locally (kit scorer): practice set **713,779** in ~41 s;
four generated sets **712,842 / 707,522 / 708,901 / 723,271** (mean
713,134), all in 36–45 s, all 8/8 exact, two runs byte-identical.

## Run

```sh
node main.ts
```

It reads `/input/<id>/image.png` for `i001`–`i008` and writes
`/output/<id>/image.png`. `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
override the directories. Node 22, standard library only; no network,
no clock for decisions, no randomness — two runs are byte-identical.
