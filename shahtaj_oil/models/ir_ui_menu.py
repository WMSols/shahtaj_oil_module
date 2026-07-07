# -*- coding: utf-8 -*-
"""Limit the app switcher to Shahtaj only for custom-portal distributors."""
from odoo import models


class IrUiMenu(models.Model):
    _inherit = 'ir.ui.menu'

    def _shahtaj_collect_menu_tree_ids(self, web_menus, root_menu_id):
        """Return menu ids in the subtree of a root app menu."""
        root_key = str(root_menu_id)
        if root_key not in web_menus:
            return set()
        collected = {root_key}
        stack = list(web_menus[root_key].get('children') or [])
        while stack:
            menu_id = stack.pop()
            key = str(menu_id)
            if key in collected or key not in web_menus:
                continue
            collected.add(key)
            stack.extend(web_menus[key].get('children') or [])
        return collected

    def load_web_menus(self, debug):
        web_menus = super().load_web_menus(debug)
        user = self.env.user
        if not user.shahtaj_custom_frontend:
            return web_menus

        root_menu = self.env.ref(
            'shahtaj_oil.menu_shahtaj_root',
            raise_if_not_found=False,
        )
        if not root_menu:
            return web_menus

        allowed = self._shahtaj_collect_menu_tree_ids(web_menus, root_menu.id)
        allowed.add('root')

        root = web_menus.get('root')
        if root:
            root['children'] = [
                child_id for child_id in root.get('children', [])
                if str(child_id) in allowed
            ]

        return {
            menu_key: menu_data
            for menu_key, menu_data in web_menus.items()
            if str(menu_key) in allowed
        }
