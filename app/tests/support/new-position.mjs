/**
 * Walking New position in a browser, for the scenarios that reach Review on
 * the read fixture pool (support/read-stub.mjs): the wallet-test build's
 * Create position (finance.browser) and the consumer-test build's Review
 * (consumer.browser). Only what a person does: type the token's address, pick
 * the pool, press Continue, type an amount.
 */
import { FIXTURE_TOKEN } from './read-stub.mjs';

/** Token artwork's decoration source (src/lib/tokenArtwork.ts): the token marks on these screens ask it, and the tests answer with nothing. */
export const ARTWORK = /^https:\/\/(api|cdn)\.dexscreener\.com\//;

export const footerButton = (page, name) => page.locator('[data-journey-footer]').getByRole('button', { name, exact: true });

/**
 * Presses `control` once the steps stop moving. A step that opens slides in for 250 ms (styles/tokens.css --dur-step),
 * and 260 ms after it opened StepList scrolls its title into view, unless focus has left the title
 * (components/create/StepList.tsx). A press made as the slide ends can meet that scroll and the control moving from
 * under the pointer: the press is lost, the next step never opens, and the walk waited 30 s for a field that never came
 * (CI, audit H3). So the press waits for the steps' own motion to end, then puts focus on the control, where a press
 * puts it anyway: a scroll not started yet stands down, and the click waits out one already under way.
 */
export async function press(control) {
  const still = control.page().evaluate(async () => {
    const steps = document.querySelector('.dm-flow-steps');
    const moving = (steps?.getAnimations({ subtree: true }) ?? []).filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(moving.map((animation) => animation.finished.catch(() => {})));
  });
  // Bounded here, in real time: a scenario's installed clock owns the page's own timers.
  await Promise.race([still, new Promise((done) => setTimeout(done, 2_000))]);
  await control.focus();
  await control.click();
}

/** Continue, in `within` (a page, or one step), pressed as above. */
export const pressContinue = (within) => press(footerButton(within, 'Continue'));

/** To the pool step's choice: type TOKEN's address, pick it, pick the first pool the read lists for it. */
export async function choosePool(page) {
  await page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
  await page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
  // Choosing a pool replaces the list with the chosen pool, so the radio is clicked, not checked and read back.
  await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
  await page.locator('[data-chosen-pool]').waitFor();
}

/**
 * To Review: deposit TOKEN into ETH / TOKEN, the standard range the pool's price gives, `amount` TOKEN (1 unless
 * said). Nothing about automation is asked on the way. `range` (added 2026-09-28, one-sided): a Custom range typed
 * as the page writes prices, [lowest, highest], the highest first so the two never cross on the way.
 */
export async function walkToReview(page, { amount = '1', range = null } = {}) {
  await choosePool(page);
  const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
  await pressContinue(current('pool'));
  await current('range').waitFor();
  if (range) {
    const step = current('range').locator('[data-picker="range"]');
    await press(step.getByRole('radio', { name: 'Custom' }));
    for (const [which, price] of [['upper', range[1]], ['lower', range[0]]]) {
      const field = step.locator(`#range-${which}-price`);
      await field.fill(price);
      await field.press('Enter');
    }
  }
  await pressContinue(current('range'));
  await current('amount').waitFor();
  // The amount step has a row per pool token; typing in one makes it the independent token. The amount must still be
  // there once typed: a redraw of the step that dropped it would only show at Review, as other figures.
  const field = 'li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]';
  await page.locator(field).fill(amount);
  await page.waitForFunction(([selector, typed]) => document.querySelector(selector)?.value === typed, [field, amount], { timeout: 5_000 });
  // Amount continues straight to Review: the balance stage has no step of its own, and there is no automation step.
  await pressContinue(current('amount'));
  await page.locator('[data-stage-card="review"]').waitFor();
}
