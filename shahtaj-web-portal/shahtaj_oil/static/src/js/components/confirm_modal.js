/** @odoo-module **/
import { Component } from "@odoo/owl";

export class ConfirmModal extends Component {
    static template = "shahtaj_oil.ConfirmModal";
    static props = {
        title: { type: String, optional: true },
        message: { type: String },
        onConfirm: { type: Function },
        onCancel: { type: Function }
    };
}
