"""The one way local EVM tests and fork tools start Anvil; it leaves nothing behind.

Three things leaked. Anvil 1.7.1 moves block states that fall out of its
500-state memory window into ~/.foundry/anvil/tmp/anvil-state-* (about 0.5 GB
per test chain), and no signal removes that directory: SIGINT and SIGTERM both
end in std::process::exit, which skips its destructor. --max-persisted-states 0
keeps the newest 500 states in memory and never creates the directory; an
older historical read then fails with BlockOutOfRangeError instead of reading
disk. Measured on 25 Sep 2026 across every local EVM suite: no such error,
and the deepest historical read was 204 blocks behind the head.

node_modules/.bin/anvil is a Node wrapper that forwards a signal to the
platform binary and exits at once, so waiting on it proved nothing about the
binary, and killing it stranded the binary. start() runs the binary itself.

A chain whose owner died without stopping it kept running. The binary runs
under a supervisor, this file run as a script, whose stdin is the read end of
a pipe that only the owner holds open. stop() closes it, and so does the
owner's exit, SIGKILL included; the supervisor then sends Anvil SIGTERM, and
SIGKILL after GRACE seconds. scripts/prepare-financial-release.test.mjs runs
its Anvil under this supervisor too.
"""
import os
from pathlib import Path
import platform
import select
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
GRACE = 5
# Never write a block state to disk; see the module docstring.
STATE = ('--max-persisted-states', '0')


def binary(root=ROOT):
    """The pinned platform binary that the npm wrapper would start."""
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system())
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}.get(
        platform.machine().lower())
    if system is None or arch is None:
        raise OSError(f'no pinned Anvil binary for {platform.system()} {platform.machine()}')
    return Path(root)/'node_modules/@foundry-rs'/f'anvil-{system}-{arch}'/'bin/anvil'


def start(args, *, root=ROOT, **options):
    """Start Anvil with args and return its supervisor; pass that to stop().

    The supervisor's poll() turns non-None once Anvil has exited. cwd, env,
    stdout and stderr in options reach Anvil; output defaults to DEVNULL.
    """
    path = binary(root)
    if not path.is_file():
        raise FileNotFoundError(f'{path} is missing; install the pinned npm dependencies')
    options.setdefault('stdout', subprocess.DEVNULL)
    options.setdefault('stderr', subprocess.DEVNULL)
    return subprocess.Popen([sys.executable, '-I', __file__, str(path), *args, *STATE],
        stdin=subprocess.PIPE, start_new_session=True, **options)


def stop(process, timeout=2*GRACE):
    """Close the supervisor's pipe and wait until Anvil has exited."""
    process.stdin.close()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # The supervisor leads its own process group: itself and Anvil.
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def supervise(command):
    """Run command until stdin closes or a stop signal arrives; return its status."""
    stopping = []
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(number, lambda received, _: stopping.append(received))
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
    while child.poll() is None and not stopping:
        if select.select([sys.stdin], [], [], .2)[0] and not os.read(sys.stdin.fileno(), 1):
            break
    child.terminate()
    try:
        return child.wait(GRACE)
    except subprocess.TimeoutExpired:
        child.kill()
        return child.wait()


if __name__ == '__main__':
    sys.exit(supervise(sys.argv[1:]))
