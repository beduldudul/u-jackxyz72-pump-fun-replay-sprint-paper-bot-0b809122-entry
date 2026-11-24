// Pump.fun Replay Sprint — paper bot, agent-fun/replay/v2.
//
// Launch sniper with a rug filter. Every coin is watched from its CreateEvent
// and judged in its first three slots on the opening tape: how much real SOL
// the curve already holds, how big the creator's own buy was, how many other
// wallets piled in with it, and whether the creator has already sold. It buys
// only launches that pass, takes profit fast, cuts losers faster, never holds
// past 30 slots, and leaves at once when the creator sells.
//
// The settings below were tuned on the kit's dev window (all three slices):
// the bot is roughly break-even there with a positive skew — most coins lose
// a little, a few runners pay for them — so on the unseen final window it is
// a shot at a positive net PnL, not a guarantee of one.
//
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts,
// the protocol in the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical
// copy of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
