"""Featured pools on Base and Arbitrum One: each chain's policy, checked against its profile when loaded.

Launch round P3 (4 Nov 2026), in shadow (docs/FEATURED_POOLS.md). Each chain selects with Robinhood's rules
(featured_pools, no I/O) and, as the owner decided that day, Robinhood's policy v2 values: Uniswap v3 and v4;
US$ 1M of 24 h volume, US$ 100k of TVL and US$ 10k of reference depth; the APR and turnover ceilings off, as
Robinhood's are. Its own facts sit in featured_policies/<profile>.json, which a load refuses whole unless they are
the chain profile's (api-contracts/v2/chains), so a file cannot drift from the chain it names:
- the reference tokens are the profile's base currencies, by address: its stable (USDC), ETH and WETH;
- the stable counts a depth or a major pair at US$ 1; ETH is priced by the profile's Chainlink ETH/USD feed or, on a
  chain Chainlink does not serve, the native currency by the pool its profile names (featured_chain_evidence);
- the canonical USDC, USDT, cbBTC and WBTC are real on these chains, unlike their look-alikes on Robinhood: USDC
  is the stable, and the others are reviewed by address (reviewedTokens), each an address the chain's registry
  names (the profile, or the pinned Uniswap Labs Default token list v2_chain_reads reads), so their protected
  symbols and upgradeable proxies do not keep them out. Nothing admits a symbol: a token that only reads like
  them stays out. Base's registry names no USDT or WBTC, so neither is reviewed there.
- GeckoTerminal's network and DEX ids are configuration, to be confirmed against the provider before a chain's
  shadow starts (a wrong id answers 404 and stops the listing; nothing is selected from it).
"""
from pathlib import Path

from discovery import ZERO, DataError
import featured_pools as rules
from gt_listing import GeckoNetwork
from v2_chain_reads import base_currencies, load_token_list
from v2_chains import default_registry

POLICY_DIRECTORY = Path(__file__).resolve().parent / 'featured_policies'
# The chains that select in shadow: those with a policy in featured_policies/, named by their profile, each checked
# against it when loaded. Robinhood's selection is manage_featured.py's, with featured_policy.json.
CHAINS = tuple(sorted(path.stem for path in POLICY_DIRECTORY.glob('*.json')))


def policy_path(key):
    if key not in CHAINS:
        raise DataError('featured_chain_unknown')
    return POLICY_DIRECTORY / f'{key}.json'


def check_chain_policy(policy, chain, token_list=None):
    """Refuse a chain policy whose facts are not its profile's, or which reviews a token its registry does not name."""
    _, listed = token_list if token_list is not None else load_token_list()
    named = {entry[0] for entry in listed.get(chain.chainId, ())}
    currencies = base_currencies(chain)
    references = {token: {'symbol': symbol, 'decimals': decimals} for token, symbol, decimals in currencies}
    facts = policy.get('chain')
    valid = (facts is not None and facts['chainId'] == chain.chainId and facts['profile'] == chain.key
             and facts['stable'] == currencies[0][0] and policy['referenceTokens'] == references
             and policy['sameAssetPairs'] == [[ZERO, chain.wrappedNative.address]]
             # The owner's decision of 4 Nov 2026: Uniswap v3 and v4.
             and sorted(facts['geckoTerminal']['dexes'].values()) == [rules.DEX_V3, rules.DEX_V4]
             and all(token in named and token not in references for token in policy['reviewedTokens']))
    if not valid:
        raise DataError('invalid_featured_chain_policy')


def load_chain_policy(key, *, registry=None, token_list=None, directory=None):
    """(policy, profile) of a chain that selects in shadow, refused whole unless its facts are its profile's."""
    path = policy_path(key) if directory is None else Path(directory) / Path(policy_path(key)).name
    policy = rules.load_policy(path)
    chain = (registry or default_registry()).chain(key)
    check_chain_policy(policy, chain, token_list)
    return policy, chain


def network_of(policy):
    """The policy's GeckoTerminal network, its DEX labels in Uniswap version order."""
    facts = policy['chain']
    dexes = facts['geckoTerminal']['dexes']
    return GeckoNetwork(facts['chainId'], facts['geckoTerminal']['network'],
                        tuple(sorted(dexes.items(), key=lambda item: item[1])))
