"""Operator-only wallet admission; no public endpoint, wallet or network signing."""
import argparse
import json
from pathlib import Path

from catalogue import DB_CONFIG, database_settings
from discovery import CHAIN_ID
from wallet_access import WalletAccessAdmin, WalletAccessError


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # Do not echo arguments, local paths or database diagnostics.
        raise ValueError('wallet_access_invalid_request')


def main(argv=None, *, settings_loader=database_settings, admin_factory=WalletAccessAdmin):
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--database-config', type=Path, default=DB_CONFIG)
    parser.add_argument('--chain-id', type=int, choices=[CHAIN_ID], default=CHAIN_ID)
    commands = parser.add_subparsers(dest='action', required=True, parser_class=_Parser)
    for name in ('grant', 'revoke'):
        command = commands.add_parser(name, allow_abbrev=False)
        command.add_argument('address')
    listing = commands.add_parser('list', allow_abbrev=False)
    listing.add_argument('--limit', type=int, choices=range(1, 101), default=20)
    listing.add_argument('--after')
    try:
        args = parser.parse_args(argv)
        try:
            settings = settings_loader(args.database_config)
        except Exception:
            print(json.dumps({'error': 'wallet_access_configuration_unavailable'}))
            return 2
        admin = admin_factory(settings)
        if args.action == 'list':
            result = admin.list(limit=args.limit, after=args.after)
        elif args.action == 'grant':
            result = admin.grant(args.address)
        else:
            result = admin.revoke(args.address)
        print(json.dumps(result, sort_keys=True))
        return 0
    except WalletAccessError as error:
        print(json.dumps({'error': error.code}))
    except ValueError:
        print(json.dumps({'error': 'wallet_access_invalid_request'}))
    except Exception:
        print(json.dumps({'error': 'wallet_access_unavailable'}))
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
