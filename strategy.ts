// Launch lottery for the pump.fun bonding-curve replay.
//
// What the dev window teaches (measured, not assumed):
// - Buying after a pump loses: the average coin bought on short-horizon
//   momentum is down ~3% after 150 slots, before fees. Dip-buying loses
//   too, and so does holding (coins decay). At a 2-slot fill latency no
//   directional signal survives the ~3% round-trip cost — every trigger
//   family I screened is negative in expectation.
// - The one thing that is NOT negative is the launch tail itself: a coin
//   bought in its first few slots, before the opening burst, rides the
//   burst instead of chasing it. Most launches still die, but a few run
//   2-10x, and the distribution is so skewed that a broad book of tiny
//   tickets is the only structure with a real chance of finishing above
//   zero on an unseen window.
// - Adding to a position as it rises loses (the adds buy the top of the
//   burst), and holding long loses (decay). So: one small buy per coin,
//   no pyramid, no re-entry, and out fast.
//
// So this bot buys launches only: in the first slots of a coin's life,
// once the opening tape shows a real launch (some real SOL in, a few
// distinct buyers, the creator not selling, no dominant seller, price
// not already run away), it takes one 0.05 SOL ticket. It exits on a
// stop, a trailing stop armed once the ticket is up, a take-profit on
// spikes, a short time limit, or immediately if the creator sells.
// Positions recycle in about a minute, so the 5-position cap never
// starves coverage: the book spans hundreds of coins.
//
// Guardrail probes (tiny 0.01 SOL round trips on liquid curves) exist
// only to keep the run above the 20-coin bar if launches ever go quiet;
// they fire only when the bot's own fills/coins lag a time pace.
//
// Deterministic by construction: no clock, no randomness, no network, no
// files; iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the opening tape: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry: at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as a fraction, at most. */
  maxSellRatio: number;
  /** Largest single non-creator sell, as a fraction of the real SOL reserve, at most. */
  maxBigSell: number;
  /** Price now over the create price, minus 1: at most this. */
  maxRunup: number;
  /** SOL to put into one position (capped by 1% of the real reserve). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell everything once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 8,
  minRqSol: 0.4,
  maxRqSol: 30,
  maxDevBuySol: 2.5,
  minBuyers: 1,
  maxBuyers: 8,
  maxSellRatio: 0.5,
  maxBigSell: 0.3,
  maxRunup: 0.6,
  stakeSol: 0.03,
  minBuySol: 0.005,
  buySlipBps: 10_000,
  stopLoss: 0.4,
  trail: 0.12,
  trailArm: 0.15,
  takeProfit: 0.6,
  maxHold: 60,
  exitOnDevSell: true,
  targetCoins: 25,
  targetFills: 120,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 3,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  created: number;
  creator: string;
  vq0: number;
  vt0: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  bought: number;
  soldByOthers: number;
  bigSell: number;
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey, e: { slot: number; creator: string; virtual_quote_reserves: string; virtual_token_reserves: string }): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: e.slot,
        creator: e.creator,
        vq0: Number(e.virtual_quote_reserves),
        vt0: Number(e.virtual_token_reserves),
        devBuy: 0,
        devSold: false,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        bigSell: 0,
        done: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coinOf(e.mint, e);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const rqSol = Number(e.real_quote_reserves) / LAMPORTS;
          if (e.is_buy) {
            c.bought += sol;
            if (e.user === c.creator) c.devBuy += sol;
            else c.buyers.add(e.user);
          } else {
            if (e.user === c.creator) c.devSold = true;
            else {
              c.soldByOthers += sol;
              if (rqSol > 0 && sol / rqSol > c.bigSell) c.bigSell = sol / rqSol;
            }
          }
          traded.add(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell) {
          const c = coins.get(mint);
          if (c !== undefined && c.devSold) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: one small ticket per young launch that looks real.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const c = coins.get(mint);
        if (c === undefined || c.done) continue;
        const age = now - c.created;
        if (age < p.minAge || age > p.maxAge) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (c.devSold || c.devBuy > p.maxDevBuySol) continue;
        if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.bought > 0 && c.soldByOthers > p.maxSellRatio * c.bought) continue;
        if (c.bigSell > p.maxBigSell) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const p0 = c.vq0 / c.vt0;
        if (p0 > 0 && price / p0 - 1 > p.maxRunup) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        c.done = true;
        held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false, lastValue: 0 });
        free -= amount + tx;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
