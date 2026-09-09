import { previewPosition } from './position';
import {
  moneyString,
  moneyUnits,
  previewCompound,
  type CompoundDecision,
} from './compound';
export interface PracticePosition {
  id: string;
  createdAt: string;
  amount: number;
  lower: number;
  upper: number;
  enabled: boolean;
  reservesUsd: string;
  feesAddedUsd: string;
  netAddedUsd: string;
  servicePaidUsd: string;
}
export interface PracticeEvent {
  id: string;
  positionId: string;
  at: string;
  kind: 'created' | 'compound' | 'paused' | 'resumed';
  decision?: CompoundDecision;
  funding?: PracticeFunding;
}
export interface PracticeFunding {
  waitingFeesUsd: string;
  newFeesUsd: string;
}
export interface PracticeBook {
  version: 1;
  positions: PracticePosition[];
  events: PracticeEvent[];
}
export const emptyBook = (): PracticeBook => ({
  version: 1,
  positions: [],
  events: [],
});
export function parseBook(value: unknown): PracticeBook {
  const b = value as PracticeBook;
  if (
    !b ||
    b.version !== 1 ||
    !Array.isArray(b.positions) ||
    b.positions.length > 20 ||
    !Array.isArray(b.events) ||
    b.events.length > 300
  )
    throw Error('Invalid practice workspace.');
  const ids = new Set<string>();
  for (const p of b.positions) {
    if (
      typeof p.id !== 'string' ||
      !/^practice-[a-f0-9-]{36}$/.test(p.id) ||
      ids.has(p.id) ||
      typeof p.enabled !== 'boolean' ||
      !Number.isFinite(Date.parse(p.createdAt))
    )
      throw Error('Invalid practice position.');
    ids.add(p.id);
    previewPosition({
      amount: p.amount,
      lower: p.lower,
      upper: p.upper,
      startingPrice: 1,
      scenarioPrice: 1,
    });
    for (const field of [
      'reservesUsd',
      'feesAddedUsd',
      'netAddedUsd',
      'servicePaidUsd',
    ] as const)
      moneyUnits(p[field]);
  }
  for (const e of b.events) {
    if (
      !ids.has(e.positionId) ||
      typeof e.id !== 'string' ||
      e.id.length > 80 ||
      !Number.isFinite(Date.parse(e.at)) ||
      !['created', 'compound', 'paused', 'resumed'].includes(e.kind)
    )
      throw Error('Invalid practice history.');
    if (e.funding) {
      if (
        e.kind !== 'compound' ||
        !e.decision ||
        moneyUnits(e.funding.waitingFeesUsd) +
          moneyUnits(e.funding.newFeesUsd) !==
          moneyUnits(e.decision.availableFeesUsd)
      )
        throw Error('Invalid fee funding breakdown.');
    }
    if (e.decision) {
      const d = e.decision;
      if (d.mode !== 'simulation') throw Error('Invalid event mode.');
      for (const k of [
        'availableFeesUsd',
        'consumedFeesUsd',
        'serviceFeeUsd',
        'reinvestedUsd',
        'reserveUsd',
        'gasUsd',
        'operatorMarginUsd',
        'minimumFeesUsd',
      ] as const)
        moneyUnits(d[k]);
      if (d.policyVersion === 2) {
        if (
          d.reserveReason !==
            (d.decision === 'wait' && moneyUnits(d.reserveUsd) > 0n
              ? 'network_cost'
              : 'none') ||
          'maxNetAdditionUsd' in d
        )
          throw Error('Invalid reinvestment policy.');
      } else if (d.policyVersion === undefined || d.policyVersion === 1) {
        moneyUnits(d.maxNetAdditionUsd);
      } else {
        throw Error('Unknown reinvestment policy.');
      }
      if (
        !['eligible', 'wait'].includes(d.decision) ||
        !['ready', 'no_fees', 'gas_too_high'].includes(d.reason)
      )
        throw Error('Invalid decision.');
    }
  }
  return b;
}
/** Older receipts can be explained only when their preceding balance is known. */
export function practiceFunding(
  book: PracticeBook,
  event: PracticeEvent,
): PracticeFunding | undefined {
  if (event.funding) return event.funding;
  if (event.kind !== 'compound' || !event.decision) return;
  const index = book.events.indexOf(event);
  if (index < 0) return;
  for (const previous of book.events.slice(index + 1)) {
    if (previous.positionId !== event.positionId) continue;
    if (previous.kind !== 'created' && previous.kind !== 'compound') continue;
    if (previous.kind === 'compound' && !previous.decision) return;
    const waiting = previous.decision
      ? moneyUnits(previous.decision.reserveUsd)
      : 0n;
    const available = moneyUnits(event.decision.availableFeesUsd);
    if (waiting > available) return;
    return {
      waitingFeesUsd: moneyString(waiting),
      newFeesUsd: moneyString(available - waiting),
    };
  }
}
export function addPracticePosition(
  book: PracticeBook,
  position: PracticePosition,
  eventId: string,
): PracticeBook {
  if (book.positions.length >= 20)
    throw Error('This practice workspace supports up to 20 positions.');
  const next = {
    ...book,
    positions: [...book.positions, position],
    events: [
      {
        id: eventId,
        positionId: position.id,
        at: position.createdAt,
        kind: 'created' as const,
      },
      ...book.events,
    ].slice(0, 300),
  };
  return parseBook(next);
}
export function runPracticeCompound(
  book: PracticeBook,
  id: string,
  newFees: string,
  gas: string,
  eventId: string,
  at: string,
): PracticeBook {
  const position = book.positions.find((p) => p.id === id);
  if (!position) throw Error('Position not found.');
  if (!position.enabled)
    throw Error('Resume practice automation before adding a fee scenario.');
  const newAmount = moneyUnits(newFees),
    available = moneyUnits(position.reservesUsd) + newAmount;
  const decision = previewCompound({
    availableFeesUsd: moneyString(available),
    positionValueUsd: moneyString(
      BigInt(Math.round(position.amount * 1e6)) +
        moneyUnits(position.netAddedUsd),
    ),
    gasUsd: gas,
  });
  const updated = {
    ...position,
    reservesUsd: decision.reserveUsd,
    feesAddedUsd: moneyString(moneyUnits(position.feesAddedUsd) + newAmount),
    netAddedUsd: moneyString(
      moneyUnits(position.netAddedUsd) + moneyUnits(decision.reinvestedUsd),
    ),
    servicePaidUsd: moneyString(
      moneyUnits(position.servicePaidUsd) + moneyUnits(decision.serviceFeeUsd),
    ),
  };
  return {
    ...book,
    positions: book.positions.map((p) => (p.id === id ? updated : p)),
    events: [
      {
        id: eventId,
        positionId: id,
        at,
        kind: 'compound' as const,
        decision,
        funding: {
          waitingFeesUsd: position.reservesUsd,
          newFeesUsd: moneyString(newAmount),
        },
      },
      ...book.events,
    ].slice(0, 300),
  };
}
