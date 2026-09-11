"""Configure up to three operator-owned RPC endpoints through hidden terminal input."""
import argparse
import getpass
import sys
from urllib.parse import urlsplit

from discovery import DataError, DiscoveryReader, ReadRpc, parse_block
from local_config import CONFIG_PATH, checked_config, load_config, save_config
from read_service import bounded_transport
from rpc_config import DEFAULT_RPC_HOSTS, MAX_RPC_ENDPOINTS, rpc_hosts


def prepare_config(existing, urls):
    if not isinstance(urls, list) or not 1 <= len(urls) <= MAX_RPC_ENDPOINTS or any(not isinstance(url, str) for url in urls):
        raise DataError('invalid_rpc_endpoints')
    hosts = list(dict.fromkeys([*DEFAULT_RPC_HOSTS, *(urlsplit(url).hostname for url in urls)]))
    rpc_hosts(hosts)
    return checked_config({'version':2,'rpcUrl':urls[0],'rpcFallbackUrls':urls[1:],
                           'rpcAllowedHosts':hosts,'inventoryUrl':existing.get('inventoryUrl')})


def probe_endpoints(urls, *, rpc_factory=None):
    readers=[]
    # One cumulative budget for every endpoint and final canonicality check.
    transport=bounded_transport(30)
    for url in urls:
        rpc=rpc_factory(url) if rpc_factory else ReadRpc(url,transport=transport,max_requests=14)
        reader=DiscoveryReader(rpc)
        observed=reader.snapshot()
        if readers:
            first=readers[0][1]
            if parse_block(rpc.request('eth_getBlockByNumber',[first.tag,False])) != first:
                raise DataError('rpc_snapshot_mismatch')
        readers.append((reader,observed))
    for reader,observed in readers:reader.assert_canonical(observed)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-file',type=str,default=str(CONFIG_PATH))
    args=parser.parse_args()
    if not sys.stdin.isatty():
        print('Open this configurator in an interactive terminal. No endpoint was requested.')
        return 1
    try:
        existing=load_config(args.config_file)
        count=input('Number of RPC endpoints (1–3): ').strip()
        if count not in ('1','2','3'):raise DataError('invalid_rpc_endpoint_count')
        print('Enter exact HTTPS URLs. Input is hidden. No wallet or transaction is used.')
        urls=[getpass.getpass(f'RPC {i+1} URL: ').strip() for i in range(int(count))]
        data=prepare_config(existing,urls)
        probe_endpoints(urls)
        save_config(data,args.config_file)
        print('Saved private provider configuration; chain, managers and shared block verified.')
        print('Restart the product reader to apply it. Inventory configuration was preserved.')
        return 0
    except (EOFError,KeyboardInterrupt):
        print('\nConfiguration cancelled.');return 1
    except DataError as error:
        print('Configuration not saved. Code:',str(error));return 1
    except (OSError,ValueError,TypeError):
        print('Configuration not saved. Check the local file and endpoint format.');return 1


if __name__=='__main__':raise SystemExit(main())
