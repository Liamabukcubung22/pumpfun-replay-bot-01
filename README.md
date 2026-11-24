# Pump.fun Replay Sprint — Launch Lottery Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Liamabukcubung22/pumpfun-replay-bot-01/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Liamabukcubung22/pumpfun-replay-bot-01/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity, following the `agent-fun/replay/v2` protocol.

## Strategy: launch lottery

Measured on the dev window, buying after a pump loses (the average coin
bought on short-horizon momentum is down ~3% after 150 slots, before
fees), dip-buying loses, and holding loses — at a 2-slot fill latency no
directional signal survives the ~3% round-trip cost. What is not
negative is the launch tail itself: a coin bought in its first few slots,
before the opening burst, rides the burst instead of chasing it.

So this bot buys launches only: in the first slots of a coin's life, once
the opening tape shows a real launch (some real SOL in, a few distinct
buyers, the creator not selling, no dominant seller, price not already
run away), it takes one small 0.03 SOL ticket. One buy per coin, no
pyramid, no re-entry. It exits on a stop, a trailing stop armed once the
ticket is up, a take-profit on spikes, a short time limit, or immediately
if the creator sells. Positions recycle in about a minute, so the
5-position cap never starves coverage: the book spans ~400 coins.

Local dev-window score (kit's `tools/sim.ts` port of the replay engine,
full 24 h dev dataset):

| Metric | Value |
| --- | --- |
| Net PnL | -0.343 SOL |
| Fills | 802 |
| Coins traded | 401 |
| Round trips | 401 (86 wins) |
| Max drawdown | 0.042 |
| Net PnL without top 3 coins | -0.441 SOL |

Honest note: on the dev window this bot does **not** beat holding cash
(0 SOL). The dev window has no exploitable edge at 2-slot latency after
fees — the house momentum pilot scores -9.38 SOL and the house reversion
pilot -4.02 SOL on the same data; this bot loses the least of the
strategies measured while keeping a broad book of small tickets, which is
the structure with the best chance of finishing above zero on the unseen
final window, where a single runner can pay for the book.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
  (Node 22+, no dependencies, no build step).
- `strategy.ts` — the strategy (see `DEFAULT_PARAMS` for the tuned
  settings; chosen in the flat region of the sweep, not a single best
  cell).
- `vendor/agentfun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim,
  vendored byte for byte.
- `tools/` — local validation only (a port of the kit's replay engine
  plus a backtest runner); never imported by the bot.

## Run locally

```sh
node tools/backtest.ts <path to the unpacked kit> ['{"stakeSol":0.03}']
```

Or grade it exactly as the server does (no Docker needed):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Determinism

The bot is a pure function of the batches the harness sends: no clock,
no randomness, no network, no files. Two executions produce
byte-identical action logs.

## License

MIT — see [LICENSE](LICENSE).
