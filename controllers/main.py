# -*- coding: utf-8 -*-
from odoo import http
from odoo.http import request
from odoo.addons.web.controllers.home import Home

class CustomHome(Home):

    def _login_redirect(self, uid, redirect=None):
        clean_redirect = redirect.rstrip('?') if redirect else None
        
        if not clean_redirect or clean_redirect in ['/web', '/odoo']:
            # Check the user doing the logging in
            user = request.env['res.users'].browse(uid)
            
            # Use the correct module prefix: shahtaj_order_booker
            if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
                action = request.env.ref('shahtaj_oil.action_shahtaj_dashboard', raise_if_not_found=False)
                if action:
                    redirect = '/web?action=%s' % action.id
                
        return super(CustomHome, self)._login_redirect(uid, redirect=redirect)

    # Changed auth="user" back to auth="none" to prevent 404s on logout
    @http.route('/web', type='http', auth="none")
    def web_client(self, s_action=None, **kw):
        
        # Only attempt to redirect if there is an active session (user is logged in)
        if request.session.uid:
            if not kw.get('action') and not kw.get('menu_id') and not s_action:
                user = request.env['res.users'].browse(request.session.uid)
                
                # Use the correct module prefix: shahtaj_order_booker
                if user.has_group('shahtaj_oil.group_shahtaj_distributor'):
                    action = request.env.ref('shahtaj_oil.action_shahtaj_dashboard', raise_if_not_found=False)
                    if action:
                        return request.redirect('/web?action=%s' % action.id)
                        
        return super(CustomHome, self).web_client(s_action=s_action, **kw)