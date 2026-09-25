/**
 * The positions screens' entry anchor (DESIGN-V2 §17.3, §18): Positions.tsx,
 * an entry module, imports this kit statically and hands it to its lazy
 * chunks (OwnedPositions, PositionDetail), so every module named here lands
 * in the entry, and the lazy chunks import the same components (and the fees
 * hooks) directly, from the entry, for free. Components only: no hook is read
 * from the kit, and nothing here is a wallet feature module.
 */
import { Amount, PairName, PositionStatus } from '../PositionFigures'
import { PositionRange } from '../PositionRange'
import { AutomationFrame } from './AutomationFrame'
import { FeesCard } from './FeesCard'
import { PortfolioSummary, RowUsd } from './PortfolioSummary'
import { PrincipalUsd, UnclaimedUsd } from './PositionValue'
import { PriceVsRange } from './PriceVsRange'
import { QuietMarkPair } from './QuietMarks'

export const POSITION_KIT = {
  FeesCard,
  PortfolioSummary,
  PriceVsRange,
  AutomationFrame,
  PositionRange,
  PositionFigures: { Amount, PairName, PositionStatus },
  RowUsd,
  PrincipalUsd,
  UnclaimedUsd,
  QuietMarkPair,
} as const
