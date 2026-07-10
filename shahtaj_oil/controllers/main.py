# -*- coding: utf-8 -*-
"""Post-login routing and custom-portal navigation guard (Odoo 19).

Only override _login_redirect and web_client with @http.route() (no path) so
/odoo routes stay registered. Never use @http.route('/web') alone.
"""
from odoo.http import request
from odoo import http

try:
    from odoo.addons.portal.controllers.web import Home as PortalHome
except ImportError:
    from odoo.addons.web.controllers.home import Home as PortalHome


class CustomHome(PortalHome):

    def _shahtaj_dashboard_action(self):
        return request.env.ref(
            'shahtaj_oil.action_shahtaj_dashboard',
            raise_if_not_found=False,
        )

    def _shahtaj_user_uses_custom_portal(self, uid):
        user = request.env(user=uid)['res.users'].browse(uid)
        return bool(user.shahtaj_custom_frontend)

    def _login_redirect(self, uid, redirect=None):
        clean_redirect = redirect.rstrip('?') if redirect else None
        if self._shahtaj_user_uses_custom_portal(uid):
            if not clean_redirect or clean_redirect in ('/web', '/odoo'):
                action = self._shahtaj_dashboard_action()
                if action:
                    redirect = '/odoo/action-%s' % action.id
        return super()._login_redirect(uid, redirect=redirect)

    @http.route()
    def web_client(self, s_action=None, **kw):
        if request.session.uid and self._shahtaj_user_uses_custom_portal(
            request.session.uid
        ):
            action = self._shahtaj_dashboard_action()
            if action:
                path = request.httprequest.path or ''
                allowed = '/odoo/action-%s' % action.id
                if path in ('/web', '/odoo', '/web/') or (
                    path.startswith('/odoo/')
                    and not path.startswith(allowed)
                ):
                    return request.redirect(allowed, code=303)
        return super().web_client(s_action=s_action, **kw)
