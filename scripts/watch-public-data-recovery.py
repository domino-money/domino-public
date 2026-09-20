#!/usr/bin/env python3
"""One bounded recovery qualification, without AI calls or saved credentials.

Observe only. Never restart hosts/VMs/services or alter configuration. Once the
known tailnet peer and expected reader release return, perform the already
installed bounded loopback qualification exactly once and record its outcome.
"""
import argparse
import datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import time


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write(path, value):
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,indent=2)+'\n')
    temporary.replace(path)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit',required=True)
    parser.add_argument('--minutes',type=int,default=120)
    args=parser.parse_args()
    if not re.fullmatch('[0-9a-f]{40}',args.commit) or not 1<=args.minutes<=240:
        parser.error('exact commit and 1–240 minute bound required')
    tailscale=shutil.which('tailscale')
    if not tailscale:parser.error('tailscale CLI unavailable')
    root=Path(__file__).resolve().parents[1]
    reports=root/'reports'
    status=reports/'public-data-recovery-status.json'
    output=reports/'public-data-vm-final-2026-09-20.jsonl'
    start=now()
    deadline=time.monotonic()+args.minutes*60
    ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=30','-o',
         'ProxyCommand=ssh -o BatchMode=yes -o ConnectTimeout=20 -W %h:%p domino-host','domino-alpha']
    state={'startedAt':start,'commit':args.commit,'limitMinutes':args.minutes,
           'state':'waiting_for_host','aiCalls':0,'mutations':'none except ordinary public read demand'}
    write(status,state)
    while time.monotonic()<deadline:
        try:
            peer=subprocess.run([tailscale,'status','--json'],capture_output=True,text=True,timeout=10)
            data=json.loads(peer.stdout)
            online=any(value.get('HostName')=='clawber' and value.get('Online')
                       for value in data.get('Peer',{}).values())
            if online:
                expected='/opt/domino/releases/'+args.commit+'/read'
                check=subprocess.run(ssh+['systemctl show domino-read.service -p WorkingDirectory --value'],
                                     capture_output=True,text=True,timeout=40)
                if check.returncode==0 and check.stdout.strip()!=expected:
                    write(status,{**state,'state':'release_changed','finishedAt':now()})
                    return 2
                if check.returncode==0:
                    health=subprocess.run(ssh+['systemctl is-active domino-read.service domino-gateway.service '
                        'domino-public-current.service domino-public-history.service domino-public-accounting.service'],
                        capture_output=True,text=True,timeout=40)
                    if health.returncode==0:
                        state={**state,'state':'qualifying','hostReturnedAt':now()}
                        write(status,state)
                        command='sudo -u postgres /opt/domino/queue-worker/venv/bin/python '
                        command+='/opt/domino/public-data/qualify-20260920.py '+args.commit
                        command+=' 0x80baa4b3bfac6f4978700df824b1b3d98e889136'
                        with output.open('w') as stream:
                            run=subprocess.run(ssh+[command],stdout=stream,stderr=subprocess.DEVNULL,timeout=150)
                        rows=[json.loads(line) for line in output.read_text().splitlines()]
                        samples=[row for row in rows if row.get('event')=='sample']
                        valid=(run.returncode==0 and len(samples)==9 and rows[-1].get('event')=='complete'
                               and all(row.get(key,{}).get('status')==200
                                       for row in samples for key in ('overview','genericToken','history')))
                        result={**state,'state':'qualified' if valid else 'qualification_failed',
                                'finishedAt':now(),'sampleCount':len(samples),'report':output.name,
                                'scope':'loopback contract-valid reads; no public latency or complete-history claim'}
                        if valid:
                            result['maxChainAgeSeconds']=max(age for row in samples for age in row['chainAgesSeconds'])
                            result['genericPools']=samples[-1]['genericToken']['pools']
                            result['historyCoverage']=samples[-1]['historyCoverage']
                        write(status,result)
                        return 0 if valid else 1
        except (subprocess.TimeoutExpired,ValueError,OSError):
            if state['state']=='qualifying':
                write(status,{**state,'state':'qualification_failed','finishedAt':now(),
                              'reason':'bounded qualification did not complete'})
                return 1
        time.sleep(min(60,max(0,deadline-time.monotonic())))
    write(status,{**state,'state':'timed_out','finishedAt':now(),
                  'reason':'host or expected services did not become reachable within the bounded window'})
    return 1


if __name__=='__main__':
    raise SystemExit(main())
