// points-v1 1.0.0-rc.1: season 1's points for the app (docs/points/POINTS.md, part 3). Two POST routes for the SIWE
// session's wallet, which no request names: `points` (the wallet's entry in the season's latest snapshot) and `link`
// (records the wallet's referral link, signed by that wallet with personal_sign over referralText; the first link of
// a season holds). The listener is backend/points_api.py; this runtime is what the bridge Worker and the app check
// every exchange against.
import { SCHEMAS, ERRORS, CONSTANTS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '1.0.0-rc.1';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });
export const SEASON_TITLES = Object.freeze({ ...CONSTANTS.seasonTitles });

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const two = (n) => String(n).padStart(2, '0');

function instant(seconds) {
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}Z`;
}

/** The exact text a referred wallet signs (backend/points_referral.py message); addresses in lower case. */
export function referralText(season, referee, referrer, issuedAt) {
  const title = Object.hasOwn(SEASON_TITLES, season) ? SEASON_TITLES[season] : null;
  if (!title) throw new Error('referral_season_unknown');
  if (typeof referee !== 'string' || typeof referrer !== 'string' || !ADDRESS.test(referee) || !ADDRESS.test(referrer)) {
    throw new Error('invalid_address');
  }
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error('referral_issued_at_invalid');
  return `Domino Points, ${title}\nReferred wallet: ${referee.toLowerCase()}\nReferrer: ${referrer.toLowerCase()}\n` +
    `This link lasts until the end of ${title} and cannot change.\nIssued at: ${instant(issuedAt)}`;
}

// Six decimals each: a wallet's points are its points for use plus its referral points, exactly.
const scaled = (text) => BigInt(text.replace('.', ''));

function semantic(name, value) {
  try {
    if (name === 'WalletPoints') {
      return scaled(value.points) === scaled(value.usagePoints) + scaled(value.referralPoints) &&
        value.referrer !== value.address;
    }
    if (name === 'LinkResponse') return value.referee !== value.referrer;
    return true;
  } catch { return false; }
}

export const { validateRequest, validateResponse, validateError } = createContractValidators(SCHEMAS, ERRORS, semantic);
