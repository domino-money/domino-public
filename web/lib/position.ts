export type RangeChoice = 'standard' | 'wide' | 'custom';
export interface PositionInput {
  amount: number;
  lower: number;
  upper: number;
  startingPrice: number;
  scenarioPrice: number;
}
export interface PositionPreview {
  initialToken: number;
  initialStable: number;
  token: number;
  stable: number;
  value: number;
  holdValue: number;
  difference: number;
  tokenShare: number;
  status: 'below' | 'inside' | 'above';
}
export function previewPosition(input: PositionInput): PositionPreview {
  const { amount, lower, upper, startingPrice, scenarioPrice } = input;
  if (
    ![amount, lower, upper, startingPrice, scenarioPrice].every(
      Number.isFinite,
    ) ||
    amount < 10 ||
    amount > 1_000_000 ||
    lower <= 0 ||
    lower >= startingPrice ||
    upper <= startingPrice ||
    upper / lower > 1_000_000 ||
    scenarioPrice <= 0 ||
    scenarioPrice > 1_000_000
  )
    throw new Error(
      'Use a valid amount and a range containing the starting price.',
    );
  const a = Math.sqrt(lower),
    b = Math.sqrt(upper),
    s = Math.sqrt(startingPrice);
  const unitToken = 1 / s - 1 / b,
    unitStable = s - a,
    liquidity = amount / (unitToken * startingPrice + unitStable);
  const p = Math.sqrt(Math.max(lower, Math.min(upper, scenarioPrice)));
  const token = liquidity * (1 / p - 1 / b),
    stable = liquidity * (p - a),
    initialToken = liquidity * unitToken,
    initialStable = liquidity * unitStable;
  const value = token * scenarioPrice + stable,
    holdValue = initialToken * scenarioPrice + initialStable;
  return {
    initialToken,
    initialStable,
    token,
    stable,
    value,
    holdValue,
    difference: value - holdValue,
    tokenShare: (token * scenarioPrice) / value,
    status:
      scenarioPrice >= upper
        ? 'above'
        : scenarioPrice < lower
          ? 'below'
          : 'inside',
  };
}
export const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n);
export const qty = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
