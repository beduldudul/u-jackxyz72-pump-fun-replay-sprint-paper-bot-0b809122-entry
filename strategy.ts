// Fresh launch sniper for the replay sprint: watches each new coin from birth,
// scores its opening tape over the first few slots, and only steps in when the
// early flow looks clean. Winners are banked quickly, losers are cut sooner,
// and nothing is held past the holding cap.

import type { BotState, Batch, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  stakeLamports: number;
  minBuyLamports: number;
  maxAdds: number;
  addStepBps: number;
  addDelay: number;
  addLamports: number;
  addMinFlowLamports: number;
  minRealSol: number;
  maxRealSol: number;
  minDevBuy: number;
  maxDevBuy: number;
  minTrades: number;
  minBuyers: number;
  maxBuyers: number;
  maxSellRatioBps: number;
  maxBigSellBps: number;
  minRunupBps: number;
  maxRunupBps: number;
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  skipDevSold: boolean;
  buySlippageBps: number;
  tp1Bps: number;
  tp1PartBps: number;
  slAfterTp1Bps: number;
  tpBps: number;
  slBps: number;
  trailArmBps: number;
  trailBps: number;
  maxHold: number;
  exitOnDevSell: boolean;
  staleSlots: number;
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 50000000,
  minBuyLamports: 5000000,
  maxAdds: 0,
  addStepBps: 0,
  addDelay: 2,
  addLamports: 100000000,
  addMinFlowLamports: 0,
  minRealSol: 3000000000,
  maxRealSol: 30000000000,
  minDevBuy: 0,
  maxDevBuy: 2500000000,
  minTrades: 0,
  minBuyers: 0,
  maxBuyers: 3,
  maxSellRatioBps: 10000,
  maxBigSellBps: 10000,
  minRunupBps: 0,
  maxRunupBps: 1000000,
  flowWindow: 10,
  minFlowLamports: -1000000000000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10000,
  tp1Bps: 1000000,
  tp1PartBps: 0,
  slAfterTp1Bps: 0,
  tpBps: 3000,
  slBps: 300,
  trailArmBps: 1000000,
  trailBps: 0,
  maxHold: 30,
  exitOnDevSell: true,
  staleSlots: 1000000,
  exitFlowLamports: 1000000000000,
};

// One recent trade kept for the short-window flow read.
interface Tick {
  slot: number;
  buying: boolean;
  lamports: bigint;
  wallet: string;
}

// Everything remembered about one launch, from its birth onward.
interface CoinTrack {
  birthSlot: number;
  maker: string;
  startVq: bigint;
  startVt: bigint;
  makerBought: bigint;
  tradeCount: number;
  buyers: Set<string>;
  boughtLamports: bigint;
  soldByOthers: bigint;
  worstSellBps: bigint;
  makerSold: boolean;
  lastTradeSlot: number;
  ticks: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastVq: bigint;
  lastVt: bigint;
  lastBuySlot: number;
  finished: boolean;
  finishedCurve: boolean;
}

// An open holding, tracked from the fill that opened it.
interface HeldTrack {
  openedSlot: number;
  feesPaid: bigint;
  peak: bigint;
  tookFirst: boolean;
}

// Quote a token sale through the curve, net of the 125 bps curve fee.
function quoteOut(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * 125n + 9999n) / 10000n;
  const net = gross - fee;
  return net < 0n ? 0n : net;
}

// Net lamports and distinct outside buyers inside the trailing window.
function windowFlow(note: CoinTrack, nowSlot: number, span: number): { net: bigint; buyers: number } {
  const cutoff = nowSlot - span;
  note.ticks = note.ticks.filter((t) => t.slot > cutoff);
  let net = 0n;
  const seen = new Set<string>();
  for (const t of note.ticks) {
    if (t.buying) {
      net += t.lamports;
      if (t.wallet !== note.maker) seen.add(t.wallet);
    } else {
      net -= t.lamports;
    }
  }
  return { net, buyers: seen.size };
}

export function createStrategy(p: Params): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const coins = new Map<string, CoinTrack>();
  const held = new Map<string, HeldTrack>();
  const selling = new Set<string>();

  function freshCoin(mint: string, slot: number, maker: string, vq0: bigint, vt0: bigint): CoinTrack {
    const note: CoinTrack = {
      birthSlot: slot,
      maker,
      startVq: vq0,
      startVt: vt0,
      makerBought: 0n,
      tradeCount: 0,
      buyers: new Set<string>(),
      boughtLamports: 0n,
      soldByOthers: 0n,
      worstSellBps: 0n,
      makerSold: false,
      lastTradeSlot: slot,
      ticks: [],
      buysSent: 0,
      spentSent: 0n,
      lastVq: 0n,
      lastVt: 0n,
      lastBuySlot: 0,
      finished: false,
      finishedCurve: false,
    };
    coins.set(mint, note);
    return note;
  }

  function hasPending(state: BotState, mint: string, side: string): boolean {
    for (const entry of state.pending.values()) {
      if (entry.order.mint === mint && entry.order.side === side) return true;
    }
    return false;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const nowSlot = state.slot;
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const fee = state.txFeeLamports();

    // Freshest quotes first, curve as fallback.
    const marks = new Map<string, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks ?? []) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }
    function reservesFor(mint: string): { vq: bigint; vt: bigint } | null {
      const mark = marks.get(mint);
      if (mark) return mark;
      const curve = state.curves.get(mint);
      if (!curve) return null;
      return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
    }

    // Read every event in this batch into the per-coin tape.
    for (const ev of batch.events ?? []) {
      if (ev.event === 'CreateEvent') {
        if (!coins.has(ev.mint)) {
          freshCoin(
            ev.mint,
            ev.slot,
            ev.creator ?? '',
            BigInt(ev.virtual_quote_reserves ?? '0'),
            BigInt(ev.virtual_token_reserves ?? '0'),
          );
        }
      } else if (ev.event === 'TradeEvent') {
        let note = coins.get(ev.mint);
        if (!note) {
          note = freshCoin(
            ev.mint,
            ev.slot,
            ev.creator ?? '',
            BigInt(ev.virtual_quote_reserves ?? '0'),
            BigInt(ev.virtual_token_reserves ?? '0'),
          );
        }
        const buying = ev.is_buy === true;
        const sol = BigInt(ev.sol_amount ?? '0');
        const wallet = ev.user ?? '';
        note.tradeCount += 1;
        note.lastTradeSlot = ev.slot;
        note.ticks.push({ slot: ev.slot, buying, lamports: sol, wallet });
        if (buying) {
          note.boughtLamports += sol;
          if (wallet === note.maker && ev.slot === note.birthSlot) {
            note.makerBought += sol;
          } else if (wallet !== note.maker) {
            note.buyers.add(wallet);
          }
        } else {
          if (wallet === note.maker) {
            note.makerSold = true;
          } else {
            note.soldByOthers += sol;
            const before = BigInt(ev.real_quote_reserves ?? '0') + sol;
            if (before > 0n) {
              const bps = (sol * 10000n) / before;
              if (bps > note.worstSellBps) note.worstSellBps = bps;
            }
          }
        }
      } else if (ev.event === 'CompleteEvent') {
        const note = coins.get(ev.mint);
        if (note) {
          note.finishedCurve = true;
          note.finished = true;
        }
      }
    }

    // Fold fills into the holding book.
    for (const fill of batch.fills ?? []) {
      if (fill.client_id.startsWith('_')) {
        held.delete(fill.mint);
        selling.delete(fill.mint);
        continue;
      }
      const rec = held.get(fill.mint);
      if (rec && fill.status !== 'rejected') {
        rec.feesPaid += BigInt(fill.tx_fee_lamports ?? '0');
      }
      if (fill.side === 'buy' && fill.status === 'filled' && !held.has(fill.mint)) {
        held.set(fill.mint, {
          openedSlot: fill.slot,
          feesPaid: BigInt(fill.tx_fee_lamports ?? '0'),
          peak: 0n,
          tookFirst: false,
        });
      }
    }

    // Drop stale in-flight and orphaned holding records.
    for (const mint of Array.from(selling)) {
      if (!hasPending(state, mint, 'sell')) selling.delete(mint);
    }
    for (const mint of Array.from(held.keys())) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
        held.delete(mint);
      }
    }

    // Exits first: walk open holdings in order and leave on any exit rule.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (selling.has(mint)) continue;
      const quote = reservesFor(mint);
      if (!quote) continue;
      let rec = held.get(mint);
      if (!rec) {
        rec = { openedSlot: nowSlot, feesPaid: 0n, peak: 0n, tookFirst: false };
        held.set(mint, rec);
      }
      const value = quoteOut(pos.token_amount, quote.vq, quote.vt) - fee;
      const basis = pos.cost_lamports + rec.feesPaid;
      if (value > rec.peak) rec.peak = value;
      const note = coins.get(mint);

      // First slice of the win, when the first target is reached.
      if (!rec.tookFirst && value >= (basis * (10000n + BigInt(p.tp1Bps))) / 10000n) {
        const part = (pos.token_amount * BigInt(p.tp1PartBps)) / 10000n;
        if (part > 0n && part < pos.token_amount) {
          orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
          selling.add(mint);
          rec.tookFirst = true;
          rec.peak = 0n;
          continue;
        }
      }

      const stopBps = rec.tookFirst ? p.slAfterTp1Bps : p.slBps;
      const flowNow = note ? windowFlow(note, nowSlot, p.flowWindow) : { net: 0n, buyers: 0 };
      const shouldLeave =
        value >= (basis * (10000n + BigInt(p.tpBps))) / 10000n ||
        value <= (basis * (10000n - BigInt(stopBps))) / 10000n ||
        (rec.peak >= (basis * (10000n + BigInt(p.trailArmBps))) / 10000n &&
          value <= (rec.peak * (10000n - BigInt(p.trailBps))) / 10000n) ||
        nowSlot - rec.openedSlot >= p.maxHold ||
        (p.exitOnDevSell && (note ? note.makerSold : false)) ||
        nowSlot - (note ? note.lastTradeSlot : nowSlot) >= p.staleSlots ||
        flowNow.net < -BigInt(p.exitFlowLamports);
      if (!shouldLeave) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      selling.add(mint);
      if (note) note.finished = true;
    }

    // Entries: walk launches in birth order and buy the ones passing the tape.
    let free = state.freeCashLamports();
    let openCount = state.committedPositionCount();
    for (const [mint, note] of coins) {
      if (orders.length >= maxOrders) break;
      if (note.finished || note.finishedCurve) continue;
      const age = nowSlot - note.birthSlot;
      const isAdd = note.buysSent > 0;
      if (!isAdd && age > p.maxAge) {
        note.finished = true;
        continue;
      }
      if (age < p.minAge) continue;

      if (isAdd) {
        if (note.buysSent > p.maxAdds) continue;
        if (!state.positions.has(mint) || selling.has(mint) || hasPending(state, mint, 'buy')) continue;
        if (nowSlot - note.lastBuySlot < p.addDelay) continue;
        const quote = reservesFor(mint);
        if (!quote) continue;
        if (!(quote.vq * note.lastVt * 10000n >= note.lastVq * quote.vt * (10000n + BigInt(p.addStepBps)))) continue;
        if (windowFlow(note, nowSlot, p.flowWindow).net < BigInt(p.addMinFlowLamports)) continue;
        const cap = state.maxBuyLamports(mint);
        const addAmt = BigInt(p.addLamports) < cap ? BigInt(p.addLamports) : cap;
        if (addAmt < BigInt(p.minBuyLamports)) continue;
        if (free < addAmt + fee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: addAmt, max_slippage_bps: p.buySlippageBps });
        note.spentSent += addAmt;
        note.buysSent += 1;
        note.lastVq = quote.vq;
        note.lastVt = quote.vt;
        note.lastBuySlot = nowSlot;
        free -= addAmt + fee;
        continue;
      }

      if (openCount >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      if (note.makerSold && p.skipDevSold) {
        note.finished = true;
        continue;
      }
      const quote = reservesFor(mint);
      if (!quote) continue;
      const real = curve.real_quote_reserves;
      if (real < BigInt(p.minRealSol) || real > BigInt(p.maxRealSol)) continue;
      if (note.makerBought < BigInt(p.minDevBuy) || note.makerBought > BigInt(p.maxDevBuy)) continue;
      if (note.tradeCount < p.minTrades) continue;
      if (note.buyers.size < p.minBuyers || note.buyers.size > p.maxBuyers) continue;
      if (note.boughtLamports > 0n && note.soldByOthers * 10000n > note.boughtLamports * BigInt(p.maxSellRatioBps)) continue;
      if (note.worstSellBps > BigInt(p.maxBigSellBps)) continue;
      if (quote.vq <= 0n || quote.vt <= 0n || note.startVq <= 0n || note.startVt <= 0n) continue;
      const runup = (quote.vq * note.startVt * 10000n) / (quote.vt * note.startVq);
      if (runup < BigInt(p.minRunupBps) || runup > BigInt(p.maxRunupBps)) continue;
      const flow = windowFlow(note, nowSlot, p.flowWindow);
      if (flow.net < BigInt(p.minFlowLamports)) continue;
      if (flow.buyers < p.minRecentBuyers) continue;
      const room = BigInt(p.stakeLamports) - note.spentSent;
      if (room < BigInt(p.minBuyLamports)) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = room < cap ? room : cap;
      if (amount < BigInt(p.minBuyLamports)) continue;
      if (free < amount + fee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      note.spentSent += amount;
      note.buysSent = 1;
      note.lastVq = quote.vq;
      note.lastVt = quote.vt;
      note.lastBuySlot = nowSlot;
      free -= amount + fee;
      openCount += 1;
    }

    return orders;
  }

  return { onBatch };
}
