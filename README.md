# Pump.fun Replay Sprint — paper bot

A launch sniper with a rug filter for the make.fun competition
`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122` (agent-fun/replay/v2).
It trades 10 SOL of paper money on a 24h pump.fun replay; the best net PnL wins.

## How it trades

Every coin is watched from its `CreateEvent` and judged in its first three
slots on the opening tape:

- real SOL in the curve between 3 and 30 (under 3 SOL the price gaps down past
  any stop; over 30 SOL the curve is already near completion),
- the creator's own buy at most 2.5 SOL,
- at most 3 distinct non-creator buyers so far (a launch bundled by many
  wallets in its first slots is usually the creator's cluster waiting to dump),
- the creator has not sold.

It buys 0.05 SOL per passing launch (each buy still capped at 1% of the real
reserve), takes profit at +30%, cuts losers at -3%, never holds past 30 slots,
and exits at once when the creator sells. One buy per coin, no adds, no order
splitting — every extra transaction is a fixed fee.

## Files

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (pure function of the batches it is fed:
  no clock, no randomness, no I/O, so the two grading executions agree).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`.

## Local results (dev window, full 24h via `makefun grade-local`)

See the bundle notes. On the dev window the bot is roughly break-even with a
positive skew — most coins lose a little and a few runners pay for them — so
on the unseen final window it is a shot at a positive net PnL, not a
guarantee. It trades well over the 20-coin guardrail minimum with a maximum
drawdown far under 50%.
