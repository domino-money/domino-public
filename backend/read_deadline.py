"""Cooperative monotonic budgets shared by every subrequest of one read.

The context belongs to the actual worker. Timing out its caller does not cancel
blocking work or release admission; the worker must exit before its slot is free.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import math
import time


_CURRENT = ContextVar('domino_read_deadline', default=None)


class ReadDeadline:
    def __init__(self, seconds=None, *, clock=None, parents=()):
        if seconds is not None and (type(seconds) not in (int, float) or
                                    not math.isfinite(seconds) or seconds <= 0):
            raise ValueError('invalid_read_budget')
        self.clock = clock or (parents[0].clock if parents else time.monotonic)
        self.expires = self.clock() + seconds if seconds is not None else math.inf
        self.parents = parents

    def remaining(self):
        remaining = self.expires - self.clock()
        for parent in self.parents:
            remaining = min(remaining, parent.remaining())
        if remaining <= 0:
            # Avoid an import cycle: discovery also guards its RPC transport.
            from discovery import DataError
            raise DataError('read_deadline_exceeded')
        return remaining

    def timeout(self, seconds):
        return min(seconds, self.remaining())


def current_read_deadline():
    return _CURRENT.get()


def check_read_deadline():
    deadline = current_read_deadline()
    if deadline is not None:
        deadline.remaining()


def read_timeout(seconds):
    deadline = current_read_deadline()
    return seconds if deadline is None else deadline.timeout(seconds)


@contextmanager
def use_read_deadline(deadline):
    """Use a captured budget without extending an already active request."""
    current = current_read_deadline()
    if current is not None and current is not deadline and current not in deadline.parents:
        deadline = ReadDeadline(parents=(deadline, current))
    token = _CURRENT.set(deadline)
    try:
        check_read_deadline()
        try:
            yield deadline
        except Exception:
            check_read_deadline()
            raise
        else:
            check_read_deadline()
    finally:
        _CURRENT.reset(token)


@contextmanager
def read_deadline(seconds=15, *, clock=None):
    """Bound one worker's complete read; nested budgets can only shorten it."""
    if seconds is None:
        raise ValueError('invalid_read_budget')
    parent = current_read_deadline()
    deadline = ReadDeadline(seconds, clock=clock, parents=(parent,) if parent else ())
    with use_read_deadline(deadline):
        yield deadline
