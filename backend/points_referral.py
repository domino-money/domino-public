"""Points, season 1: referral links (docs/points/POINTS.md).

A referred wallet links itself to its referrer once per season by signing a
fixed text (EIP-191, personal_sign) that names both wallets, the season and the
time it was issued. The server rebuilds that text from the fields, recovers its
signer, and keeps the link with the text and the signature, so anyone can check
it later. The first link holds: a later one for the same wallet and season is
not recorded, and the first is returned.

The owner's rules (7 Nov 2026): one level; a wallet that already used Domino
may be referred; the referrer earns 10% of the referred wallet's points for use
from the season's start, whenever the link is made; the link lasts the season
and never changes; the same rule for everyone. Refused: a wallet referring
itself, an excluded wallet on either side (the team, Domino's roles, the
governance Safe's owners, the public test accounts), a link after the season's
end, and a text issued outside the freshness window around the server's clock.
Only a wallet's own key can sign: an EOA, EIP-7702-delegated or not, as the
session admits (eoa_or_7702_v1).
"""
from datetime import datetime, timezone
import re

from discovery import DataError, address

SIGNATURE = re.compile(r'0x[0-9a-fA-F]{130}')
SEASON_TITLES = {'points-s1': 'Season 1'}


def issued_text(issued_at):
    if type(issued_at) is not int or issued_at < 0:
        raise DataError('referral_issued_at_invalid')
    return datetime.fromtimestamp(issued_at, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def message(season_id, referee, referrer, issued_at):
    """The exact text the referred wallet signs. Wallets show it as it is, so it says what the link does."""
    title = SEASON_TITLES.get(season_id)
    if title is None:
        raise DataError('referral_season_unknown')
    return (f'Domino Points, {title}\n'
            f'Referred wallet: {address(referee)}\n'
            f'Referrer: {address(referrer)}\n'
            f'This link lasts until the end of {title} and cannot change.\n'
            f'Issued at: {issued_text(issued_at)}')


def normalized(signature):
    """r, s and v as 65 bytes of lower-case hex, v as 27 or 28 (a wallet may answer 0 or 1)."""
    if not isinstance(signature, str) or not SIGNATURE.fullmatch(signature):
        raise DataError('referral_signature_invalid')
    raw = signature[2:].lower()
    v = int(raw[128:], 16)
    if v in (0, 1):
        v += 27
    if v not in (27, 28):
        raise DataError('referral_signature_invalid')
    return '0x' + raw[:128] + f'{v:02x}'


def signer(text, signature):
    """The address that signed `text` with personal_sign, lower case."""
    from eth_account import Account
    from eth_account.messages import encode_defunct
    try:
        return Account.recover_message(encode_defunct(text=text), signature=normalized(signature)).lower()
    except DataError:
        raise
    except Exception:
        raise DataError('referral_signature_invalid') from None


def verified(season, link):
    """Whether a stored link is what its referred wallet signed: its text rebuilt from its fields, and that wallet
    recovered from its signature. A row written past record() (by any role that can insert one) does not pass."""
    try:
        text = message(season.id, link['referee'], link['referrer'], link['issued_at'])
        return (link['season'] == season.id and link['message'] == text
                and signer(text, link['signature']) == link['referee'])
    except (DataError, KeyError):
        return False


def record(conn, season, *, referee, referrer, issued_at, signature, excluded, now):
    """Record a link, or return the one that holds. {'status': 'recorded' or 'existing', 'referrer': ...}."""
    referee, referrer = address(referee), address(referrer)
    if referee == referrer:
        raise DataError('referral_self')
    if referee in excluded or referrer in excluded:
        raise DataError('referral_wallet_excluded')
    if now >= season.end:
        raise DataError('referral_season_closed')
    if type(issued_at) is not int or abs(now - issued_at) > season.freshness:
        raise DataError('referral_message_not_fresh')
    text = message(season.id, referee, referrer, issued_at)
    signature = normalized(signature)
    if signer(text, signature) != referee:
        raise DataError('referral_signature_mismatch')
    # Migration 059's function: the catalogue writer (this CLI) and the points listener (the session role) record
    # through the same statement, where the first link holds.
    row = conn.execute('SELECT outcome,holder FROM domino_points.record_link(%s,%s,%s,%s,%s,%s,%s)',
                       (season.id, referee, referrer, text, signature, issued_at, int(now))).fetchone()
    return {'status': row['outcome'], 'season': season.id, 'referee': referee, 'referrer': row['holder']}
