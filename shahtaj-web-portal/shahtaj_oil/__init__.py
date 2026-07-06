# -*- coding: utf-8 -*-
"""Shahtaj Oil unified package — loads models, wizards, and controllers."""
from .hooks import post_init_hook  # noqa: F401 — referenced by __manifest__.py
from . import controllers
from . import models
from . import wizard