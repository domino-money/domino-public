"""Public release staging and rollback stay inside their named file boundaries."""
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import continuous_egress_policy as egress
import install_public_data as installer

REPO=Path(__file__).resolve().parents[3]
COMMIT='a'*40


class PublicInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='public-install-')
        self.root=Path(self.temp.name)
        self.addCleanup(self.cleanup)
        self.base=self.root/'public-data';self.queue=self.root/'queue-worker';self.systemd=self.root/'systemd'
        (self.queue/'release/backend/runtime').mkdir(parents=True,mode=0o700)
        (self.queue/'venv/bin').mkdir(parents=True)
        (self.queue/'venv/bin/python').write_bytes(b'interpreter')
        (self.queue/'release/backend/requirements-api.lock').write_bytes(b'unchanged')
        self.systemd.mkdir()
        self.files={'backend/requirements-api.lock':(b'unchanged',False)}
        for name in ('manage_public_data.py','public_history.py','public_observations.py','manage_activity.py',
                     'manage_featured.py'):
            self.files['backend/'+name]=(b'pass\n',False)
        for name in installer.UNITS:self.files['ops/systemd/'+name]=((REPO/'ops/systemd'/name).read_bytes(),False)
        for item in (patch.object(installer,'BASE',self.base),patch.object(installer,'QUEUE',self.queue),
                     patch.object(installer,'SYSTEMD',self.systemd),
                     patch.object(installer.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=os.getuid())),
                     patch.object(installer.filesystem,'protected_parents',lambda path:None),
                     patch.object(installer.os,'geteuid',return_value=0),
                     patch.object(installer.install,'run',side_effect=AssertionError('no process/service calls'))):
            item.start();self.addCleanup(item.stop)

    def cleanup(self):
        for directory,dirs,files in os.walk(self.root,followlinks=False):
            os.chmod(directory,0o755)
        self.temp.cleanup()

    def plan(self):return installer.plan(self.files,COMMIT,'b'*64)

    def test_plan_reuses_private_runtime_without_reading_it(self):
        planned=self.plan()
        self.assertEqual(planned['runtime'],str(self.queue/'release/backend/runtime'))
        self.assertEqual(planned['previousCurrent'],None)
        self.assertEqual(len(planned['units']),11)
        for name,value in planned['units'].items():
            self.assertNotIn('@PUBLIC_ROOT@',value)
            self.assertNotIn('@QUEUE_ROOT@',value)
        for name in ('current','history','accounting'):
            unit=planned['units'][f'domino-public-{name}.service']
            self.assertIn(f'--lane {name}',unit)
            for field in ('User=domino-write','ProtectSystem=strict','BindsTo=domino-continuous-egress.service'):
                self.assertIn(field,unit)

    def test_the_featured_selection_is_installed_but_not_started(self):
        unit=self.plan()['units']['domino-featured.service']
        for field in ('User=domino-write','SupplementaryGroups=domino-db','ProtectSystem=strict',
                      'BindsTo=domino-continuous-egress.service','PartOf=domino-public-data.target',
                      'manage_featured.py serve','WantedBy=domino-public-data.target'):
            self.assertIn(field,unit)
        target=self.plan()['units']['domino-public-data.target']
        self.assertNotIn('domino-featured',target)

    def test_the_domino_pool_follower_runs_every_minute_under_the_public_data_target(self):
        units=self.plan()['units']
        service=units['domino-activity-follow.service']
        for field in ('Type=oneshot','User=domino-write','SupplementaryGroups=domino-db','ProtectSystem=strict',
                      'BindsTo=domino-continuous-egress.service','PartOf=domino-public-data.target',
                      'manage_activity.py --follow --domino-positions --quiet','--max-seconds 35',
                      'TimeoutStartSec=90',f'WorkingDirectory={self.base}/current/backend',
                      f'ExecStart={self.queue}/venv/bin/python -B manage_activity.py'):
            self.assertIn(field,service)
        timer=units['domino-activity-follow.timer']
        self.assertEqual([line for line in timer.splitlines() if line.startswith(('On','Unit='))],
                         ['OnCalendar=minutely','Unit=domino-activity-follow.service'])
        self.assertIn('PartOf=domino-public-data.target',timer)
        wants=[line for line in units['domino-public-data.target'].splitlines() if line.startswith('Wants=')]
        self.assertEqual(wants,['Wants=domino-queue-worker.timer domino-catalogue-follower.timer '
                                'domino-activity-follow.timer'])

    def test_a_hand_installed_follower_is_replaced_and_restored_by_rollback(self):
        # 2 Oct 2026: the follower ran from hand-installed units before this release carried them.
        manual={name:f'hand-installed {name}\n'.encode() for name in
                ('domino-activity-follow.service','domino-activity-follow.timer')}
        for name,value in manual.items():(self.systemd/name).write_bytes(value)
        planned=self.plan()
        installer.apply(self.files,planned)
        for name in manual:self.assertEqual((self.systemd/name).read_text(),planned['units'][name])
        installer.rollback(COMMIT)
        for name,value in manual.items():self.assertEqual((self.systemd/name).read_bytes(),value)

    def test_apply_preserves_rollback_and_only_repoints_named_files(self):
        old=self.systemd/'domino-queue-worker.service.d/90-public-data.conf'
        old.parent.mkdir();old.write_bytes(b'old queue drop-in\n')
        unrelated=self.systemd/'domino-execution.service';unrelated.write_bytes(b'financial untouched')
        result=installer.apply(self.files,self.plan())
        self.assertFalse(result['activated'])
        release=self.base/'releases'/COMMIT
        self.assertEqual((self.base/'current').resolve(),release.resolve())
        self.assertEqual(os.readlink(release/'backend/runtime'),str(self.queue/'release/backend/runtime'))
        self.assertEqual(os.readlink(release/'backend/.venv'),str(self.queue/'venv'))
        self.assertEqual((release/'backend/public_history.py').stat().st_mode&0o222,0)
        self.assertEqual((release/'backend').stat().st_mode&0o222,0)
        rolled=installer.rollback(COMMIT)
        self.assertFalse(rolled['activated']);self.assertFalse((self.base/'current').is_symlink())
        self.assertEqual(old.read_bytes(),b'old queue drop-in\n')
        self.assertEqual(unrelated.read_bytes(),b'financial untouched')
        self.assertTrue(release.is_dir())
        self.assertFalse((self.systemd/'domino-public-history.service').exists())

    def test_dependency_or_runtime_permission_change_is_refused(self):
        lock=self.queue/'release/backend/requirements-api.lock';lock.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'dependency_change_needs_a_venv'):self.plan()
        lock.write_bytes(b'unchanged')
        os.chmod(self.queue/'release/backend/runtime',0o755)
        with self.assertRaisesRegex(ValueError,'writer_runtime_not_private'):self.plan()

    def test_every_writer_service_reads_the_hosts_file_the_egress_renderer_pins(self):
        # The writer resolved rpc.domino.money through the stub, and a second
        # Cloudflare pair outside its egress set hung its calls for minutes (#315).
        bind=f'BindReadOnlyPaths={egress.ROOT}/write.hosts:/etc/hosts\n'
        units=self.plan()['units']
        services=[name for name in units if name.endswith(('.service','.service.d/90-public-data.conf'))]
        self.assertEqual(len(services),7)
        for name in services:
            with self.subTest(unit=name):
                self.assertEqual(units[name].count(bind),1)
                self.assertNotIn('BindPaths=',units[name])
        for name in set(units)-set(services):
            self.assertNotIn('BindReadOnlyPaths',units[name])

    def test_current_cannot_be_an_arbitrary_directory_or_external_link(self):
        self.base.mkdir();(self.base/'current').mkdir()
        with self.assertRaisesRegex(ValueError,'current_not_a_symlink'):self.plan()
        (self.base/'current').rmdir();(self.base/'current').symlink_to(self.queue)
        with self.assertRaisesRegex(ValueError,'current_target_invalid'):self.plan()

    def test_rollback_refuses_after_a_different_release_was_selected(self):
        installer.apply(self.files,self.plan())
        other=self.base/'releases'/('c'*40);other.mkdir()
        installer.repoint(str(other))
        with self.assertRaisesRegex(ValueError,'rollback_is_not_current'):installer.rollback(COMMIT)

    def test_queue_cadence_and_wall_rpc_budgets_are_explicit(self):
        units=self.plan()['units']
        queue=units['domino-queue-worker.service.d/90-public-data.conf']
        for setting in ('--max-pools 64','--max-steps 1','--max-seconds 50','--max-rpc-calls 2048','--max-header-calls 1000'):
            self.assertIn(setting,queue)
        self.assertIn('TimeoutStartSec=65',queue)
        for timer in ('domino-queue-worker','domino-catalogue-follower'):
            with self.subTest(timer=timer):
                # A calendar trigger after the one reset: it always has a next elapse
                # (test_financial_release_systemd.py loads it into systemd itself).
                lines=[line for line in units[timer+'.timer.d/90-public-data.conf'].splitlines()
                       if line.startswith('On')]
                self.assertEqual(lines,['OnBootSec=','OnCalendar=minutely'])


if __name__=='__main__':unittest.main()
