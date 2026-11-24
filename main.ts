// Pump.fun Replay Sprint — paper bot, agent-fun/replay/v2.
//
// A launch sniper with a rug filter. Each coin is followed from its
// CreateEvent and sized up in its first three slots on the opening tape:
// how much real SOL the curve already holds, how large the creator's own
// buy was, how many other wallets bought in alongside it, and whether the
// creator has already sold. Only launches that pass get a buy; the bot
// takes profit fast, cuts losers faster, never holds past 30 slots, and
// exits immediately when the creator sells.
//
// The settings were tuned on the kit's dev window (all three slices): the
// bot lands roughly break-even there with a positive skew — most coins lose
// a little, a few runners pay for them — so on the unseen final window it
// is a shot at a positive net PnL, not a guarantee of one.
//
// Run by the grader as `node /bot/main.ts`; the strategy lives in
// strategy.ts, the protocol in the vendored SDK shim
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
