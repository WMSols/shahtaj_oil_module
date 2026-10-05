/** @odoo-module **/

import { Component, useState, onMounted, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess, notifyPortalBusy } from "../shahtaj_access";
import { printFilter, printListPdf } from "../shahtaj_list_export";
import { filterOptionValue, setFilterField } from "../shahtaj_filter_ui";

export class BankTransactions extends Component {
    static props = {
        embedded: { type: Boolean, optional: true },
        initialDirection: { type: String, optional: true },
        initialDateFrom: { type: String, optional: true },
        initialDateTo: { type: String, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this._listFetchToken = 0;
        const ITEMS_PER_PAGE = 50;
        
        this.state = useState({
            activeTab: 'transactions', 
            viewMode: 'list', 
            selectedTransaction: null,
            selectedSettlement: null,
            isLoading: { data: true, saveJournal: false },
            isPrinting: false,
            
            showJournalModal: false,
            journalForm: { id: null, name: '', type: 'bank', code: '' },
            
            // --- BACKEND PAGINATION ---
            itemsPerPage: ITEMS_PER_PAGE,
            searchTimeout: null,
            tableTransactions: [],
            tableJournals: [],
            tableSettlements: [],
            lookupJournals: [], // Used strictly for the dropdown
            lookupSettleJournals: [],
            lookupDeliveryMen: [],
            
            pagination: {
                transactions: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                journals: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                settlements: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
            },
            filters: {
                transactions: { 
                    search: '', journal: 'all', 
                    direction: this.props.initialDirection || 'all',
                    sortBy: 'date_desc',
                    dateFrom: this.props.initialDateFrom || '',
                    dateTo: this.props.initialDateTo || '', 
                },
                journals: { search: '' },
                settlements: {
                    dm: 'all',
                    journal: 'all',
                    dateFrom: this.props.initialDateFrom || '',
                    dateTo: this.props.initialDateTo || '',
                },
            },
            
            // Replaces the old frontend getter
            totals: { moneyIn: 0, moneyOut: 0, net: 0 },
            settlementTotal: 0,
        });

        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);

        onWillUpdateProps((nextProps) => {
            const direction = nextProps.initialDirection || 'all';
            const dateFrom = nextProps.initialDateFrom || '';
            const dateTo = nextProps.initialDateTo || '';
            const filters = this.state.filters.transactions;
            if (direction === filters.direction && dateFrom === filters.dateFrom && dateTo === filters.dateTo) {
                return;
            }
            filters.direction = direction;
            filters.dateFrom = dateFrom;
            filters.dateTo = dateTo;
            this.state.activeTab = 'transactions';
            this.state.viewMode = 'list';
            this.state.selectedTransaction = null;
            this.state.selectedSettlement = null;
            this.state.pagination.transactions.page = 1;
            this.fetchActiveList();
        });

        onMounted(() => {
            this._bootTransactions();
        });
    }

    async _bootTransactions() {
        if (!hasFinancialAccess()) {
            this.state.isLoading.data = false;
            return;
        }
        await Promise.all([
            this.loadLookupJournals(),
            this.loadSettlementLookups(),
            this.fetchActiveList(),
        ]);
    }

    // --- UNIVERSAL PAGINATION HANDLERS ---
    onSearchInput(ev, tabName) {
        this.state.filters[tabName].search = ev.target.value;
        this.state.pagination[tabName].page = 1; 
        this.debouncedFetchActiveList();
    }

    onFilterChange(tabName) {
        this.state.pagination[tabName].page = 1;
        this.fetchActiveList(); 
    }

    onFilterField(listKey, field, ev) {
        setFilterField(this.state, listKey, field, ev.target.value);
        this.onFilterChange(listKey);
    }

    filterOptionValue(id) {
        return filterOptionValue(id);
    }

    clearFilters(listKey) {
        const defaults = {
            transactions: {
                search: "",
                journal: "all",
                direction: "all",
                sortBy: "date_desc",
                dateFrom: "",
                dateTo: "",
            },
            journals: { search: "" },
            settlements: {
                dm: "all",
                journal: "all",
                dateFrom: "",
                dateTo: "",
            },
        };
        if (!defaults[listKey]) {
            return;
        }
        this.state.filters[listKey] = { ...defaults[listKey] };
        if (this.state.pagination[listKey]) {
            this.state.pagination[listKey].page = 1;
        }
        if (listKey === "transactions") {
            this.state.tableTransactions = [];
            this.state.totals = { moneyIn: 0, moneyOut: 0, net: 0 };
        } else if (listKey === "journals") {
            this.state.tableJournals = [];
        } else if (listKey === "settlements") {
            this.state.tableSettlements = [];
            this.state.settlementTotal = 0;
        }
        this.fetchActiveList();
    }

    changePage(tabName, direction) {
        const pag = this.state.pagination[tabName];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchActiveList();
        }
    }

    get selectedJournalLabel() {
        const journalId = this.state.filters.transactions.journal;
        if (!journalId || journalId === "all") {
            return "All Journals";
        }
        const journal = (this.state.lookupJournals || []).find(
            (row) => String(row.id) === String(journalId)
        );
        return journal ? journal.name : "Journal";
    }

    async refreshData() {
        await Promise.all([
            this.loadLookupJournals(),
            this.loadSettlementLookups(),
        ]);
        await this.fetchActiveList();
    }

    async loadLookupJournals() {
        this.state.lookupJournals = await this.orm.searchRead(
            "account.journal", [["type", "in", ["bank", "cash"]]], ["id", "name"]
        );
    }

    async loadSettlementLookups() {
        const [journals, deliveryMen] = await Promise.all([
            this.orm.searchRead(
                "account.journal",
                [["type", "in", ["bank", "cash"]], ["code", "!=", "DMCASH"]],
                ["id", "name"],
                { order: "name asc" },
            ),
            this.orm.searchRead(
                "res.users",
                [["shahtaj_is_delivery_man", "=", true], ["active", "=", true]],
                ["id", "name"],
                { order: "name asc" },
            ),
        ]);
        this.state.lookupSettleJournals = journals || [];
        this.state.lookupDeliveryMen = deliveryMen || [];
    }

    _settlementDomain(filters) {
        const domain = [];
        if (filters.dm && filters.dm !== "all") {
            domain.push(["delivery_man_id", "=", parseInt(filters.dm, 10)]);
        }
        if (filters.journal && filters.journal !== "all") {
            domain.push(["bank_journal_id", "=", parseInt(filters.journal, 10)]);
        }
        if (filters.dateFrom) {
            domain.push(["settlement_date", ">=", filters.dateFrom]);
        }
        if (filters.dateTo) {
            domain.push(["settlement_date", "<=", filters.dateTo]);
        }
        return domain;
    }

    // --- THE MASTER DATA ENGINE ---
    async fetchActiveList() {
        const fetchToken = ++this._listFetchToken;
        this.state.isLoading.data = true;
        notifyPortalBusy(true);
        try {
            const tab = this.state.activeTab;
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab];
            
           if (tab === 'transactions') {
                const pageResult = await this.orm.call(
                    "shahtaj.portal.read",
                    "shahtaj_cash_activity_page",
                    [filters, pag.page, pag.limit],
                );
                if (fetchToken !== this._listFetchToken) {
                    return;
                }
                const rows = pageResult.rows || [];
                this.state.totals = {
                    moneyIn: pageResult.moneyIn || 0,
                    moneyOut: pageResult.moneyOut || 0,
                    net: pageResult.net || 0,
                };
                this.state.pagination.transactions.total = pageResult.total || 0;
                this.state.tableTransactions = rows;
            }else if (tab === 'journals') {
                let domain = [["type", "in", ["bank", "cash"]]];
                if (filters.search) domain.push(['name', 'ilike', filters.search]);
                
                const [total, records] = await Promise.all([
                    this.orm.searchCount('account.journal', domain),
                    this.orm.searchRead('account.journal', domain, ["id", "name", "type", "code"], { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "id desc" })
                ]);
                if (fetchToken !== this._listFetchToken) {
                    return;
                }
                
                this.state.pagination.journals.total = total;
                this.state.tableJournals = records;
            } else if (tab === 'settlements') {
                const domain = this._settlementDomain(filters || {});
                const [total, records, groups] = await Promise.all([
                    this.orm.searchCount("shahtaj.dm.wallet.settlement", domain),
                    this.orm.searchRead(
                        "shahtaj.dm.wallet.settlement",
                        domain,
                        ["id", "name", "settlement_date", "delivery_man_id", "amount", "bank_journal_id", "settled_by_id", "move_id", "state", "notes"],
                        {
                            limit: pag.limit,
                            offset: (pag.page - 1) * pag.limit,
                            order: "settlement_date desc, id desc",
                        },
                    ),
                    this.orm.call("shahtaj.dm.wallet.settlement", "read_group", [domain, ["amount"], []]),
                ]);
                if (fetchToken !== this._listFetchToken) {
                    return;
                }
                this.state.pagination.settlements.total = total;
                this.state.settlementTotal = (groups && groups[0] && (groups[0].amount || 0)) || 0;
                this.state.tableSettlements = (records || []).map((row) => ({
                    id: row.id,
                    name: row.name || "—",
                    date: row.settlement_date || "—",
                    dm: row.delivery_man_id ? row.delivery_man_id[1] : "—",
                    amount: row.amount || 0,
                    journal: row.bank_journal_id ? row.bank_journal_id[1] : "—",
                    settledBy: row.settled_by_id ? row.settled_by_id[1] : "—",
                    move: row.move_id ? row.move_id[1] : "—",
                    state: row.state || "",
                    notes: row.notes || "",
                }));
            }
        } catch (error) {
            this.notification.add("Failed to load data: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            if (fetchToken === this._listFetchToken) {
                this.state.isLoading.data = false;
                notifyPortalBusy(false);
            }
        }
    }

    // --- NAVIGATION & MODALS ---
    switchTab(tabName) {
        this.state.activeTab = tabName;
        this.state.viewMode = 'list';
        this.state.selectedTransaction = null;
        this.state.selectedSettlement = null;
        this.fetchActiveList();
    }

    viewDetails(transaction) {
        this.state.selectedTransaction = transaction;
        this.state.viewMode = 'detail';
    }

    goBack() {
        this.state.viewMode = 'list';
        this.state.selectedTransaction = null;
    }

    viewSettlement(row) {
        this.state.selectedSettlement = row;
    }

    closeSettlement() {
        this.state.selectedSettlement = null;
    }

    settlementStateLabel(state) {
        const map = {
            posted: "Posted",
            cancelled: "Cancelled",
        };
        return map[state] || (state ? String(state).replace(/_/g, " ") : "—");
    }

    settlementStateBadgeClass(state) {
        const map = {
            posted: "bg-success text-white",
            cancelled: "bg-danger text-white",
        };
        return map[state] || "bg-light text-dark border";
    }

    formatMoney(amount) {
        return (amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    openJournalModal() {
        this.state.journalForm = { id: null, name: '', type: 'bank', code: '' };
        this.state.showJournalModal = true;
    }

    closeJournalModal() {
        this.state.showJournalModal = false;
    }

    editJournal(journal) {
        this.state.journalForm = { id: journal.id, name: journal.name, type: journal.type, code: journal.code || '' };
        this.state.showJournalModal = true;
    }

    async saveJournal() {
        if (!this.state.journalForm.name || !this.state.journalForm.code) {
            this.notification.add("Name and Short Code are required.", { type: "danger" });
            return;
        }

        this.state.isLoading.saveJournal = true;
        try {
            if (this.state.journalForm.id) {
                await this.orm.write("account.journal", [this.state.journalForm.id], {
                    name: this.state.journalForm.name,
                    type: this.state.journalForm.type,
                    code: this.state.journalForm.code
                });
            } else {
                await this.orm.create("account.journal", [{
                    name: this.state.journalForm.name,
                    type: this.state.journalForm.type,
                    code: this.state.journalForm.code
                }]);
            }
            await this.loadLookupJournals();
            await this.fetchActiveList();
            this.closeJournalModal();
            this.notification.add("Journal saved successfully.", { type: "success" });
        } catch (error) {
            this.notification.add("Failed to save journal: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading.saveJournal = false;
        }
    }

    _money(amount) {
        return `Rs. ${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    async _loadCashActivity(page, limit) {
        return this.orm.call(
            "shahtaj.portal.read",
            "shahtaj_cash_activity_page",
            [this.state.filters.transactions, page, limit],
        );
    }

    async printCash() {
        if (this.state.isPrinting) return;
        this.state.isPrinting = true;
        try {
            const filters = this.state.filters.transactions;
            const pageResult = await this._loadCashActivity(1, 10000);
            const combined = pageResult.rows || [];
            const moneyIn = pageResult.moneyIn || 0;
            const moneyOut = pageResult.moneyOut || 0;
            if (!combined.length) {
                this.notification.add("No rows match the current filters.", { type: "warning" });
                return;
            }
            const [shops, bills] = await Promise.all([
                this.orm.searchRead(
                    "res.partner",
                    [["is_shahtaj_shop", "=", true], ["shop_approval_state", "=", "approved"]],
                    ["outstanding_balance"]
                ),
                this.orm.searchRead(
                    "account.move",
                    [
                        ["move_type", "=", "in_invoice"],
                        ["state", "=", "posted"],
                        ["payment_state", "not in", ["paid", "in_payment", "reversed"]],
                    ],
                    ["amount_residual"]
                ),
            ]);
            const receivable = shops.reduce((sum, shop) => sum + (shop.outstanding_balance || 0), 0);
            const payable = bills.reduce((sum, bill) => sum + (bill.amount_residual || 0), 0);
            const directionLabels = { inbound: "Collected (In)", outbound: "Paid Out", expense: "Expenses" };
            const sortLabels = {
                date_desc: "Newest First",
                amount_asc: "Amount: Low to High",
                amount_desc: "Amount: High to Low",
            };
            const journal = (this.state.lookupJournals || []).find((row) => String(row.id) === String(filters.journal));
            await printListPdf(this.orm, this.action, {
                title: "Cash Activity",
                filters: [
                    printFilter("Search", filters.search),
                    printFilter("Flow", directionLabels[filters.direction]),
                    printFilter("Journal", journal ? journal.name : ""),
                    printFilter("Sort", sortLabels[filters.sortBy]),
                    printFilter("From", filters.dateFrom),
                    printFilter("To", filters.dateTo),
                ],
                summary: [
                    `Collected (In): ${this._money(moneyIn)}`,
                    `Paid Out: ${this._money(moneyOut)}`,
                    `Receivable: ${this._money(receivable)}`,
                    `Payable: ${this._money(payable)}`,
                ],
                columns: ["Date", "Reference", "Flow", "Journal", "Shop / Payee", "Method / Description", "Amount", "Status"],
                rows: combined.map((row) => {
                    const sign = row.payment_type === "outbound" ? "-" : "+";
                    const status = row.state === "posted" ? "PAID" : (row.state || "").toUpperCase();
                    return [
                        row.date || "",
                        row.name || "",
                        row.flow_label || "",
                        row.journal_name || "",
                        row.partner_name || "",
                        row.method_or_desc || "",
                        `${sign} ${this._money(row.display_amount)}`,
                        status,
                    ];
                }),
            });
        } catch (error) {
            this.notification.add(error?.data?.message || error?.message || "Print failed.", { type: "danger" });
        } finally {
            this.state.isPrinting = false;
        }
    }
}
BankTransactions.template = "shahtaj_oil.BankTransactions";