"""Save the Uniswap API key from a hidden, interactive terminal prompt."""
import argparse
import getpass
from pathlib import Path
import sys

from discovery import DataError
from uniswap_config import CONFIG_PATH,checked,save_config
from uniswap_liquidity import probe


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-file',type=Path,default=CONFIG_PATH)
    args=parser.parse_args()
    if not sys.stdin.isatty():
        print('Abra este configurador em um Terminal interativo. Nenhuma chave foi solicitada.')
        return 1
    print('Domino — configurar a API da Uniswap')
    print('Cole a chave da Uniswap Developers. A entrada fica oculta.')
    try:
        key=getpass.getpass('Uniswap API key: ').strip()
        data=checked({'version':1,'apiKey':key})
        print('Verificando acesso de leitura a uma pool publica WETH/USDG na Robinhood...')
        probe(key)
        save_config(data,args.config_file)
        print('Pool consultada com sucesso. Chave salva localmente com permissao 0600.')
        print('Nenhuma assinatura ou transacao foi solicitada.')
        return 0
    except DataError as error:
        print('Configuracao nao salva. Codigo:',str(error));return 1
    except (EOFError,KeyboardInterrupt):
        print('\nConfiguracao cancelada.');return 1
    except OSError:
        print('Configuracao nao salva. Confira o acesso ao arquivo local.');return 1


if __name__=='__main__':raise SystemExit(main())
