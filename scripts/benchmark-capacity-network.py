#!/usr/bin/env python3
"""Bounded private SSH transfer of generated zeros, not an ISP saturation test.

One 32 MiB transfer, paced at no more than 8 MiB/s on the remote host. No files
or secrets are read or transferred. Records whether IPv4 egress differs, never
the IP addresses. A different egress supports a WAN-path measurement; the SSH
overlay, client and pacing still bound it. No proof of public Cloudflare capacity.
"""
import argparse
from datetime import datetime, timezone
import ipaddress
import json
from pathlib import Path
import selectors
import shlex
import subprocess
import time
import urllib.request


def checked_ipv4(value):
    try:
        return str(ipaddress.IPv4Address(value.strip()))
    except (ValueError, AttributeError):
        return None


def public_ip():
    try:
        with urllib.request.urlopen('https://api.ipify.org',timeout=4) as response:
            return checked_ipv4(response.read(128).decode())
    except Exception:
        return None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host',default='domino-host')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.host.startswith('-'):
        parser.error('invalid SSH alias')
    local_ip=public_ip()
    preflight='import urllib.request; print(urllib.request.urlopen("https://api.ipify.org",timeout=4).read(128).decode().strip())'
    # A reused master keeps its negotiated compression. Require a fresh
    # connection so zero-filled payloads cannot become a compression benchmark.
    ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','Compression=no',
         '-o','ControlMaster=no','-o','ControlPath=none',args.host]
    try:
        remote_ip=checked_ipv4(subprocess.check_output(
            ssh+['python3 -c '+shlex.quote(preflight)],text=True,timeout=15,
            stderr=subprocess.DEVNULL))
    except Exception:
        remote_ip=None
    size,pace=32*1024*1024,8*1024*1024
    sender='''import os,time
size=32*1024*1024
pace=8*1024*1024
sent=0
next_send=time.monotonic()
chunk=b'\\0'*65536
while sent<size:
    delay=next_send-time.monotonic()
    if delay>0:time.sleep(delay)
    written=os.write(1,chunk[:min(len(chunk),size-sent)])
    if written<=0:raise RuntimeError('transfer_write_failed')
    sent+=written
    # Do not accumulate pacing credit while SSH/network writes are stalled.
    next_send=time.monotonic()+written/pace
'''
    start=time.monotonic()
    process=subprocess.Popen(ssh+['python3 -c '+shlex.quote(sender)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
    count=0;first=None;timeout=False
    try:
        while True:
            remaining=30-(time.monotonic()-start)
            if remaining<=0:
                timeout=True;break
            if not selector.select(min(1,remaining)):
                continue
            data=process.stdout.read1(65536)
            if not data:break
            if first is None:first=time.monotonic()
            count+=len(data)
    finally:
        selector.close()
        if timeout:process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            timeout=True
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
    elapsed=time.monotonic()-start
    result={'at':datetime.now(timezone.utc).isoformat(),'scope':__doc__,
            'differentPublicEgress':local_ip!=remote_ip if local_ip and remote_ip else None,
            'plannedBytes':size,'receivedBytes':count,'senderPaceMiBPerSecond':8,
            'elapsedSecondsIncludingSshSetup':round(elapsed,3),
            'firstByteSeconds':round(first-start,3) if first else None,
            'observedMbitPerSecondIncludingSshSetup':round(count*8/elapsed/1000000,3),
            'complete':count==size and process.returncode==0 and not timeout,
            'timedOut':timeout}
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':main()
