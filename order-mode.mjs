import { toPlainDecimal } from './decimal.mjs';

export const isContract = market => market === 'swap' || market === 'futures';

export function entryPosSide({ posMode, market, side, requested }) {
  if (!isContract(market)) return undefined;
  if (posMode === 'long_short_mode') {
    const expected = side === 'buy' ? 'long' : side === 'sell' ? 'short' : null;
    if (!expected || (requested && requested !== 'net' && requested !== expected)) throw Error('entry posSide conflicts with order side');
    return expected;
  }
  if (posMode === 'net_mode') {
    if (requested && requested !== 'net') throw Error('long/short posSide is invalid in net_mode');
    return undefined;
  }
  throw Error('Unknown account posMode; contract order blocked');
}

export function selectPosition({ posMode, instId, mgnMode, requested, positions }) {
  const matching = (positions || []).filter(p => p.instId === instId && p.mgnMode === mgnMode && Math.abs(Number(p.pos)) > 0);
  if (posMode === 'long_short_mode') {
    if (requested && !['net', 'long', 'short'].includes(requested)) throw Error('invalid posSide');
    const candidates = matching.filter(p => ['long', 'short'].includes(p.posSide) && (!requested || requested === 'net' || p.posSide === requested));
    if (candidates.length !== 1) throw Error(candidates.length ? 'Multiple positions: specify posSide long or short' : 'Matching position not found');
    return { position: candidates[0], posSide: candidates[0].posSide };
  }
  if (posMode === 'net_mode') {
    if (requested && requested !== 'net') throw Error('long/short posSide is invalid in net_mode');
    const candidates = matching.filter(p => !p.posSide || p.posSide === 'net');
    if (candidates.length !== 1) throw Error('Matching net position not found');
    return { position: candidates[0], posSide: undefined };
  }
  throw Error('Unknown account posMode; position action blocked');
}

export function instrumentExposure({ instId, positions, pendingOrders, pendingAlgoOrders }) {
  const lists=[...Object.values(pendingOrders || {}), ...Object.values(pendingAlgoOrders || {})];
  if (!Array.isArray(positions) || !lists.length || !lists.every(Array.isArray)) throw Error('Cannot verify positions and pending orders');
  const position = positions.some(p => p.instId === instId && Math.abs(Number(p.pos)) > 0);
  const pending = lists.flat().some(o => o?.instId === instId);
  return { position, pending };
}

export function leveragePlan({ requested, current, maxPolicy, maxExchange, mgnMode, exposure }) {
  if (!Number.isFinite(requested) || requested < 1) throw Error('invalid requested leverage');
  if (!Number.isFinite(maxPolicy) || requested > maxPolicy) throw Error('leverage exceeds policy maxLeverage');
  if (!Number.isFinite(maxExchange) || maxExchange < 1 || requested > maxExchange) throw Error('leverage exceeds or cannot verify exchange maximum');
  if (!Number.isFinite(current) || current < 1) throw Error('Cannot verify current leverage');
  if (current === requested) return { needsSet: false, leverageForRisk: current };
  if (mgnMode !== 'isolated') throw Error('Automatic leverage change requires isolated mode');
  if (exposure.position || exposure.pending) throw Error('Cannot change leverage while this instrument has a position or pending order');
  return { needsSet: true, leverageForRisk: requested };
}

export function leverageArgs({ market, instId, leverage, posSide }) {
  if (!isContract(market)) throw Error('Leverage can only be set for contracts');
  return [market, 'leverage', '--instId', instId, '--lever', toPlainDecimal(leverage), '--mgnMode', 'isolated', ...(posSide ? ['--posSide', posSide] : [])];
}
