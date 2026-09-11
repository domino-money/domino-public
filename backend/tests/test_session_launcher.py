"""Offline launcher guards use disposable files, never operational config."""
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from session_api import acquire_session_lock, load_session_rpc_config, main


class SessionLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='domino-session-launch-')
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)

    def test_explicit_missing_empty_and_insecure_rpc_files_fail_without_provider_default(self):
        with self.assertRaises(ValueError):load_session_rpc_config(None)
        with self.assertRaises(ValueError):load_session_rpc_config(self.root/'missing.json')
        path=self.root/'providers.json'
        path.write_text('{}');path.chmod(0o600)
        with self.assertRaises(DataError):load_session_rpc_config(path)
        config={'version':2,'rpcUrl':'https://rpc.mainnet.chain.robinhood.com','inventoryUrl':None,
                'rpcFallbackUrls':[],'rpcAllowedHosts':['rpc.mainnet.chain.robinhood.com']}
        path.write_text(json.dumps(config))
        self.assertEqual(load_session_rpc_config(path),config)
        path.chmod(0o644)
        with self.assertRaises(DataError):load_session_rpc_config(path)
        path.chmod(0o600)
        link=self.root/'symlink.json';link.symlink_to(path)
        with self.assertRaises(DataError):load_session_rpc_config(link)

    def test_lock_private_permissions_exclusive_and_reusable_after_close(self):
        runtime=self.root/'runtime'
        first=acquire_session_lock(runtime)
        try:
            self.assertEqual(runtime.stat().st_mode&0o777,0o700)
            self.assertEqual((runtime/'session-api.lock').stat().st_mode&0o777,0o600)
            with self.assertRaises(OSError):acquire_session_lock(runtime)
        finally:os.close(first)
        os.close(acquire_session_lock(runtime))

    def test_nonprivate_or_symlink_runtime_is_rejected(self):
        runtime=self.root/'runtime';runtime.mkdir(mode=0o755)
        with self.assertRaises(ValueError):acquire_session_lock(runtime)
        runtime.chmod(0o700)
        link=self.root/'runtime-link';link.symlink_to(runtime,target_is_directory=True)
        with self.assertRaises(ValueError):acquire_session_lock(link)

    def test_lock_rejects_symlink_hardlink_fifo_directory_and_nonprivate_file(self):
        for kind in ('symlink','hardlink','fifo','directory','permissions'):
            with self.subTest(kind=kind):
                runtime=self.root/kind;runtime.mkdir(mode=0o700)
                target=runtime/'session-api.lock'
                original=self.root/(kind+'-original');original.touch(mode=0o600)
                if kind=='symlink':target.symlink_to(original)
                elif kind=='hardlink':os.link(original,target)
                elif kind=='fifo':os.mkfifo(target,mode=0o600)
                elif kind=='directory':target.mkdir(mode=0o700)
                else:target.touch(mode=0o644)
                with self.assertRaises((ValueError,OSError)):acquire_session_lock(runtime)
                self.assertTrue(original.exists())

    def test_foreign_lock_owner_is_rejected_and_descriptor_closed(self):
        runtime=self.root/'runtime'
        fstat=os.fstat
        observed=[]
        def foreign(fd):
            observed.append(fd)
            value=fstat(fd)
            return SimpleNamespace(st_mode=value.st_mode,st_nlink=value.st_nlink,st_uid=os.getuid()+1)
        with patch('session_api.os.fstat',side_effect=foreign):
            with self.assertRaises(ValueError):acquire_session_lock(runtime)
        with self.assertRaises(OSError):os.fstat(observed[0])

    def test_config_failure_closes_lock_and_disabled_launch_reads_no_rpc_config(self):
        fd=acquire_session_lock(self.root/'runtime')
        with patch('session_api.acquire_session_lock',return_value=fd),patch.dict(os.environ,{},clear=True),\
                patch.object(sys,'argv',['session_api.py','--enable']),patch('uvicorn.run') as server:
            with self.assertRaises(SystemExit) as error:main()
            self.assertEqual(error.exception.code,2)
            server.assert_not_called()
        with self.assertRaises(OSError):os.fstat(fd)
        fd=acquire_session_lock(self.root/'runtime')
        with patch('session_api.acquire_session_lock',return_value=fd),patch.dict(os.environ,{},clear=True),\
                patch.object(sys,'argv',['session_api.py']),patch('session_api.load_session_rpc_config') as loader,\
                patch('uvicorn.run') as server:
            main()
            loader.assert_not_called()
            self.assertFalse(server.call_args.args[0].state.gateway.enabled)
            self.assertEqual(server.call_args.kwargs['host'],'127.0.0.1')
            self.assertEqual(server.call_args.kwargs['workers'],1)
            self.assertFalse(server.call_args.kwargs['proxy_headers'])
            self.assertFalse(server.call_args.kwargs['access_log'])
        with self.assertRaises(OSError):os.fstat(fd)


if __name__=='__main__':unittest.main()
