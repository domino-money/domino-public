/**
 * The service fee each mode takes of the earned fees it consumes, in basis
 * points, for the Automate fee meter. Automate may not import finance/*, so
 * this mirrors CREATE.review.serviceFeeValue (2% / 4%); a unit test pins the
 * two together (DESIGN-V2 §14.1, R-18).
 */
export const FEE_BPS = { compound: 200, domino: 400 } as const
