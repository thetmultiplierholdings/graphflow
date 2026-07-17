# Workflow files live here: ONE FILE PER WORKFLOW VERSION.
# A new version is a copy of a file with a new name (uk_tax_workflow_v2.py);
# the filename stem IS the workflow_id. No engine logic in this package.

from __future__ import annotations

import importlib
import pkgutil


def load_all() -> None:
    """Import every workflow module so the decorators populate the registry.
    The CI publisher, the worker and the API service all call this — the
    registry must contain every version everywhere."""
    for mod in pkgutil.iter_modules(__path__):
        if not mod.name.startswith("_") and mod.name != "shared":
            importlib.import_module(f"{__name__}.{mod.name}")
