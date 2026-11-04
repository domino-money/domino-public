"""Explicit private status configuration; no key, signer or executor imports."""
import os
from pathlib import Path
import re
import stat

from bridge_state import strict_json


def private_directory(path):
    """Held descriptor walk rejects symlinks and mutable foreign ancestors."""
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts:raise ValueError()
    for parent in (path,*path.parents):
        if (parent/'AGENTS.md').is_file() and (parent/'backend/read_service.py').is_file():
            raise ValueError()
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for name in path.parts[1:]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
            info=os.fstat(fd)
            sticky=info.st_uid==0 and bool(info.st_mode&stat.S_ISVTX)
            if info.st_uid not in (0,os.getuid()) or info.st_mode&0o022 and not sticky:raise ValueError()
        info=os.fstat(fd)
        if info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:raise ValueError()
        return fd
    except BaseException:
        os.close(fd);raise


def private_file(path,maximum):
    target=Path(path)
    parent=private_directory(target.parent)
    try:fd=os.open(target.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    finally:os.close(parent)
    try:
        info=os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o600
                or info.st_nlink!=1 or info.st_size>maximum):raise ValueError()
        data=os.read(fd,maximum+1)
        if len(data)>maximum:raise ValueError()
        return data
    finally:os.close(fd)


def status_gateway(path):
    from bridge_identity import AccessVerifier
    from discovery import SNAPSHOT_LOOPBACK_RPC
    from execution_status import ExecutionStatusGateway, ExecutionStatusReader, ExecutionStatusService
    from onboarding_auth import OnboardingAuth
    from rpc_config import rpc_hosts
    from session_api import acquire_session_lock
    from session_chain import EoaChecker
    from bridge_identity import configured_preview_identity
    from session_siwe import SiwePolicy, configured_preview_origins
    from session_store import SessionStore
    config=strict_json(private_file(path,16384))
    keys={'schemaVersion','kind','runtimeDirectory','database','session','access'}
    if (type(config) is not dict or set(config)!=keys or type(config['schemaVersion']) is not int
            or config['schemaVersion']!=1 or config['kind']!='domino-execution-status'):raise ValueError()
    database=config['database']
    if (type(database) is not dict or set(database)!={'host','port','dbname'}
            or type(database['host']) is not str or not re.fullmatch(r'/[A-Za-z0-9_/.-]{1,200}',database['host'])
            or '..' in Path(database['host']).parts or type(database['port']) is not int
            or not 1024<=database['port']<=65535 or database['dbname']!='domino_catalogue'):raise ValueError()
    session=config['session'];access=config['access']
    # previewOrigins (4 Nov 2026, launch round P3) is optional: a list of the exact Pages preview origins this listener
    # also admits, the same the session listener's DOMINO_SESSION_PREVIEW_ORIGINS lists; absent, none, as before.
    # access.previewServiceId (review L1) is optional too: the separate preview Workers' own Access identity. A
    # malformed value of either turns the preview off and logs it (review L3); the canonical origin keeps serving.
    keys,access_keys={'origin','abuseSecretFile','rpcEndpoint','rpcAllowedHosts'},{'issuer','audience','serviceId'}
    if (type(session) is not dict or set(session) not in (keys,keys|{'previewOrigins'})
            or type(access) is not dict or set(access) not in (access_keys,access_keys|{'previewServiceId'})):
        raise ValueError()
    SiwePolicy(session['origin'])
    previews=configured_preview_origins(session.get('previewOrigins'),session['origin'],'session.previewOrigins',
                                        comma=False)
    hosts=rpc_hosts(session['rpcAllowedHosts'])
    secret=private_file(session['abuseSecretFile'],65).decode('ascii').removesuffix('\n')
    if not re.fullmatch(r'[0-9a-f]{64}',secret):raise ValueError()
    verifier=AccessVerifier(access['issuer'],access['audience'],access['serviceId'],
                            preview_service_id=configured_preview_identity(access.get('previewServiceId'),
                                                                           access['serviceId'],'access.previewServiceId'))
    store=SessionStore(database,abuse_secret=bytes.fromhex(secret))
    checker=EoaChecker((session['rpcEndpoint'],),allowed_hosts=hosts,
                            execution_status_loopback=session['rpcEndpoint']==SNAPSHOT_LOOPBACK_RPC)
    service=ExecutionStatusService(OnboardingAuth(store,checker),ExecutionStatusReader(database))
    gateway=ExecutionStatusGateway(service=service,verifier=verifier,origin=session['origin'],preview_origins=previews,
                                   enabled=True)
    fd=private_directory(config['runtimeDirectory'])
    os.close(fd)
    lock=acquire_session_lock(Path(config['runtimeDirectory']))
    return gateway,lock
