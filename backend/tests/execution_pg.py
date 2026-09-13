"""Disposable E5-only PostgreSQL fixture; no shared dev cluster/config mutation."""
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile

import psycopg

from dev_postgres import postgres_bin


class ExecutionPostgres:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='domino-e5-pg-',dir='/tmp'))
        self.data,self.socket = self.root/'data',self.root/'socket'
        self.socket.mkdir(mode=0o700)
        self.bin=postgres_bin()
        self.started=False
        self.settings={'host':str(self.socket),'port':18897,'dbname':'execution_test'}

    def run(self,*args):
        result=subprocess.run([str(self.bin/args[0]),*args[1:]],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
        if result.returncode:
            raise RuntimeError(f'Execution PostgreSQL fixture failed: {args[0]}: {result.stdout[-1800:]}')

    def start(self):
        try:
            self.run('initdb','-D',str(self.data),'-U','execution_test_admin','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C')
            opts=shlex.join(['-k',str(self.socket),'-p','18897','-c','listen_addresses=','-c','unix_socket_permissions=0700'])
            self.run('pg_ctl','-D',str(self.data),'-l',str(self.root/'postgres.log'),'-o',opts,'-w','-t','15','start')
            self.started=True
            with psycopg.connect(host=str(self.socket),port=18897,dbname='postgres',user='execution_test_admin',autocommit=True) as conn:
                conn.execute('CREATE DATABASE execution_test')
            with self.admin() as conn:
                conn.execute((Path(__file__).resolve().parents[1]/'migrations/015_unsigned_execution.sql').read_text())
                # Login enabled ONLY in this private socket fixture. Real provisioning
                # remains an operator action; the migration creates group roles.
                for role in ('domino_execution_worker','domino_execution_ledger','domino_execution_owner'):
                    conn.execute(f'ALTER ROLE {role} LOGIN')
            return self
        except BaseException:
            self.close()
            raise

    def admin(self,**kwargs):
        return psycopg.connect(**self.settings,user='execution_test_admin',**kwargs)

    def close(self):
        if self.started:
            self.run('pg_ctl','-D',str(self.data),'-m','immediate','-w','-t','15','stop')
            self.started=False
        if self.root.exists():
            shutil.rmtree(self.root)
