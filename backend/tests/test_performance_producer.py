from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from performance_producer import ProducerRpc, PerformanceProducer
from performance_collection import CollectionError
from performance_store import PerformanceStoreError
from read_deadline import read_deadline


class ProducerTests(unittest.TestCase):
    def test_global_transport_budget_counts_errors_and_survives_operation_factories(self):
        now=[0]
        transport=SimpleNamespace(request=Mock(return_value='0x1'))
        rpc=ProducerRpc(transport,maximum=2,clock=lambda:now[0])
        with self.assertRaises(CollectionError): rpc.request('eth_chainId')
        now[0]=60
        self.assertEqual(rpc.request('eth_chainId'),'0x1')
        transport.request.side_effect=ValueError('private provider')
        with self.assertRaises(ValueError): rpc.request('eth_getBlockByNumber',['finalized',False])
        with self.assertRaises(CollectionError): rpc.request('eth_chainId')
        self.assertEqual(transport.request.call_count,2)
        now[0]=120; transport.request.side_effect=None
        self.assertEqual(rpc.request('eth_chainId'),'0x1')
        restarted=ProducerRpc(transport,maximum=2,clock=lambda:now[0])
        with self.assertRaises(CollectionError): restarted.request('eth_chainId')
        with self.assertRaises(CollectionError): rpc.request('eth_sendRawTransaction',['secret'])

    def producer(self):
        rpc=ProducerRpc(SimpleNamespace(request=Mock()),clock=lambda:100)
        rpc.ready_at=100
        queue=SimpleNamespace(claim=Mock(),bind_baseline=Mock(return_value={'epochId':'epoch'}),finish=Mock())
        financial_store=SimpleNamespace(next_financial_page=Mock(return_value={'epoch':{'status':'active'},'financial':{},'page':None}))
        instance=PerformanceProducer(rpc,queue,Mock(),financial_store,['owner'])
        instance.collector=SimpleNamespace(capture=Mock(return_value='baseline'))
        instance.raw=SimpleNamespace(advance=Mock(return_value=SimpleNamespace(outcome='advanced')))
        instance.financial=SimpleNamespace(advance=Mock(return_value=SimpleNamespace(outcome='advanced')))
        job={'owner':'owner','epoch_id':None,'vault':'vault','token_ids':['1'],'vault_code_hash':'hash'}
        queue.claim.return_value=job
        return instance,queue,job

    def test_capture_binds_atomically_then_one_financial_step_only(self):
        p,q,_=self.producer()
        self.assertEqual(p.tick(),'advanced')
        q.bind_baseline.assert_called_once()
        p.raw.advance.assert_not_called()
        p.financial.advance.assert_called_once_with('owner','epoch')

    def test_restart_uses_saved_epoch_instead_of_new_capture(self):
        p,q,job=self.producer(); job['epoch_id']='saved'
        self.assertEqual(p.tick(),'advanced')
        p.collector.capture.assert_not_called()
        p.raw.advance.assert_called_once_with('owner','saved')
        p.financial.advance.assert_called_once_with('owner','saved')

    def test_reorg_and_failed_reads_preserve_evidence_without_fabricating_progress(self):
        p,q,job=self.producer(); job['epoch_id']='saved'
        p.raw.advance.return_value=SimpleNamespace(outcome='baseline_reorged')
        self.assertEqual(p.tick(),'blocked'); p.financial.advance.assert_not_called()
        p.raw.advance.side_effect=CollectionError('private provider value')
        self.assertEqual(p.tick(),'failed')
        self.assertEqual(q.finish.call_args.args[-1],'failed')

    def test_no_current_visible_job_means_no_rpc(self):
        p,q,_=self.producer(); q.claim.return_value=None
        self.assertEqual(p.tick(),'idle')
        p.raw.advance.assert_not_called(); p.financial.advance.assert_not_called(); p.collector.capture.assert_not_called()

    def test_financial_backlog_precedes_more_raw_work_after_budget_failure(self):
        p,q,job=self.producer(); job['epoch_id']='saved'
        p.financial_store.next_financial_page.return_value['page']={'persisted':'raw page'}
        self.assertEqual(p.tick(),'advanced')
        p.raw.advance.assert_not_called()
        p.financial.advance.assert_called_once_with('owner','saved')

    def test_pending_reorganized_page_returns_to_raw_canonicality_fence(self):
        p,q,job=self.producer(); job['epoch_id']='saved'
        pending=p.financial_store.next_financial_page.return_value
        pending['page']={'persisted':'old raw page'}
        pending['financial']['lastError']='financial_reorg_detected'
        p.raw.advance.return_value=SimpleNamespace(outcome='baseline_reorged')
        self.assertEqual(p.tick(),'blocked')
        p.raw.advance.assert_called_once_with('owner','saved')
        p.financial.advance.assert_not_called()

    def test_pending_minute_keeps_short_cadence_without_extra_raw_or_financial_steps(self):
        p,q,job=self.producer();job['epoch_id']='saved'
        p.raw.advance.return_value=SimpleNamespace(outcome='caught_up')
        p.financial.advance.return_value=SimpleNamespace(outcome='caught_up')
        p.projector=SimpleNamespace(advance=Mock(return_value='advanced'))
        self.assertEqual(p.tick(),'advanced')
        p.projector.advance.assert_called_once_with('owner','saved')
        p.raw.advance.assert_called_once();p.financial.advance.assert_called_once()
        p.projector.advance.return_value='caught_up'
        self.assertEqual(p.tick(),'caught_up')
        p.financial.advance.return_value=SimpleNamespace(outcome='read_failed')
        p.projector.advance.reset_mock()
        self.assertEqual(p.tick(),'failed')
        p.projector.advance.assert_not_called()


if __name__=='__main__': unittest.main()
