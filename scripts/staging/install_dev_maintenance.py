#!/usr/bin/env python3
"""Install the development-only maintenance package from a private staging dir."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('maintenance', args.package/'dev_read_maintenance.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.need(os.geteuid() == 0, 'root_required')
    m.need(not m.CONFIG.exists() and not m.STATE.exists(), 'maintenance_already_installed')
    files = {}
    for name in ('dev_read_maintenance.py', 'dev_read_health.py'):
        files[Path('/usr/local/lib/domino-dev-maintenance')/name] = (args.package/name).read_bytes()
    source = args.package/'dev-read-maintenance'
    for path in sorted(source.iterdir()):
        if path.name.startswith('domino-dev-') and path.suffix in ('.service', '.timer', '.target'):
            files[Path('/etc/systemd/system')/path.name] = path.read_bytes()
    for unit in m.UNITS:
        files[Path('/etc/systemd/system')/(unit+'.d')/'90-continuous.conf'] = (source/'90-continuous.conf').read_bytes()
    files[Path('/etc/systemd/system/domino-dev-egress.service.d/90-maintenance-boot.conf')] = (source/'90-egress-boot.conf').read_bytes()
    for path in files:
        m.need(not path.exists(), 'install_path_already_exists')
    before = m.production_fingerprint()
    installed = []
    with m.locked():
        try:
            m.STATE.mkdir(mode=0o700)
            m.CONFIG.parent.mkdir(mode=0o700)
            for path, data in files.items():
                path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                m.atomic(path, data, mode=0o644)
                installed.append(path)
            control = {'version': 1, 'enabled': True,
                       'authorization': 'Owner requested implementation of the preventive plan on 2026-09-20; continuous DEV operation until revoked',
                       'leaseSeconds': 604800, 'renewBeforeSeconds': 259200}
            m.atomic(m.CONFIG, m.encoded(control))
            units = [str(p) for p in files if p.suffix in ('.service', '.timer', '.target')]
            m.command('systemd-analyze', 'verify', *units)
            m.command('systemctl', 'daemon-reload')
            m.run('adopt')
            m.need(m.production_fingerprint() == before, 'production_changed_during_install')
            m.atomic(m.STATE/'installation.json', m.encoded({'installedAt': int(time.time()),
                     'packageFiles': {str(p): m.metadata(p) for p in files}, 'productionUnchanged': True}))
        except BaseException:
            for path in reversed(installed):
                path.unlink(missing_ok=True)
            m.CONFIG.unlink(missing_ok=True)
            m.command('systemctl', 'daemon-reload')
            if not any(m.STATE.iterdir()):
                m.STATE.rmdir()
            if not any(m.CONFIG.parent.iterdir()):
                m.CONFIG.parent.rmdir()
            raise
    # Release the operator lock before starting units that acquire it themselves.
    # Retire the manually started legacy target: its Requires/PartOf coupling
    # would otherwise propagate one gateway failure to the entire old group.
    m.command('systemctl', 'stop', 'domino-dev-off.target')
    m.command('systemctl', 'enable', '--now', 'domino-dev-continuous.target',
              'domino-dev-maintenance.timer', 'domino-dev-health.timer', timeout=240)
    print(json.dumps({'installed': True, 'productionUnchangedDuringInstall': True,
                      'continuousAuthorization': True, 'leaseSeconds': 604800}))


if __name__ == '__main__':
    main()
