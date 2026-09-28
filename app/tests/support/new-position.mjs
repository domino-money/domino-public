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
 * said). Nothing about automation is asked on the way.
 */
export async function walkToReview(page, { amount = '1' } = {}) {
  await choosePool(page);
  await footerButton(page, 'Continue').click();
  await page.locator('[data-stage="range"]').waitFor();
  await footerButton(page, 'Continue').click();
  // The amount step has a row per pool token; typing in one makes it the independent token.
  await page.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill(amount);
  // Amount continues straight to Review: the balance stage has no step of its own, and there is no automation step.
  await footerButton(page, 'Continue').click();
  await page.locator('[data-stage-card="review"]').waitFor();
}
