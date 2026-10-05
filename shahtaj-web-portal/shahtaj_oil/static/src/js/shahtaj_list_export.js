/** @odoo-module **/

export function printFilter(label, value) {
    if (value === undefined || value === null || value === "" || value === "all" || value === false) {
        return "";
    }
    return `${label}: ${value}`;
}

export async function printListPdf(orm, action, { title, filters, columns, rows, summary }) {
    const ids = await orm.create("shahtaj.list.print", [{
        title,
        filter_text: (filters || []).filter(Boolean).join("\n"),
        summary_text: (summary || []).filter(Boolean).join("\n"),
        columns_json: JSON.stringify(columns || []),
        rows_json: JSON.stringify(rows || []),
    }]);
    const printId = Array.isArray(ids) ? ids[0] : ids;
    await action.doAction({
        type: "ir.actions.report",
        report_type: "qweb-pdf",
        report_name: "shahtaj_oil.report_shahtaj_list_print",
        report_file: "shahtaj_oil.report_shahtaj_list_print",
        context: { active_ids: [printId] },
    });
}
