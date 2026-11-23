/** @odoo-module **/
import { Component } from "@odoo/owl";

export class ConfirmModal extends Component {
    static template = "shahtaj_oil.ConfirmModal";
    static props = {
        title: { type: String, optional: true },
        message: { type: String },
        onConfirm: { type: Function },
        onCancel: { type: Function },
        confirmLabel: { type: String, optional: true },
        cancelLabel: { type: String, optional: true },
        confirmClass: { type: String, optional: true },
        secondaryLabel: { type: String, optional: true },
        onSecondary: {
            type: [Function, { value: null }, { value: false }, { value: undefined }],
            optional: true,
        },
    };
}
