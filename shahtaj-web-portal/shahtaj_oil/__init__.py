# -*- coding: utf-8 -*-
"""Shahtaj Oil unified package — loads models, wizards, controllers, and setup."""
from .hooks import post_init_hook  # noqa: F401 — referenced by __manifest__.py
from . import setup
from . import controllers
from . import models
from . import wizard