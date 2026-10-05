#!/usr/bin/env python3
"""Stage public collectors and root-owned unit files. Never start any service.

Migrations, provider configuration and activation remain separate operator
steps. The existing queue worker's interpreter and private runtime are reused;
their contents are never copied or returned. A receipt preserves every managed
unit file and the previous current symlink for a bounded file-only rollback.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import prepare_disabled as install
from install_read_release import read_installed

require=install.require
BASE=Path('/opt/domino/public-data')
QUEUE=Path('/opt/domino/queue-worker')
SYSTEMD=Path('/etc/systemd/system')
UNITS=tuple(f'domino-public-{lane}.service' for lane in ('current','history','accounting'))+(
    'domino-public-data.target',
    # Installed, never enabled here: the featured-pools shadow starts only on `systemctl enable`.
    'domino-featured.service',
    # Pool activity for every pool holding a Domino position; the target wants its timer.
    'domino-activity-follow.service',
    'domino-activity-follow.timer',
    # The V2 index (read-v6), one instance per chain profile. Installed, never enabled here: an
    # instance starts only on `systemctl enable --now`, after 052 and its registration.
    'domino-v2-indexer@.service',
    'domino-queue-worker.service.d/90-public-data.conf',
    'domino-catalogue-follower.service.d/90-public-data.conf',
    'domino-queue-worker.timer.d/90-public-data.conf',
    'domino-catalogue-follower.timer.d/90-public-data.conf')


def sha(value):return hashlib.sha256(value).hexdigest()


def previous_current():
    current=BASE/'current'
    if not current.exists() and not current.is_symlink():return None
    require(current.is_symlink(),'current_not_a_symlink')
    target=Path(os.readlink(current))
    require(target.is_absolute() and target.parent==BASE/'releases' and
            re.fullmatch('[0-9a-f]{40}',target.name) and target.is_dir(),'current_target_invalid')
    return str(target)


def plan(files,commit,digest):
    require(re.fullmatch('[0-9a-f]{40}',commit) is not None,'invalid_commit')
    require(re.fullmatch('[0-9a-f]{64}',digest) is not None,'invalid_archive_digest')
    runtime=QUEUE/'release/backend/runtime'
    uid=pwd.getpwnam('domino-write').pw_uid
    info=runtime.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid==uid and not info.st_mode&0o077,
            'writer_runtime_not_private')
    require((QUEUE/'venv/bin/python').exists(),'writer_interpreter_missing')
    require(sha(read_installed(QUEUE/'release/backend/requirements-api.lock'))==
            sha(files['backend/requirements-api.lock'][0]),'dependency_change_needs_a_venv')
    for name in ('manage_public_data.py','public_history.py','public_observations.py','manage_activity.py',
                 'manage_featured.py'):
        require('backend/'+name in files,'public_source_missing')
    units={}
    for name in UNITS:
        path='ops/systemd/'+name
        require(path in files,'public_unit_template_missing')
        value=files[path][0].decode().replace('@PUBLIC_ROOT@',str(BASE)).replace('@QUEUE_ROOT@',str(QUEUE))
        require('@PUBLIC_ROOT@' not in value and '@QUEUE_ROOT@' not in value,'unresolved_unit_path')
        units[name]=value
    previous=previous_current()
    require(previous!=str(BASE/'releases'/commit),'release_already_current')
    return {'schemaVersion':1,'mode':'public-data-install','commit':commit,'archiveSha256':digest,
        'target':str(BASE/'releases'/commit),'previousCurrent':previous,
        'runtime':str(runtime),'venv':str(QUEUE/'venv'),'units':units,
        'notPerformed':['service start/enable/restart/reload','database writes/migrations',
                        'provider/secret reads or changes','dependency install','financial activation']}


def protected_mkdir(path,*,mode=0o755):
    if not path.exists():
        filesystem.protected_parents(path.parent)
        path.mkdir(mode=mode)
    filesystem.protected_parents(path)


def atomic_file(path,payload,*,mode=0o444):
    filesystem.protected_parents(path.parent)
    if path.exists() or path.is_symlink():
        filesystem.protected_parents(path)
        require(path.is_file(),'unit_not_regular')
    temp=path.with_name('.'+path.name+'.'+uuid.uuid4().hex)
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        with os.fdopen(fd,'wb') as stream:
            os.fchmod(stream.fileno(),mode)  # exactly this mode, whatever the installer's umask
            stream.write(payload);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,path)
    finally:
        if temp.exists():temp.unlink()


def repoint(target):
    filesystem.protected_parents(BASE)
    current=BASE/'current'
    require(not current.exists() or current.is_symlink(),'current_not_a_symlink')
    if target is None:
        if current.is_symlink():current.unlink()
        return
    temp=BASE/('.current-'+uuid.uuid4().hex)
    temp.symlink_to(target)
    try:os.replace(temp,current)
    finally:
        if temp.is_symlink():temp.unlink()


def apply(files,planned):
    require(os.geteuid()==0,'root_required')
    filesystem.protected_parents(QUEUE)
    filesystem.protected_parents(QUEUE/'venv')
    filesystem.protected_parents(QUEUE/'release/backend')
    filesystem.protected_parents(SYSTEMD)
    protected_mkdir(BASE);protected_mkdir(BASE/'releases');protected_mkdir(BASE/'receipts',mode=0o700)
    require(previous_current()==planned['previousCurrent'],'current_changed_since_plan')
    root=Path(planned['target'])
    require(not root.exists() and not root.is_symlink(),'release_directory_exists')
    receipt=BASE/'receipts'/(planned['commit']+'.json')
    require(not receipt.exists() and not receipt.is_symlink(),'receipt_exists')
    backups={}
    for name in UNITS:
        path=SYSTEMD/name
        protected_mkdir(path.parent)
        if path.exists() or path.is_symlink():
            filesystem.protected_parents(path)
            backups[name]=base64.b64encode(read_installed(path,65536)).decode()
        else:backups[name]=None
    atomic_file(receipt,json.dumps({**planned,'previousUnits':backups},indent=2).encode(),mode=0o600)
    root.mkdir(mode=0o755)
    for name,(payload,executable) in sorted(files.items()):
        path=root/name
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
        mode=0o555 if executable else 0o444
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
        with os.fdopen(fd,'wb') as stream:os.fchmod(stream.fileno(),mode);stream.write(payload)
    for name,target in (('runtime',planned['runtime']),('.venv',planned['venv'])):
        (root/'backend'/name).symlink_to(target)
    # Runtime and venv links are the only non-archive entries. Never descend into
    # them while making the copied code immutable to every service identity.
    for directory,dirs,_ in os.walk(root,followlinks=False):
        os.chmod(directory,0o555)
    for name,value in planned['units'].items():atomic_file(SYSTEMD/name,value.encode())
    repoint(str(root))
    return {'ok':True,'mode':planned['mode'],'commit':planned['commit'],'target':str(root),
            'receipt':str(receipt),'installed':True,'activated':False,
            'activation':'apply DB migrations/config separately; daemon-reload and start domino-public-data.target',
            'rollback':'install_public_data.py --rollback '+planned['commit']+' (files only; reload/restart separately)'}


def rollback(commit):
    require(os.geteuid()==0,'root_required')
    require(re.fullmatch('[0-9a-f]{40}',commit) is not None,'invalid_commit')
    receipt=BASE/'receipts'/(commit+'.json')
    filesystem.protected_parents(receipt)
    saved=json.loads(read_installed(receipt,1024*1024))
    require(saved['commit']==commit and set(saved['previousUnits'])==set(UNITS),'invalid_receipt')
    require(previous_current()==str(BASE/'releases'/commit),'rollback_is_not_current')
    previous=saved['previousCurrent']
    require(previous is None or (Path(previous).parent==BASE/'releases' and Path(previous).is_dir()),'previous_release_missing')
    for name,value in saved['previousUnits'].items():
        path=SYSTEMD/name
        filesystem.protected_parents(path.parent)
        if value is None:
            if path.exists():
                filesystem.protected_parents(path);path.unlink()
        else:atomic_file(path,base64.b64decode(value,validate=True))
    repoint(previous)
    return {'ok':True,'mode':'public-data-rollback','commit':commit,'current':previous,
            'activated':False,'releaseRetained':True,'action':'daemon-reload and restart previous units separately'}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',type=Path);parser.add_argument('--archive-sha256');parser.add_argument('--commit')
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect',action='store_true');mode.add_argument('--apply',action='store_true')
    mode.add_argument('--rollback',metavar='COMMIT')
    args=parser.parse_args(argv)
    try:
        if args.rollback:result=rollback(args.rollback)
        else:
            require(args.archive and args.archive_sha256 and args.commit,'archive_arguments_required')
            files=install.archive_files(args.archive,args.archive_sha256,args.commit)
            planned=plan(files,args.commit,args.archive_sha256)
            result=apply(files,planned) if args.apply else {**planned,'ok':True,'installed':False}
        print(json.dumps(result,indent=2));return 0
    except Exception as error:
        print(json.dumps({'ok':False,'reason':str(error) if isinstance(error,ValueError) else type(error).__name__,
                          'action':'no service action performed; inspect receipt if installation began'}));return 1


if __name__=='__main__':raise SystemExit(main())
