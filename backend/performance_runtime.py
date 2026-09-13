"""Explicit private performance configuration; no implicit production fallback."""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
import time

import psycopg
from psycopg.rows import dict_row

from bridge_state import strict_json
from catalogue import database_settings
from discovery import DataError
from local_config import checked_config
from performance_collection import PerformanceRpc
from performance_models import Address, Hash, StrictModel
from performance_enrollment import EnrollmentStore
from performance_history_store import FinancialHistoryStore
from performance_store import PerformanceStore, COLLECTOR_ROLE, _Connection
from performance_producer import ProducerRpc, PerformanceProducer
from performance_rollup_store import ProjectionStore, ProjectionWorker
from performance_v2_service import StoredValuation
from pydantic import Field
from typing import Annotated, Literal
from read_deadline import check_read_deadline, read_timeout
from rpc_config import DEFAULT_RPC_HOSTS


class Subject(StrictModel):
    owner: Address
    vault: Address
    vaultCodeHash: Hash


class Profile(StrictModel):
    version: Literal[1]
    expiresAt: Annotated[int, Field(gt=0,le=2**53-1)]
    rpcConfig: str
    databaseConfig: str
    runtimeDirectory: str
    subjects: Annotated[list[Subject], Field(min_length=1,max_length=256)]
    pageBlocks: Annotated[int,Field(ge=1,le=16)] = 4
    maxRequestsPerMinute: Annotated[int,Field(ge=1,le=32768)] = 8192
    maxRequestsPerStep: Annotated[int,Field(ge=1,le=2048)] = 1024


def private_json(path, maximum=65536):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or Path(__file__).resolve().parents[1] in path.parents:
        raise ValueError('private_profile_path_required')
    directory = os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory); directory = child
            info = os.fstat(directory)
            if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                raise ValueError('unsafe_profile_directory')
        fd = os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        with os.fdopen(fd,'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1
                    or stat.S_IMODE(info.st_mode)!=0o600):
                raise ValueError('private_profile_permissions')
            raw = stream.read(maximum+1)
            if len(raw)>maximum: raise ValueError('private_profile_size')
            return strict_json(raw)
    finally: os.close(directory)


class Runtime:
    def __init__(self, profile_path):
        self.profile = Profile.model_validate(private_json(profile_path))
        self.profile_path = Path(profile_path)
        if self.profile.expiresAt <= time.time(): raise ValueError('profile_expired')
        pairs = [(subject.owner,subject.vault) for subject in self.profile.subjects]
        if len(pairs)!=len(set(pairs)) or len({owner for owner,_ in pairs})>32:
            raise ValueError('invalid_performance_subjects')
        runtime = Path(self.profile.runtimeDirectory)
        if (not runtime.is_absolute() or runtime.resolve()!=runtime or not runtime.is_dir()
                or runtime.stat().st_uid!=os.getuid() or stat.S_IMODE(runtime.stat().st_mode)!=0o700):
            raise ValueError('private_runtime_required')
        self.runtime = runtime
        self.config = checked_config(private_json(self.profile.rpcConfig,8192))
        if self.config.get('rpcFallbackUrls'):
            raise ValueError('single_budgeted_performance_rpc_required')
        # Validate the same explicit private file, then the existing database schema.
        private_json(self.profile.databaseConfig,4096)
        self.settings = database_settings(self.profile.databaseConfig)
        if self.settings is None: raise ValueError('performance_database_required')
        self.enrollments = EnrollmentStore(self.settings,role=COLLECTOR_ROLE)
        self.history = ProjectionStore(self.settings)
        self.projection_writer = ProjectionStore(self.settings,role=COLLECTOR_ROLE)
        self.valuation = StoredValuation(self.price_connection)

    def admission(self, owner, vault):
        # Expiry is authorization, not a cache TTL and never extends on restart.
        if time.time() >= self.profile.expiresAt: return None
        return next((subject.vaultCodeHash for subject in self.profile.subjects
                     if (subject.owner,subject.vault)==(owner,vault)),None)

    @contextmanager
    def price_connection(self):
        try:
            with psycopg.connect(**self.settings,user='domino_catalogue_reader',row_factory=dict_row,
                    connect_timeout=2,options='-c default_transaction_read_only=on -c statement_timeout=2000 -c lock_timeout=100') as conn:
                conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                yield _Connection(conn)
                check_read_deadline()
        except psycopg.Error:
            raise DataError('performance_price_store_unavailable') from None

    def producer(self):
        runtime = self
        class AdmittedRpc:
            def request(self, method, params):
                if time.time() >= runtime.profile.expiresAt: raise DataError('performance_profile_expired')
                # ReadRpc's counter is operation-local. The outer ProducerRpc
                # owns the persistent rolling transport budget across factories.
                return PerformanceRpc(runtime.config['rpcUrl'],max_requests=1,
                    allowed_hosts=runtime.config.get('rpcAllowedHosts',DEFAULT_RPC_HOSTS)).request(method,params)
        rpc = ProducerRpc(AdmittedRpc(),maximum=self.profile.maxRequestsPerMinute)
        return PerformanceProducer(rpc,self.enrollments,PerformanceStore(self.settings,role=COLLECTOR_ROLE),
            FinancialHistoryStore(self.settings,role=COLLECTOR_ROLE),
            sorted({subject.owner for subject in self.profile.subjects}),page_blocks=self.profile.pageBlocks,
            max_requests=self.profile.maxRequestsPerStep,
            projector=ProjectionWorker(self.projection_writer,self.valuation))
