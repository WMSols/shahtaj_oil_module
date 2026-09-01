# -*- coding: utf-8 -*-
"""Shahtaj Oil — Centralized One-Time Setup & Configuration Package.

All one-time checks, self-healing account creations, and permission sync routines
are consolidated in this folder for modularity, safety, and easy removal.
"""
from . import accounting_setup
from . import access_rights_setup
from . import product_setup
from . import runner
from .runner import run_all_setup_checks
