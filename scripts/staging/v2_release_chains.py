"""The V2 chains a release serves, and the hosted RPC hostnames each one's endpoints may name: v2-chains.json beside
this file, the one list the V2 installers and the egress policy read.

- install_v2_automation.py and install_monitor.py: a release carries the profile of every chain listed
  (api-contracts/v2/chains/<name>.json).
- continuous_egress_policy.py: CHAIN_HOSTS, the `chains` class, is every hosted chain's names: the hosts its V2 chain
  RPC file's endpoints name (backend/v2_rpc.py), Chainstack first, then Alchemy and the chain's public endpoint.
  Robinhood names none: its routes are the own node's and its fallback (continuous_egress_policy.RPC_HOSTS).

tests/test_continuous_egress_policy.py holds the list to api-contracts/v2/chains: exactly the enabled profiles,
Robinhood without hosts and every other chain with its own. Enabling a chain (Elysium) is its profile and its line
here, naming the providers its V2 chain RPC file will.
"""
import json
from pathlib import Path
import re

from egress_policy import HOST

PATH = Path(__file__).resolve().parent / 'v2-chains.json'
KIND = 'domino-v2-release-chains'
NAME = re.compile(r'[a-z][a-z0-9]{0,31}-[1-9][0-9]{0,18}')


def load(path=PATH):
    """{profile name: (hostname, ...)} in file order, refused whole unless every name and host is well formed and no
    host serves two chains."""
    document = json.loads(Path(path).read_text())
    if (type(document) is not dict or set(document) != {'schemaVersion', 'kind', 'chains'}
            or type(document['schemaVersion']) is not int or document['schemaVersion'] != 1
            or document['kind'] != KIND or type(document['chains']) is not dict or not document['chains']):
        raise ValueError('invalid_v2_release_chains')
    chains = {}
    for name, entry in document['chains'].items():
        if (not NAME.fullmatch(name) or type(entry) is not dict or set(entry) != {'egressHosts'}
                or type(entry['egressHosts']) is not list
                or not all(type(host) is str and HOST.fullmatch(host) for host in entry['egressHosts'])):
            raise ValueError('invalid_v2_release_chains')
        chains[name] = tuple(entry['egressHosts'])
    hosts = [host for names in chains.values() for host in names]
    if len(set(hosts)) != len(hosts):
        raise ValueError('invalid_v2_release_chains')
    return chains


CHAINS = load()
