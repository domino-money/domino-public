"""points-v1's producer fixtures: requests, responses and errors through the real models, and the text a referred
wallet signs with its signature, so the package's runtime builds byte for byte what points_referral checks."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from points_engine import load_season  # noqa: E402
from points_models import CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validate_request, validate_response  # noqa: E402
from points_referral import SEASON_TITLES, message  # noqa: E402
from points_service import instant  # noqa: E402

# A public test key (never a production role): it signs the fixture's link.
REFEREE_KEY = '0x' + '07' * 32
REFERRER = '0x' + 'aa' * 20
ERROR_EXAMPLES = ('invalid_request', 'session_required', 'csrf_invalid', 'points_unavailable', 'referral_self',
                  'referral_wallet_excluded', 'referral_season_closed', 'referral_message_not_fresh',
                  'referral_signature_invalid', 'referral_signature_mismatch')


def referee():
    from eth_account import Account
    return Account.from_key(REFEREE_KEY).address.lower()


def signed(text):
    from eth_account import Account
    from eth_account.messages import encode_defunct
    return '0x' + bytes(Account.sign_message(encode_defunct(text=text), private_key=REFEREE_KEY).signature).hex()


def build_fixtures():
    season = load_season()
    issued = season.start + 3661
    text = message(season.id, referee(), REFERRER, issued)
    signature = signed(text)
    requests = {'points': {}, 'link': {'referrer': REFERRER, 'issuedAt': issued, 'signature': signature}}
    for route, body in requests.items():
        validate_request(route, body)
    view = {'id': season.id, 'title': SEASON_TITLES[season.id], 'start': instant(season.start),
            'end': instant(season.end), 'configSha256': season.sha256}
    responses = {
        'points': {'contractVersion': CONTRACT_VERSION, 'season': view,
                   'snapshot': {'takenAt': season.start + 7500, 'sha256': '3' * 64},
                   'wallet': {'address': referee(), 'points': '1715.000000', 'usagePoints': '1650.000000',
                              'referralPoints': '65.000000',
                              'revenueUsd': {'assistedSwap': '0.650000000000000000',
                                             'automation': '0.650000000000000000',
                                             'autoExit': '0.000000000000000000',
                                             'bridge': '0.350000000000000000'},
                              'referrer': REFERRER, 'referees': 1}},
        'link': {'contractVersion': CONTRACT_VERSION, 'status': 'recorded', 'referee': referee(),
                 'referrer': REFERRER}}
    for route, body in responses.items():
        validate_response(route, body)
    errors = [{'status': ERROR_STATUS_BY_CODE[code], 'body': {'error': code}} for code in ERROR_EXAMPLES]
    signed_text = {'season': season.id, 'referee': referee(), 'referrer': REFERRER, 'issuedAt': issued,
                   'text': text, 'signature': signature}
    return requests, responses, errors, signed_text
