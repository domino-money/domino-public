"""Interactive terminal setup; the API key is never a command-line argument."""
import getpass
import re
import sys

from discovery import DataError, DiscoveryReader, ReadRpc, ZERO
from inventory import AlchemyInventory
from local_config import load_config, save_config


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--position-id', type=int, help='Optional public NFT owner for an inventory probe')
    args = parser.parse_args()
    if not sys.stdin.isatty():
        print('Abra este configurador em um terminal interativo. Nenhuma chave foi solicitada.')
        return 1
    print('Domino — configurar Alchemy para o novo backend de leitura')
    print('Cole somente a API key, sem a URL. A digitacao fica oculta.')
    try:
        key = getpass.getpass('Alchemy API key: ').strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key):
            raise DataError('invalid_api_key_format')
        url = 'https://robinhood-mainnet.g.alchemy.com/v2/' + key
        del key
        reader = DiscoveryReader(ReadRpc(url, max_requests=12))
        block = reader.snapshot()
        owner = reader.position_owner(args.position_id, block) if args.position_id else ZERO
        reader.assert_canonical(block)
        print('RPC confirmado: Robinhood mainnet, chain ID 4663, contratos esperados.')
        try:
            page = AlchemyInventory(url).page(owner)
            print('Inventario: primeira pagina recebida; candidatos:', len(page['currencies']))
            print('A cobertura e os saldos ainda serao reconciliados pela API de leitura.')
        except DataError as error:
            print('Inventario indisponivel neste acesso. Codigo:', str(error))
            print('A busca por endereco continua disponivel pelo RPC validado.')
        existing = load_config()
        if existing.get('version') in (2, 3):
            # Inventory-key rotation must not silently remove independent RPCs.
            config = {**existing, 'inventoryUrl': url}
        else:
            config = {'version': 1, 'rpcUrl': url, 'inventoryUrl': url}
        save_config(config)
        print('Configuracao salva com permissao 0600, apenas para o novo backend.')
        print('Nenhuma assinatura ou transacao foi solicitada.')
        return 0
    except DataError as error:
        print('Configuracao nao salva. Codigo:', str(error))
        return 1
    except (EOFError, KeyboardInterrupt):
        print('\nConfiguracao cancelada.')
        return 1
    except OSError:
        print('Configuracao nao salva. Confira o acesso ao arquivo local.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
