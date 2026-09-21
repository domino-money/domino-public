/**
 * The slippage tolerance a person chooses for a new position, and the one
 * bound on it, shared by everything that offers or checks it: the amount
 * step's slider (components/create/SlippageSlider.tsx), Setup's draft and its
 * balancing swap (components/create/SlippageChoice.tsx), the journey's
 * validation (journey.ts) and the preview forms (onboarding/inputs.ts,
 * onboarding/swap.ts). What is kept and sent is whole basis points
 * (JourneyState.slippageBps, DepositSelection.slippageBps); the percentage is
 * only how it is chosen and written, and this module maps between the two.
 *
 * The bound is the product's own, 0.1% to 5%, and the backend's request
 * models check the same numbers (backend/onboarding_models.py, `Slippage`),
 * as tests/create-journey.test.mjs holds them to. The provider adapters
 * admit 0 to 9999 behind them; that is not a limit a person is offered.
 */
/** The ends of the choice, in basis points: 0.1% to 5%, both included. */
export const SLIPPAGE_MIN_BPS = 10;
export const SLIPPAGE_MAX_BPS = 500;
/** The presets, in basis points: 0.1%, 0.5% and 1%. Buttons on every control, and the marks on the track. */
export const SLIPPAGE_PRESETS = [10, 50, 100];
/** The marks on the track are the presets. */
export const SLIPPAGE_MARKS = SLIPPAGE_PRESETS;
/** What a new position starts with: 0.5%. */
export const SLIPPAGE_DEFAULT_BPS = 50;
/** Above this the screen says what the tolerance allows: more than 1% is unusual for a mint. */
export const SLIPPAGE_WARN_ABOVE_BPS = 100;
/** How near a mark the thumb may be let go and still take it, in basis points. */
const SNAP_BPS = 4;
function buildSteps() {
    const steps = [];
    for (let bps = SLIPPAGE_MIN_BPS; bps < 100; bps += 1)
        steps.push(bps);
    for (let bps = 100; bps <= SLIPPAGE_MAX_BPS; bps += 5)
        steps.push(bps);
    return steps;
}
/**
 * Every value the thumb can take, in basis points: hundredths of a percent up
 * to 1%, twentieths from there to 5%. The positions are evenly spaced, so the
 * tolerances people choose between take half the track instead of a tenth of
 * it, and each arrow key press still moves to a different value.
 */
export const SLIPPAGE_STEPS = buildSteps();
/**
 * A whole number of basis points as its percentage, without the sign: 50 is
 * "0.5", 500 is "5". Basis points are hundredths of a percent, so this is the
 * decimal point moved two places, never a division a float could round.
 */
export function slippagePercent(bps) {
    const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
    return fraction === '' ? String(Math.trunc(bps / 100)) : `${Math.trunc(bps / 100)}.${fraction}`;
}
/** The same percentage as it is written on screen: 50 is "0.5%". */
export const slippageWritten = (bps) => `${slippagePercent(bps)}%`;
const BPS_TEXT = /^[1-9]\d{0,3}$/;
/**
 * The kept text as whole basis points inside the bound, or null: no sign, no
 * leading zero, no fraction, nothing below 0.1% or above 5%. The one rule
 * every form applies before a slippage goes anywhere (journey.ts's
 * validateSlippage puts the words to it).
 */
export function slippageBpsFrom(text) {
    if (!BPS_TEXT.test(text))
        return null;
    const bps = Number(text);
    return bps >= SLIPPAGE_MIN_BPS && bps <= SLIPPAGE_MAX_BPS ? bps : null;
}
/** Whether a tolerance is past the line the screen warns at: above 1%. */
export const slippageWarns = (bps) => bps > SLIPPAGE_WARN_ABOVE_BPS;
/** The kept value in basis points. Anything outside the ends takes the nearer end, since the track cannot draw it. */
export function slippageValue(text) {
    const bps = Number(text);
    if (!Number.isFinite(bps))
        return SLIPPAGE_MIN_BPS;
    return Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, Math.round(bps)));
}
/** The position on the track a value sits at: the nearest step to it. */
export function slippageIndex(bps) {
    let best = 0;
    for (let index = 1; index < SLIPPAGE_STEPS.length; index += 1) {
        if (Math.abs(SLIPPAGE_STEPS[index] - bps) < Math.abs(SLIPPAGE_STEPS[best] - bps))
            best = index;
    }
    return best;
}
/** The mark a thumb let go here takes, or null when it is not beside one. */
export function slippageMark(bps) {
    const mark = SLIPPAGE_MARKS.find((value) => Math.abs(bps - value) <= SNAP_BPS);
    return mark === undefined || mark === bps ? null : mark;
}
const PERCENT_TEXT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
/** A typed percentage as whole basis points inside the ends, or null when it is neither. */
export function slippageFromPercent(text) {
    const match = PERCENT_TEXT.exec(text);
    if (!match)
        return null;
    const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    return bps >= SLIPPAGE_MIN_BPS && bps <= SLIPPAGE_MAX_BPS ? bps : null;
}
