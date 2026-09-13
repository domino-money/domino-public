import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from performance_runtime import Runtime, private_json
from test_performance_store import OWNER, baseline


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='domino-performance-profile-')
        self.addCleanup(self.temporary.cleanup)
        self.directory=Path(self.temporary.name).resolve()
        self.runtime=self.directory/'runtime'; self.runtime.mkdir(mode=0o700)
        self.base=baseline()
        self.provider=self.write('provider.json',{'version':2,'rpcUrl':'https://rpc.mainnet.chain.robinhood.com',
            'inventoryUrl':None,'rpcFallbackUrls':[],'rpcAllowedHosts':['rpc.mainnet.chain.robinhood.com']})
        self.database=self.write('database.json',{'host':str(self.directory/'socket'),'port':8877,'dbname':'domino_catalogue'})
        self.profile={'version':1,'expiresAt':int(time.time())+600,'rpcConfig':str(self.provider),
            'databaseConfig':str(self.database),'runtimeDirectory':str(self.runtime),
            'subjects':[{'owner':OWNER,'vault':self.base.vault,'vaultCodeHash':self.base.vaultCodeHash}]}
        self.path=self.write('profile.json',self.profile)

    def write(self,name,value):
        path=self.directory/name; path.write_text(json.dumps(value)); path.chmod(0o600); return path

    def test_private_profile_explicit_subjects_and_default_cooldown(self):
        value=Runtime(self.path)
        self.assertEqual(value.admission(OWNER,self.base.vault),self.base.vaultCodeHash)
        self.assertIsNone(value.admission('0x'+'f'*40,self.base.vault))
        self.assertEqual(value.producer().tick(),'cooldown')

    def test_missing_or_linked_or_shared_configuration_fails_closed(self):
        with self.assertRaises(OSError): private_json(self.directory/'absent.json')
        link=self.directory/'linked.json'; link.symlink_to(self.path)
        with self.assertRaises(OSError): private_json(link)
        self.path.chmod(0o644)
        with self.assertRaises(ValueError): Runtime(self.path)
        self.path.chmod(0o600)
        with self.assertRaises(ValueError): private_json(Path(__file__).resolve())

    def test_expiry_is_absolute_and_has_no_provider_or_production_fallback(self):
        self.profile['expiresAt']=1; self.write('profile.json',self.profile)
        with self.assertRaises(ValueError): Runtime(self.path)
        self.profile['expiresAt']=int(time.time())+600
        self.profile['rpcConfig']=str(self.directory/'absent.json'); self.write('profile.json',self.profile)
        with self.assertRaises(OSError): Runtime(self.path)

    def test_cli_enable_requires_explicit_profile_without_starting_listener(self):
        command=[sys.executable,str(Path(__file__).resolve().parents[1]/'performance_v2_api.py'),'serve','--enable']
        result=subprocess.run(command,text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,2)
        self.assertIn('Performance configuration invalid',result.stderr)
        self.assertNotIn('Traceback',result.stderr)


if __name__=='__main__': unittest.main()
