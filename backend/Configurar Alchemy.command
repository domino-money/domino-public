#!/bin/zsh
cd -- "${0:A:h}" || exit 1
./.venv/bin/python configure_inventory.py
read -r '?Press Enter to close.'
