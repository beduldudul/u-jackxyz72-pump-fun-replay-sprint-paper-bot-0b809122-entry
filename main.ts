// Thin entry point: builds the launch sniper with its default settings and
// hands each replay batch to it for orders.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch: (state, batch) => strategy.onBatch(state, batch) });
