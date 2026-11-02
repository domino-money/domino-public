"""Fixed guest sizes and aggregate admission limits shared by host CI tools.

The broker reserves these resources before launching a controller. Keeping this
module free of host operations also lets policy and controller tests import it.
"""

MAX_SLOTS = 8
RESOURCE_PROFILES = {
    'legacy': {'vcpus': 4, 'memory_mib': 16384},
    'light': {'vcpus': 1, 'memory_mib': 3072},
    'standard': {'vcpus': 2, 'memory_mib': 6144},
    'browser': {'vcpus': 2, 'memory_mib': 8192},
    'heavy': {'vcpus': 3, 'memory_mib': 12288},
}
BUDGET_VCPUS = 14
BUDGET_MEMORY_MIB = 57344
MAX_HEAVY = 2
