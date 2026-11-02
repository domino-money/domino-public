#!/usr/bin/env bash
# Run on Clawber as root, from a reviewed checkout. Never changes existing VMs.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run as root on the virtualization host.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
base_dir=/mnt/narrative-ssd/domino-ci-pilot/base
for command in curl sha256sum qemu-img virt-customize virt-resize; do command -v "$command" >/dev/null; done
# Refuse a missing SSD mount rather than silently filling the system disk.
mountpoint -q /mnt/narrative-ssd
[ ! -L /mnt/narrative-ssd/domino-ci-pilot ]
install -d -o root -g root -m 0755 /mnt/narrative-ssd/domino-ci-pilot "$base_dir" "$base_dir/downloads"
[ ! -e "$base_dir/ubuntu-24.04-ci.qcow2" ] || { echo 'Base already exists; do not overwrite a runner image.' >&2; exit 1; }
[ "$(df -Pk "$base_dir" | awk 'NR==2 {print $4}')" -gt 52428800 ] || { echo 'Need at least 50 GiB free.' >&2; exit 1; }
build_dir=$(mktemp -d "$base_dir/build-XXXXXXXX")
trap 'rm -rf -- "$build_dir"' EXIT
python3 - "$source_dir/image-lock.json" "$build_dir" <<'PY'
import hashlib,json,subprocess,sys
from pathlib import Path
lock=json.loads(Path(sys.argv[1]).read_text()); dest=Path(sys.argv[2])
for name in ('ubuntu','node','runner'):
 p=dest/name
 cached=dest.parent/'downloads'/(lock[name+'_sha256']+'-'+name)
 if cached.exists() and hashlib.file_digest(cached.open('rb'),'sha256').hexdigest()==lock[name+'_sha256']:
  import shutil
  shutil.copyfile(cached,p)
  print('Verified cached '+name,flush=True)
  continue
 subprocess.run(['curl','--fail','--location','--silent','--show-error','--proto','=https','--proto-redir','=https','--retry','3','--output',str(p),lock[name+'_url']],check=True)
 h=hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
 if h!=lock[name+'_sha256']: raise SystemExit('Checksum mismatch: '+name)
 import shutil
 shutil.copyfile(p,cached);cached.chmod(0o444)
 print('Verified '+name,flush=True)
PY
qemu-img create -f qcow2 "$build_dir/image.qcow2" 16G
systemd-run --quiet --scope -p CPUQuota=200% -p MemoryMax=4G -p IOWeight=10 \
  virt-resize --expand /dev/sda1 "$build_dir/ubuntu" "$build_dir/image.qcow2"
cat > "$build_dir/configure.sh" <<'GUEST'
#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
# libguestfs 1.52 on this host leaves its SLIRP NIC down without a DHCP client.
# This fallback changes only the temporary direct-backend appliance network.
if ! ip -4 route show default | grep -q .; then
  ip link set eth0 up
  ip address replace 169.254.2.15/16 dev eth0
  ip route replace default via 169.254.2.2
fi
# The cloud image stub resolver has no running daemon in the appliance.
rm -f /etc/resolv.conf
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' > /etc/resolv.conf
# Build-time apt runs in the libguestfs appliance; jobs never receive sudo.
sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources
apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 -o APT::Update::Error-Mode=any update
apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils python3 python3-venv qemu-guest-agent cloud-init grub-pc-bin postgresql-16 postgresql-client-16 libicu74 libssl3t64 libkrb5-3 zlib1g libunwind8 liblttng-ust1t64 libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation
# PostgreSQL is task-local via backend/dev_postgres.py, never a shared service.
systemctl disable postgresql.service || true
useradd --create-home --uid 1001 --shell /bin/bash runner
passwd -l runner
# Disable image-default admin access. No login key or host agent is imported.
if id ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi
rm -f /etc/sudoers.d/90-cloud-init-users
install -d -o runner -g runner -m 0755 /opt/actions-runner /opt/hostedtoolcache
# All binaries were verified on the host before copying into this image.
tar -xJf /tmp/node --strip-components=1 -C /usr/local
tar -xzf /tmp/runner -C /opt/actions-runner
chown -R runner:runner /opt/actions-runner
rm -f /tmp/node /tmp/runner
# virt-resize can relocate the BIOS boot partition; reinstall its bootloader.
grub-install --target=i386-pc --no-floppy /dev/sda
update-grub
# OS preparation does not run contributed code or register a GitHub runner.
systemctl enable qemu-guest-agent.service || true
rm -f /etc/resolv.conf
ln -s /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
cloud-init clean --logs --machine-id
apt-get clean
rm -rf /var/lib/apt/lists/*
GUEST
# Cap image building to two CPUs and 4 GiB, below the proposed CI worker size.
systemd-run --quiet --scope -p CPUQuota=200% -p MemoryMax=4G -p IOWeight=10 \
  env LIBGUESTFS_BACKEND=direct virt-customize --network --memsize 2048 --smp 2 -a "$build_dir/image.qcow2" \
  --copy-in "$build_dir/node:/tmp" --copy-in "$build_dir/runner:/tmp" --run "$build_dir/configure.sh"
install -o root -g root -m 0444 "$build_dir/image.qcow2" "$base_dir/ubuntu-24.04-ci.qcow2"
cp -- "$source_dir/image-lock.json" "$base_dir/source-lock.json"
chmod 0444 "$base_dir/source-lock.json"
sha256sum "$base_dir/ubuntu-24.04-ci.qcow2" > "$base_dir/ubuntu-24.04-ci.qcow2.sha256"
chmod 0444 "$base_dir/ubuntu-24.04-ci.qcow2.sha256"
echo 'Prepared immutable CI base; no runner registered and no VM started.'
