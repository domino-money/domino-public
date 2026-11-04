"""Disposable PostgreSQL + public synthetic keys; no provider or wallet reads."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
from threading import Barrier, BrokenBarrierError, Event
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from eth_account import Account
from eth_account.messages import encode_defunct

from dev_postgres import ADMIN, PORT, SOCKET
from read_deadline import read_deadline
from session_models import SessionError
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import (CAPACITIES, CLEANUP_BATCH, ISSUANCE_GLOBAL_PER_MINUTE, ISSUANCE_IP_PER_MINUTE,
                           VERIFY_GLOBAL_PER_MINUTE, VERIFY_IP_PER_MINUTE, SessionStore, digest, session_csrf,
                           _DeadlineConnection)

VALIDATION={'method':'plain_eoa','blockNumber':'123','blockHash':'0x'+'ab'*32}
DELEGATE='0x'+'d7'*20
DELEGATED={**VALIDATION,'method':'eip7702_delegated','delegate':DELEGATE}
SECRET=b'synthetic shared abuse-key secret only'
# A partner reaches the account check only after its own connect, advisory lock
# and statements, each already bounded by the store (connect 2 s, statement 1 s,
# lock 250 ms). The meeting only has to outlast a loaded runner, never a hang.
MEETING_TIMEOUT=30


class Meeting:
    """Two threads that must be inside the account check at the same time.

    A thread denied before it arrives abandons the meeting, so its partner fails
    with the real reason instead of raising BrokenBarrierError out of the store
    once the wait expires. That error is not a SessionError, so it escapes the
    suite's handling and hides the denial behind a threading traceback.
    """
    def __init__(self,value=VALIDATION):self.barrier=Barrier(2);self.value=value
    def arrive(self,_address=None):
        self.barrier.wait(timeout=MEETING_TIMEOUT)
        return dict(self.value)
    def abandon(self):self.barrier.abort()


class Checker:
    def __init__(self):self.calls=[];self.effect=None
    def check(self,address):
        self.calls.append(address)
        if self.effect:return self.effect(address)
        return dict(VALIDATION)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class SessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
        self.admin=psycopg.connect(**self.settings,user=ADMIN,autocommit=True,row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits')
        self.account=Account.from_key(bytes([3])*32)
        self.checker=Checker()
        self.store=SessionStore(self.settings,abuse_secret=SECRET)
        self.service=SessionService(self.store,SiwePolicy('https://domino.money'),self.checker)
        self.peer=SessionService(SessionStore(self.settings,abuse_secret=SECRET),SiwePolicy('https://domino.money'),self.checker)

    def call(self,route,body=None,*,service=None,**credentials):
        return (service or self.service).execute(route,body or {},client=credentials.pop('client','192.0.2.1'),**credentials)

    def meet(self,meeting,route,body=None,**credentials):
        """One side of a concurrent pair; a denial releases the waiting partner."""
        try:return self.call(route,body,**credentials)
        except BaseException:meeting.abandon();raise

    def pending(self,client='192.0.2.1'):
        initial=self.call('bootstrap',client=client)
        credentials={'preauth':initial['credentials']['preauth'],'csrf':initial['result']['csrfToken'],'client':client}
        challenge=self.call('challenge',{'address':self.account.address,'chainId':4663},**credentials)['result']
        signature='0x'+Account.sign_message(encode_defunct(text=challenge['message']),self.account.key).signature.hex()
        return credentials,{'challengeId':challenge['challengeId'],'message':challenge['message'],'signature':signature}

    def login(self,client='192.0.2.1'):
        preauth,body=self.pending(client)
        result=self.call('verify',body,**preauth)
        return preauth,body,{'session':result['credentials']['session'],'csrf':result['result']['csrfToken'],'client':client},result

    def error(self,code,operation):
        with self.assertRaises(SessionError) as raised:operation()
        self.assertEqual(raised.exception.code,code)

    def test_durable_lifecycle_hashes_restart_recovery_and_logout(self):
        preauth,body,credentials,result=self.login()
        self.assertEqual(result['result']['owner'],{'address':self.account.address.lower(),'chainId':4663})
        rows=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchall()
        self.assertEqual(len(rows),1)
        self.assertEqual(bytes(rows[0]['bearer_hash']),digest(credentials['session']))
        self.assertEqual(bytes(rows[0]['csrf_hash']),digest(credentials['csrf']))
        for secret in (credentials['session'],credentials['csrf'],preauth['preauth'],preauth['csrf']):
            self.assertNotIn(secret,str(rows))
        me=self.call('me',service=self.peer,**credentials)
        self.assertEqual(me['credentials'],{})
        self.assertEqual(me['result']['csrfToken'],credentials['csrf'])
        self.assertEqual(self.call('logout',**credentials)['result'],{'authenticated':False})
        self.error('session_required',lambda:self.call('me',service=self.peer,**credentials))

    def test_two_concurrent_valid_submits_commit_one_session(self):
        credentials,body=self.pending()
        meeting=Meeting()
        self.checker.effect=meeting.arrive
        def submit(service):
            try:return self.call('verify',body,service=service,**credentials)
            except SessionError as error:meeting.abandon();return error.code
            except BrokenBarrierError:return 'partner_never_arrived'
        with ThreadPoolExecutor(2) as pool:
            outcomes=list(pool.map(submit,(self.service,self.peer)))
        # Both submits have to be inside the check for the race to be the one
        # under test; one denied earlier makes every assertion below vacuous.
        self.assertEqual(len(self.checker.calls),2,outcomes)
        self.assertEqual(sum(isinstance(value,dict) for value in outcomes),1)
        self.assertIn('challenge_invalid',outcomes)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.sessions').fetchone()['n'],1)
        row=self.admin.execute('SELECT * FROM domino_sessions.challenges').fetchone()
        self.assertEqual(row['attempts'],2)
        self.assertIsNotNone(row['consumed_at'])

    def test_lost_response_replay_cannot_mint_second_session(self):
        preauth,body,credentials,result=self.login()
        self.error('preauth_required',lambda:self.call('verify',body,**preauth))
        self.assertEqual(len(self.checker.calls),1)

    def test_logout_aborts_inflight_verify_before_or_after_consume(self):
        preauth,body=self.pending()
        entered,released=Event(),Event()
        self.checker.effect=lambda address: (entered.set(),released.wait(3),dict(VALIDATION))[-1]
        with ThreadPoolExecutor(1) as pool:
            future=pool.submit(self.call,'verify',body,**preauth)
            self.assertTrue(entered.wait(2))
            self.call('logout',service=self.peer,**preauth)
            released.set()
            self.error('challenge_invalid',future.result)
        self.checker.effect=None
        p,b,credentials,result=self.login('192.0.2.2')
        self.call('logout',**p)
        self.error('session_required',lambda:self.call('me',**credentials))

    def test_logout_during_code_check_prevents_late_private_success(self):
        p,b,credentials,result=self.login()
        entered,released=Event(),Event()
        self.checker.effect=lambda address: (entered.set(),released.wait(3),dict(VALIDATION))[-1]
        with ThreadPoolExecutor(1) as pool:
            future=pool.submit(self.call,'refresh',**credentials)
            self.assertTrue(entered.wait(2))
            self.call('logout',service=self.peer,**credentials)
            released.set()
            self.error('session_required',future.result)

    def test_active_session_cannot_be_replaced_before_explicit_logout(self):
        # Both contexts predate the first successful login, as can happen with
        # concurrent browser tabs/bootstrap responses.
        first,first_body=self.pending('192.0.2.1')
        second,second_body=self.pending('192.0.2.2')
        logged=self.call('verify',first_body,**first)
        credentials={'session':logged['credentials']['session'],'csrf':logged['result']['csrfToken']}
        before=len(self.checker.calls)
        self.error('session_exists',lambda:self.call('verify',second_body,session=credentials['session'],**second))
        self.assertEqual(len(self.checker.calls),before)
        self.call('logout',service=self.peer,**credentials)
        self.error('session_required',lambda:self.call('me',**credentials))
        # After explicit logout an inactive prior cookie can be rotated; it
        # never regains authority and the new credential is independently random.
        second_result=self.call('verify',second_body,session=credentials['session'],**second)
        self.assertNotEqual(second_result['credentials']['session'],credentials['session'])
        self.error('session_required',lambda:self.call('me',**credentials))

    def test_final_mint_rechecks_no_presented_active_session_and_keeps_challenge(self):
        first,first_body=self.pending('192.0.2.1')
        second,second_body=self.pending('192.0.2.2')
        reserved=self.store.reserve_verify(second['client'],second['preauth'],second['csrf'],
                                           second_body['challengeId'],second_body['message'])
        active=self.call('verify',first_body,**first)
        self.error('session_exists',lambda:self.store.finish_verify(second['preauth'],second['csrf'],reserved,VALIDATION,
                                                                   active['credentials']['session']))
        self.assertIsNone(self.admin.execute('SELECT consumed_at FROM domino_sessions.challenges WHERE id=%s',
                                            (second_body['challengeId'],)).fetchone()['consumed_at'])
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.sessions').fetchone()['n'],1)

    def test_bootstrap_reset_invalidates_old_challenge_but_cannot_replace_active_session(self):
        preauth,body=self.pending()
        self.call('bootstrap',preauth=preauth['preauth'])
        self.error('preauth_required',lambda:self.call('verify',body,**preauth))
        p,b,credentials,result=self.login('192.0.2.2')
        self.error('session_exists',lambda:self.call('bootstrap',**credentials))
        self.error('session_exists',lambda:self.call('bootstrap',**p))
        self.call('me',**credentials)

    def test_unrelated_preauth_csrf_cannot_downgrade_active_session_logout(self):
        p,b,credentials,result=self.login()
        other=self.call('bootstrap',client='192.0.2.2')
        self.error('csrf_invalid',lambda:self.call('logout',session=credentials['session'],
            preauth=other['credentials']['preauth'],csrf=other['result']['csrfToken']))
        self.call('logout',session=credentials['session'],preauth=p['preauth'],csrf=p['csrf'])
        self.error('session_required',lambda:self.call('me',**credentials))

    def test_account_code_failure_denies_without_revocation_but_changed_code_revokes(self):
        p,b,credentials,result=self.login()
        def fail(code):
            def failure(address):raise SessionError(code)
            return failure
        self.checker.effect=fail('account_check_unavailable')
        self.error('account_check_unavailable',lambda:self.call('refresh',**credentials))
        self.assertIsNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
        self.checker.effect=None
        self.call('refresh',**credentials)
        self.checker.effect=fail('account_unsupported')
        self.error('account_unsupported',lambda:self.call('refresh',**credentials))
        self.assertIsNotNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
        self.checker.effect=None
        self.error('session_required',lambda:self.call('me',**credentials))

    def test_a_delegated_account_signs_in_and_keeps_its_delegate(self):
        self.checker.effect=lambda _: dict(DELEGATED)
        p,b,c,r=self.login()
        self.assertEqual(r['result']['validation'],DELEGATED)
        row=self.admin.execute('SELECT policy,delegate FROM domino_sessions.sessions').fetchone()
        self.assertEqual((row['policy'],row['delegate']),('eoa_or_7702_v1',DELEGATE))
        # A reload reports what was admitted, with no fresh read.
        self.assertEqual(self.call('me',session=c['session'])['result']['validation'],DELEGATED)
        self.assertEqual(self.call('refresh',**c)['result']['validation'],DELEGATED)
        self.assertIsNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])

    def test_a_changed_account_kind_or_delegate_revokes_at_refresh(self):
        other={**DELEGATED,'delegate':'0x'+'e8'*20}
        for admitted,observed in ((VALIDATION,DELEGATED),(DELEGATED,other),(DELEGATED,VALIDATION)):
            with self.subTest(admitted=admitted['method'],observed=observed.get('delegate')):
                self.setUp()
                self.checker.effect=lambda _,v=admitted: dict(v)
                p,b,c,r=self.login()
                self.checker.effect=lambda _,v=observed: dict(v)
                self.error('session_required',lambda:self.call('refresh',**c))
                self.assertIsNotNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
                self.error('session_required',lambda:self.call('me',session=c['session']))

    def test_a_changed_delegate_revokes_every_authenticated_preview(self):
        # Onboarding, deposits, performance and execution status share this path.
        self.checker.effect=lambda _: dict(DELEGATED)
        p,b,c,r=self.login()
        owner=self.store.begin_preview('192.0.2.1',c['session'],c['csrf'])['address']
        self.store.finish_preview(c['session'],c['csrf'],owner,dict(DELEGATED))
        self.assertIsNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
        self.error('session_required',lambda:self.store.finish_preview(
            c['session'],c['csrf'],owner,{**DELEGATED,'delegate':'0x'+'e8'*20}))
        self.assertIsNotNone(self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions').fetchone()['revoked_at'])
        self.error('session_required',lambda:self.store.begin_preview('192.0.2.1',c['session'],c['csrf']))

    def test_a_session_admitted_under_the_plain_eoa_policy_signs_in_again(self):
        p,b,c,r=self.login()
        self.admin.execute("UPDATE domino_sessions.sessions SET policy='plain_eoa_v1'")
        self.error('session_required',lambda:self.call('me',session=c['session']))
        self.error('session_required',lambda:self.call('refresh',**c))

    def test_the_schema_keeps_delegates_to_the_new_policy_and_to_real_addresses(self):
        self.checker.effect=lambda _: dict(DELEGATED)
        self.login()
        for statement,value in (("UPDATE domino_sessions.sessions SET delegate=%s",'0x'+'0'*40),
                                ("UPDATE domino_sessions.sessions SET delegate=%s",'0x'+'D7'*20),
                                ("UPDATE domino_sessions.sessions SET delegate=%s",'0x'+'d7'*19),
                                ("UPDATE domino_sessions.sessions SET policy=%s",'plain_eoa_v1'),
                                ("UPDATE domino_sessions.sessions SET policy=%s",'contract_v1')):
            with self.subTest(statement=statement,value=value), self.assertRaises(psycopg.errors.CheckViolation):
                self.admin.execute(statement,(value,))

    def test_expired_challenge_context_absolute_and_idle_never_reach_checker(self):
        p,b=self.pending()
        self.admin.execute("UPDATE domino_sessions.challenges SET issued_at=statement_timestamp()-interval '301 seconds',"
                           "expires_at=statement_timestamp()-interval '1 second'")
        self.error('challenge_invalid',lambda:self.call('verify',b,**p))
        self.assertEqual(self.checker.calls,[])
        self.admin.execute("UPDATE domino_sessions.contexts SET created_at=statement_timestamp()-interval '601 seconds',"
                           "expires_at=statement_timestamp()-interval '1 second'")
        self.error('preauth_required',lambda:self.call('challenge',{'address':self.account.address,'chainId':4663},**p))
        p,b,c,r=self.login('192.0.2.2')
        self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '13 hours',"
                           "expires_at=statement_timestamp()-interval '1 hour',last_used_at=statement_timestamp()-interval '2 hours'")
        before=len(self.checker.calls)
        self.error('session_required',lambda:self.call('me',**c))
        self.assertEqual(len(self.checker.calls),before)
        p,b,c,r=self.login('192.0.2.3')
        self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '1 hour',"
                           "expires_at=statement_timestamp()+interval '11 hours',last_used_at=statement_timestamp()-interval '31 minutes'")
        before=len(self.checker.calls)
        self.error('session_required',lambda:self.call('me',**c))
        self.assertEqual(len(self.checker.calls),before)

    def test_invalid_attempts_and_ip_limits_are_shared_but_unsigned_addresses_have_no_quota(self):
        p,b=self.pending()
        wrong={**b,'message':b['message']+'x'}
        for index in range(5):self.error('challenge_invalid',lambda:self.call('verify',wrong,service=self.peer,**p))
        self.assertEqual(self.admin.execute('SELECT attempts FROM domino_sessions.challenges').fetchone()['attempts'],5)
        self.error('challenge_invalid',lambda:self.call('verify',b,**p))
        self.assertEqual(self.checker.calls,[])
        for index in range(ISSUANCE_IP_PER_MINUTE):self.call('bootstrap',service=self.peer,client='192.0.2.9')
        self.error('session_rate_limited',lambda:self.call('bootstrap',client='192.0.2.9'))
        for index in range(21):self.pending(f'198.51.100.{index+1}')
        initial=self.call('bootstrap',client='198.51.100.30')
        self.call('challenge',{'address':self.account.address,'chainId':4663},
            client='198.51.100.30',preauth=initial['credentials']['preauth'],csrf=initial['result']['csrfToken'])
        key=self.store._key('verified-address',self.account.address.lower())
        self.assertIsNone(self.admin.execute('SELECT * FROM domino_sessions.rate_limits WHERE key_hash=%s',(key,)).fetchone())

    def count(self,kind,value):
        row=self.admin.execute('SELECT count FROM domino_sessions.rate_limits WHERE key_hash=%s',
                               (self.store._key(kind,value),)).fetchone()
        return row and row['count']

    def fill(self,kind,value,count,seconds):
        self.admin.execute("INSERT INTO domino_sessions.rate_limits VALUES (%s,clock_timestamp()+%s*interval '1 second',%s) "
                           'ON CONFLICT(key_hash) DO UPDATE SET reset_at=EXCLUDED.reset_at,count=EXCLUDED.count',
                           (self.store._key(kind,value),seconds,count))

    def refused(self,operation):
        with self.assertRaises(SessionError) as raised:operation()
        self.assertEqual(raised.exception.code,'session_rate_limited')
        return raised.exception.retry_after

    def test_a_refused_sign_in_step_charges_neither_its_ip_nor_the_site(self):
        # 3 Nov 2026 (launch): every limit is read before any is charged, so no refusal spends a budget.
        for index in range(ISSUANCE_IP_PER_MINUTE):self.call('bootstrap',client='192.0.2.9')
        self.refused(lambda:self.call('bootstrap',client='192.0.2.9'))
        self.assertEqual(self.count('issuance-global','all'),ISSUANCE_IP_PER_MINUTE)
        self.fill('issuance-global','all',ISSUANCE_GLOBAL_PER_MINUTE,42)
        self.assertTrue(40<self.refused(lambda:self.call('bootstrap',client='192.0.2.10'))<=42)
        self.assertIsNone(self.count('issuance-ip','192.0.2.10'))
        # Its fullest window is the one named, whichever limit is read first.
        for site,ip in ((50,10),(10,50)):
            self.fill('issuance-global','all',ISSUANCE_GLOBAL_PER_MINUTE,site)
            self.fill('issuance-ip','192.0.2.9',ISSUANCE_IP_PER_MINUTE,ip)
            self.assertTrue(48<self.refused(lambda:self.call('bootstrap',client='192.0.2.9'))<=50,(site,ip))

    def test_a_refused_challenge_or_verify_charges_neither_its_ip_nor_the_site(self):
        credentials,body=self.pending()
        before=self.count('issuance-ip',credentials['client'])
        self.fill('issuance-global','all',ISSUANCE_GLOBAL_PER_MINUTE,30)
        self.refused(lambda:self.call('challenge',{'address':self.account.address,'chainId':4663},**credentials))
        self.assertEqual(self.count('issuance-ip',credentials['client']),before)
        self.fill('verify-global','all',VERIFY_GLOBAL_PER_MINUTE,30)
        self.refused(lambda:self.call('verify',body,**credentials))
        self.assertIsNone(self.count('verify-ip',credentials['client']))
        self.assertEqual(self.admin.execute('SELECT attempts FROM domino_sessions.challenges').fetchone()['attempts'],0)
        self.admin.execute('DELETE FROM domino_sessions.rate_limits WHERE key_hash=%s',(self.store._key('verify-global','all'),))
        self.fill('verify-ip',credentials['client'],VERIFY_IP_PER_MINUTE,30)
        self.refused(lambda:self.call('verify',body,**credentials))
        self.assertIsNone(self.count('verify-global','all'))
        self.assertEqual(self.checker.calls,[])

    def test_a_refused_refresh_names_the_seconds_until_its_next_attempt(self):
        p,b,c,r=self.login()
        for index in range(5):self.call('refresh',**c)
        self.assertTrue(0<self.refused(lambda:self.call('refresh',**c))<=2)

    def test_private_bucket_burst_five_refills_at_thirty_per_minute_across_instances(self):
        p,b,c,r=self.login()
        for index in range(5):self.call('refresh',service=self.peer if index%2 else self.service,**c)
        self.error('session_rate_limited',lambda:self.call('refresh',**c))
        self.admin.execute("UPDATE domino_sessions.private_limits SET updated_at=updated_at-interval '2 seconds'")
        self.call('refresh',**c)
        self.error('session_rate_limited',lambda:self.call('refresh',**c))
        self.assertEqual(len(self.checker.calls),7)

    def test_unknown_session_reads_do_not_allocate_quota_or_reach_rpc(self):
        for index in range(10):
            self.error('session_required',lambda:self.call('me',session='x'*42+str(index)))
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.private_limits').fetchone()['n'],0)
        self.assertEqual(self.checker.calls,[])

    def test_reload_reads_stable_csrf_and_stored_snapshot_without_any_write(self):
        p,b,c,r=self.login()
        self.admin.execute("UPDATE domino_sessions.contexts SET created_at=statement_timestamp()-interval '20 minutes',"
                           "expires_at=statement_timestamp()-interval '10 minutes'")
        tables=('contexts','challenges','sessions','rate_limits','private_limits')
        def state():
            return {table:self.admin.execute('SELECT * FROM domino_sessions.'+table).fetchall() for table in tables}
        before=state()
        self.checker.effect=lambda _: (_ for _ in ()).throw(SessionError('account_unsupported'))
        # Only the HttpOnly cookie survives a page reload. The old validation
        # stays explicitly stored; a bootstrap read is no fresh account check.
        with patch.object(self.store,'_cleanup',side_effect=AssertionError('GET must not clean')):
            for _ in range(8):
                me=self.call('me',session=c['session'])
                self.assertEqual(me['result'],r['result'])
                self.assertEqual(me['credentials'],{})
        self.assertEqual(state(),before)
        self.assertEqual(len(self.checker.calls),1)
        self.assertNotEqual(c['session'],c['csrf'])
        self.assertEqual(session_csrf(c['session']),c['csrf'])
        self.assertNotEqual(session_csrf('x'*43),c['csrf'])
        # A protected refresh must still make the fresh check and revoke.
        self.error('account_unsupported',lambda:self.call('refresh',**c))

    def test_two_tabs_refresh_concurrently_without_invalidating_each_other(self):
        p,b,c,r=self.login()
        self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '1 hour',"
                           "expires_at=statement_timestamp()+interval '11 hours',last_used_at=statement_timestamp()-interval '20 minutes'")
        old=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        restored=self.call('me',service=self.peer,session=c['session'])['result']['csrfToken']
        latest={**VALIDATION,'blockNumber':'124','blockHash':'0x'+'cd'*32}
        meeting=Meeting(latest)
        self.checker.effect=meeting.arrive
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(self.meet,meeting,'refresh',**c)
            second=pool.submit(self.meet,meeting,'refresh',service=self.peer,session=c['session'],csrf=restored)
            results=[first.result(),second.result()]
        row=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        self.assertGreater(row['last_used_at'],old['last_used_at'])
        self.assertEqual(row['expires_at'],old['expires_at'])
        self.assertEqual(row['block_number'],'124')
        for response in results:
            self.assertEqual(response['result']['csrfToken'],c['csrf'])
            self.assertEqual(response['result']['validation'],latest)
        self.assertEqual(self.call('me',session=c['session'])['result']['validation'],latest)
        self.call('logout',**c)  # Either tab's original token still works.
        self.error('session_required',lambda:self.call('me',session=c['session']))

    def test_refresh_missing_or_foreign_csrf_cannot_touch_revoke_or_spend_quota(self):
        p,b,c,r=self.login()
        before=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        self.checker.effect=lambda _: (_ for _ in ()).throw(SessionError('account_unsupported'))
        for csrf in (None,'x'*43,p['csrf']):
            self.error('csrf_invalid',lambda:self.call('refresh',session=c['session'],csrf=csrf))
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone(),before)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.private_limits').fetchone()['n'],0)
        self.assertEqual(len(self.checker.calls),1)

    def test_expired_and_legacy_reads_fail_without_cleanup_or_credential_replacement(self):
        p,b,c,r=self.login()
        self.admin.execute('UPDATE domino_sessions.sessions SET csrf_hash=%s',(digest('x'*43),))
        before=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        self.error('session_required',lambda:self.call('me',session=c['session']))
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone(),before)
        self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '1 hour',"
                           "expires_at=statement_timestamp()+interval '11 hours',last_used_at=statement_timestamp()-interval '31 minutes',"
                           "csrf_hash=%s",(digest(c['csrf']),))
        before=self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone()
        self.error('session_required',lambda:self.call('me',session=c['session']))
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchone(),before)

    def test_ipv6_prefix_and_ipv4_mapped_clients_cannot_reset_shared_ip_budget(self):
        for index in range(ISSUANCE_IP_PER_MINUTE):self.call('bootstrap',client=f'2001:db8:1:2::{index+1:x}')
        self.error('session_rate_limited',lambda:self.call('bootstrap',client='2001:db8:1:2::ffff'))
        for index in range(ISSUANCE_IP_PER_MINUTE):self.call('bootstrap',client='192.0.2.17')
        self.error('session_rate_limited',lambda:self.call('bootstrap',client='::ffff:192.0.2.17'))

    def test_capacities_do_not_evict_active_state_cleanup_is_bounded(self):
        with patch.dict(CAPACITIES,{'contexts':1}):
            initial=self.call('bootstrap')
            self.error('session_capacity_busy',lambda:self.call('bootstrap',client='192.0.2.2'))
            self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.contexts').fetchone()['n'],1)
        self.admin.execute('TRUNCATE domino_sessions.contexts')
        for index in range(250):
            self.admin.execute("INSERT INTO domino_sessions.contexts VALUES (%s,%s,statement_timestamp()-interval '20 minutes',"
                               "statement_timestamp()-interval '10 minutes',NULL,NULL)",(digest(str(index)),digest('csrf')))
        self.call('bootstrap',client='192.0.2.3')
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.contexts').fetchone()['n'],251-CLEANUP_BATCH)

    def test_postgres_roles_are_isolated_and_db_failure_is_fixed(self):
        for role in ('domino_catalogue_reader','domino_catalogue_writer'):
            with psycopg.connect(**self.settings,user=role,autocommit=True) as conn:
                for statement in ('SELECT * FROM domino_sessions.sessions','DELETE FROM domino_sessions.contexts'):
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute(statement)
        with psycopg.connect(**self.settings,user='domino_session_auth',autocommit=True) as conn:
            for statement in ('SELECT * FROM domino_catalogue.events','CREATE TABLE domino_sessions.evil(n int)',
                              'SET ROLE domino_catalogue_writer','TRUNCATE domino_sessions.sessions'):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute(statement)
        def failure(**kwargs):raise psycopg.OperationalError('secret database configuration')
        unavailable=SessionService(SessionStore(self.settings,abuse_secret=SECRET,connect=failure),self.service.siwe,self.checker)
        self.error('session_store_unavailable',lambda:self.call('bootstrap',service=unavailable))

    def test_expiry_crossed_during_final_insert_rolls_back_consume_and_session(self):
        p,b=self.pending()
        challenge=self.store.reserve_verify(p['client'],p['preauth'],p['csrf'],b['challengeId'],b['message'])
        original=_DeadlineConnection.execute
        inserted=[]
        def slow(conn,statement,params=None):
            if statement.startswith('SELECT * FROM challenges WHERE id='):
                # Arm expiry inside the transaction, AFTER cleanup.
                # Connection or CI scheduling delays cannot delete the fixture
                # before the exact mutation/rollback path we intend to exercise.
                original(conn,"UPDATE challenges SET expires_at=statement_timestamp()+interval '100 milliseconds' WHERE id=%s",(b['challengeId'],))
            result=original(conn,statement,params)
            if statement.startswith('INSERT INTO sessions('):
                inserted.append(True)
                time.sleep(.15)
            return result
        with patch.object(_DeadlineConnection,'execute',slow):
            self.error('challenge_invalid',lambda:self.store.finish_verify(p['preauth'],p['csrf'],challenge,VALIDATION))
        self.assertEqual(inserted,[True])
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_sessions.sessions').fetchone()['n'],0)
        self.assertIsNone(self.admin.execute('SELECT consumed_at FROM domino_sessions.challenges WHERE id=%s',(b['challengeId'],)).fetchone()['consumed_at'])

    def test_idle_expiry_crossed_during_refresh_rolls_back_touch(self):
        p,b,c,r=self.login()
        original=_DeadlineConnection.execute
        touched=[]
        def slow(conn,statement,params=None):
            if statement.startswith('SELECT * FROM sessions WHERE bearer_hash='):
                # Keep setup latency outside the 100ms expiry window.
                # The final guard must roll back both this test-only arming
                # update and the snapshot/idle touch; the original row must still exist.
                original(conn,"UPDATE sessions SET created_at=statement_timestamp()-interval '1 hour',"
                         "expires_at=statement_timestamp()+interval '11 hours',"
                         "last_used_at=statement_timestamp()-interval '30 minutes'+interval '100 milliseconds' "
                         "WHERE bearer_hash=%s",(digest(c['session']),))
            result=original(conn,statement,params)
            if statement.startswith('UPDATE sessions SET last_used_at='):
                touched.append(True)
                time.sleep(.15)
            return result
        with patch.object(_DeadlineConnection,'execute',slow):
            self.error('session_required',lambda:self.store.finish_private(c['session'],c['csrf'],VALIDATION))
        self.assertEqual(touched,[True])
        self.assertEqual(bytes(self.admin.execute('SELECT csrf_hash FROM domino_sessions.sessions').fetchone()['csrf_hash']),digest(c['csrf']))

    def test_deadline_after_reservation_prevents_provider_work(self):
        p,b=self.pending()
        clock=[0.0]
        original=self.store.reserve_verify
        def reserve(*args):
            result=original(*args);clock[0]=2;return result
        from discovery import DataError
        with patch.object(self.store,'reserve_verify',reserve),self.assertRaises(DataError):
            with read_deadline(1,clock=lambda:clock[0]):
                self.error('request_timeout',lambda:self.call('verify',b,**p))
        self.assertEqual(self.checker.calls,[])


class RateLimitBoundTests(unittest.TestCase):
    def test_every_rate_limit_fits_the_counter_check(self):
        # A limit past rate_limits.count's CHECK turns the call that would count past it into
        # session_store_unavailable, for every caller sharing that row, instead of session_rate_limited.
        import session_store
        migration = (Path(__file__).resolve().parents[1] / 'migrations' / '008_wallet_sessions.sql').read_text()
        self.assertIn('count integer NOT NULL CHECK (count BETWEEN 1 AND %d)' % session_store.RATE_COUNT_MAX, migration)
        limits = {name: getattr(session_store, name) for name in (
            'ISSUANCE_IP_PER_MINUTE', 'ISSUANCE_GLOBAL_PER_MINUTE', 'VERIFY_IP_PER_MINUTE', 'VERIFY_GLOBAL_PER_MINUTE',
            'PROVEN_WALLET_PER_HOUR', 'PREVIEW_IP_LIMIT', 'PREVIEW_ACCOUNT_LIMIT', 'PREVIEW_GLOBAL_LIMIT')}
        for name, limit in limits.items():
            self.assertTrue(1 <= limit <= session_store.RATE_COUNT_MAX, name)
