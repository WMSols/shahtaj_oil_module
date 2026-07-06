/** @odoo-module **/

import { session } from "@web/session";
import { patch } from "@web/core/utils/patch";
import { NavBar } from "@web/webclient/navbar/navbar";
import { UserMenu } from "@web/webclient/user_menu/user_menu";

function isCustomPortal() {
    return Boolean(session.shahtaj_custom_frontend);
}

patch(NavBar.prototype, {
    setup() {
        super.setup(...arguments);
        if (isCustomPortal()) {
            document.body.classList.add("o_shahtaj_custom_portal");
        }
    },

    /**
     * Only the account avatar menu. Messages, activities, company switcher,
     * and mobile burger menu are removed for custom-portal distributors.
     */
    get systrayItems() {
        const items = super.systrayItems;
        if (!isCustomPortal()) {
            return items;
        }
        return items.filter((item) => item.key === "web.user_menu");
    },
});

patch(UserMenu.prototype, {
    /**
     * Only Log out — standard route /web/session/logout → login page.
     * BurgerUserMenu extends UserMenu, so it stays safe if ever shown.
     */
    getElements() {
        const elements = super.getElements(...arguments);
        if (!isCustomPortal()) {
            return elements;
        }
        return elements.filter((element) => element.id === "logout");
    },
});
