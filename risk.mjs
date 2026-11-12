// Pure risk/preflight logic for SG-OKX-Bridge. No I/O, no network. Unit-tested in risk.test.mjs.
export const LIMIT_FIELDS = ['maxCapitalUsdt','maxOrderUsdt','maxRiskPerTradeUsdt','maxLeverage','maxDailyLossUsdt','maxDailyTrades','maxOpenPositions'];
export const FEE_RATE_ESTIMATE = 0.001; // conservative taker estimate per side, used only to pad max-loss

export function shanghaiDay(d = new Date()) { return new Date(d.getTime() + 8*3600e3).toISOString().slice(0,10); }

/** Returns list of reasons why the policy cannot authorize live trading. Missing/zero is never unlimited. */
export function validateLivePolicy(p) {
  const r = [];
  if (!p || typeof p !== 'object') return ['policy missing'];
  if (p.liveEnabled !== true) r.push('liveEnabled is not true');
  if (p.stopped !== false) r.push('STOP is engaged (stopped must be false)');
  for (const f of LIMIT_FIELDS) { const v = p[f]; if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) r.push(`${f} missing or not > 0`); }
  for (const f of ['maxDailyTrades','maxOpenPositions']) if (Number.isFinite(p[f]) && !Number.isInteger(p[f])) r.push(`${f} must be an integer`);
  if (Number.isFinite(p.maxOrderUsdt) && Number.isFinite(p.maxCapitalUsdt) && p.maxOrderUsdt > p.maxCapitalUsdt) r.push('maxOrderUsdt exceeds maxCapitalUsdt');
  if (!Array.isArray(p.allowedMarkets) || p.allowedMarkets.length === 0) r.push('allowedMarkets empty');
  else if (!p.allowedMarkets.every(x => x === 'ALL' || (typeof x === 'string' && /^[A-Z0-9]+(?:-[A-Z0-9]+){1,6}$/.test(x)))) r.push('allowedMarkets contains invalid instrument');
  return r;
}

export const marketOf = (instId) => instId.endsWith('-SWAP') ? 'swap' : /-\d{6}$/.test(instId) ? 'futures' : 'spot';
export const posKey = (instId, posSide) => `${instId}:${posSide || 'net'}`;

/** Notional in quote (USDT) for an order of `size` at `px`. Returns null if it cannot be derived safely. */
export function notionalUsdt({ instId, size, px, instrument }) {
  if (!instId.endsWith('-USDT') && !instId.endsWith('-USDT-SWAP') && !/-USDT-\d{6}$/.test(instId)) return null;
  if (marketOf(instId) === 'spot') return size * px;
  if (instrument?.ctValCcy !== instId.split('-')[0]) return null;
  return size * Number(instrument.ctVal) * px;
}

/** Size/price vs OKX increments. Never adjusts; returns reasons. */
export function checkIncrements({ size, price, instrument }) {
  const r = [];
  const minSz = Number(instrument.minSz), lotSz = Number(instrument.lotSz), tickSz = Number(instrument.tickSz);
  if (!(size >= minSz)) r.push(`size ${size} below OKX minSz ${minSz}; will not raise size, reduce nothing, rejecting`);
  if (Math.abs(size/lotSz - Math.round(size/lotSz)) > 1e-7) r.push(`size ${size} not a multiple of lotSz ${lotSz}`);
  if (price != null && Math.abs(price/tickSz - Math.round(price/tickSz)) > 1e-7) r.push(`price ${price} not a multiple of tickSz ${tickSz}`);
  return r;
}

/** Count of real non-zero positions on the account (all, including ones not opened by the bridge). */
export const openPositionCount = (positions) => (positions||[]).filter(p => Math.abs(Number(p.pos)) > 0).length;

/** Sum of capital (margin for swap, notional for spot) currently committed by bridge-opened open entries. */
export function bridgeCommitted(journal) {
  return Object.values(journal?.owned || {}).reduce((a, o) => a + (Number(o.capitalUsdt) || 0), 0);
}

export function dailyTrades(journal, day) { return (journal?.daily?.[day]?.trades) || 0; }

/**
 * Live entry preflight. Inputs are already-fetched real data. Returns { ok, reasons, computed }.
 * order: {instId, side, posSide, ordType, size, price, entryReference, stopLoss, takeProfit, leverage, reduceOnly}
 */
export function preflightEntry({ policy, order, instrument, availUsdt, positions, journal, day, dayStartEq, currentEq, currentLeverage }) {
  const reasons = [...validateLivePolicy(policy)];
  const o = order, market = marketOf(o.instId);
  if (Array.isArray(policy?.allowedMarkets) && !policy.allowedMarkets.includes('ALL') && !policy.allowedMarkets.includes(o.instId)) reasons.push(`${o.instId} not in allowedMarkets`);
  if (!instrument || instrument.state !== 'live') reasons.push('instrument not live on OKX');
  const lev = market === 'spot' ? 1 : o.leverage;
  if (market === 'spot' && o.leverage !== 1) reasons.push('spot orders must use leverage 1 (cash)');
  if (!(lev >= 1)) reasons.push('leverage must be >= 1');
  if (Number.isFinite(policy?.maxLeverage) && lev > policy.maxLeverage) reasons.push(`leverage ${lev} exceeds maxLeverage ${policy.maxLeverage}`);
  if (market !== 'spot' && currentLeverage != null && Number(currentLeverage) !== lev) reasons.push(`account leverage for ${o.instId} is ${currentLeverage}, order says ${lev}; bridge will not change leverage while positions exist`);
  const isShort = market !== 'spot' ? (o.posSide === 'short' || (o.posSide !== 'long' && o.side === 'sell')) : false;
  if (market === 'spot' && o.side !== 'buy') reasons.push('spot entry must be a buy (sells go through close_position)');
  if (market !== 'spot' && o.posSide === 'long' && o.side !== 'buy') reasons.push('opening long requires side=buy');
  if (market !== 'spot' && o.posSide === 'short' && o.side !== 'sell') reasons.push('opening short requires side=sell');
  const needSL = market !== 'spot' || lev > 1;
  if (needSL && !(o.stopLoss > 0)) reasons.push('stop-loss required for leveraged orders');
  if (o.stopLoss > 0) { if (isShort ? !(o.stopLoss > o.entryReference) : !(o.stopLoss < o.entryReference)) reasons.push('stop-loss on wrong side of entry'); }
  if (o.takeProfit > 0) { if (isShort ? !(o.takeProfit < o.entryReference) : !(o.takeProfit > o.entryReference)) reasons.push('take-profit on wrong side of entry'); }
  if (o.ordType === 'limit' && !(o.price > 0)) reasons.push('limit price required');
  if (instrument) reasons.push(...checkIncrements({ size: o.size, price: o.ordType==='limit'?o.price:null, instrument }));
  const px = o.ordType === 'limit' ? o.price : o.entryReference;
  const notional = instrument ? notionalUsdt({ instId: o.instId, size: o.size, px, instrument }) : null;
  if (notional == null) reasons.push('cannot derive USDT notional for this instrument');
  const capital = notional == null ? null : (market !== 'spot' ? notional / lev : notional);
  const fees = notional == null ? null : notional * FEE_RATE_ESTIMATE * 2;
  const priceRisk = (notional == null || !(o.stopLoss > 0)) ? null : notional * Math.abs(px - o.stopLoss) / px;
  // spot without SL: worst case is the full notional
  const maxLoss = notional == null ? null : (priceRisk == null ? notional : priceRisk) + fees;
  if (notional != null && Number.isFinite(policy?.maxOrderUsdt) && notional > policy.maxOrderUsdt) reasons.push(`notional ${notional.toFixed(4)} exceeds maxOrderUsdt ${policy.maxOrderUsdt}`);
  if (capital != null && Number.isFinite(policy?.maxCapitalUsdt) && bridgeCommitted(journal) + capital > policy.maxCapitalUsdt) reasons.push(`committed ${bridgeCommitted(journal).toFixed(4)} + ${capital.toFixed(4)} exceeds maxCapitalUsdt ${policy.maxCapitalUsdt}`);
  if (capital != null && !(Number(availUsdt) >= capital * 1.01)) reasons.push(`available USDT ${availUsdt} insufficient for ${capital.toFixed(4)} (+1% buffer)`);
  if (maxLoss != null && Number.isFinite(policy?.maxRiskPerTradeUsdt) && maxLoss > policy.maxRiskPerTradeUsdt) reasons.push(`max loss ${maxLoss.toFixed(4)} exceeds maxRiskPerTradeUsdt ${policy.maxRiskPerTradeUsdt}`);
  if (Number.isFinite(policy?.maxDailyTrades) && dailyTrades(journal, day) >= policy.maxDailyTrades) reasons.push(`daily trade count ${dailyTrades(journal, day)} reached maxDailyTrades ${policy.maxDailyTrades}`);
  if (!Number.isFinite(dayStartEq) || !Number.isFinite(currentEq)) reasons.push('daily equity baseline unavailable');
  else if (Number.isFinite(policy?.maxDailyLossUsdt)) {
    const lost = Math.max(0, dayStartEq - currentEq);
    if (lost >= policy.maxDailyLossUsdt) reasons.push(`daily loss ${lost.toFixed(4)} reached maxDailyLossUsdt ${policy.maxDailyLossUsdt}`);
    else if (maxLoss != null && lost + maxLoss > policy.maxDailyLossUsdt) reasons.push(`daily loss ${lost.toFixed(4)} + trade max loss ${maxLoss.toFixed(4)} would exceed maxDailyLossUsdt ${policy.maxDailyLossUsdt}`);
  }
  if (market !== 'spot') {
    const exists = (positions||[]).some(p => p.instId === o.instId && Math.abs(Number(p.pos))>0 && (p.posSide||'net') === (o.posSide||'net'));
    if (exists) reasons.push(`a position already exists on ${posKey(o.instId,o.posSide)}; bridge will not add to it`);
  }
  if (Number.isFinite(policy?.maxOpenPositions) && openPositionCount(positions) >= policy.maxOpenPositions) reasons.push(`open positions ${openPositionCount(positions)} reached maxOpenPositions ${policy.maxOpenPositions}`);
  return { ok: reasons.length === 0, reasons, computed: { notional, capital, fees, maxLoss, leverage: lev } };
}

/** Ownership guard for modifying/closing. Protects positions/orders the bridge did not open. */
export function ownershipCheck({ journal, key, allowExistingPosition }) {
  if (journal?.owned?.[key]) return { ok: true, owned: true };
  if (allowExistingPosition === true) return { ok: true, owned: false };
  return { ok: false, owned: false, reason: `${key} was not opened by the bridge; pass allowExistingPosition=true only with explicit local approval` };
}

export function isJournaledOrder(journal, clOrdId) { return !!journal?.orders?.[clOrdId]; }
