/** @odoo-module **/

import { Component, useState, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { hasFinancialAccess } from "../shahtaj_access";

export class BankTransactions extends Component {
    static props = {
        embedded: { type: Boolean, optional: true },
        initialDirection: { type: String, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        const ITEMS_PER_PAGE = 10;
        
        this.state = useState({
            activeTab: 'transactions', 
            viewMode: 'list', 
            selectedTransaction: null,
            isLoading: { data: false, saveJournal: false },
            
            showJournalModal: false,
            journalForm: { id: null, name: '', type: 'bank', code: '' },
            
            // --- BACKEND PAGINATION ---
            itemsPerPage: ITEMS_PER_PAGE,
            searchTimeout: null,
            tableTransactions: [],
            tableJournals: [],
            lookupJournals: [], // Used strictly for the dropdown
            
            pagination: {
                transactions: { page: 1, limit: ITEMS_PER_PAGE, total: 0 },
                journals: { page: 1, limit: ITEMS_PER_PAGE, total: 0 }
            },
            filters: {
                transactions: { 
                    search: '', journal: 'all', 
                    direction: this.props.initialDirection || 'all', 
                    sortBy: 'date_desc', dateFrom: '', dateTo: '' 
                },
                journals: { search: '' }
            },
            
            // Replaces the old frontend getter
            totals: { moneyIn: 0, moneyOut: 0, net: 0 }
        });

        this.debounceSearch = (func, wait) => {
            return (...args) => {
                clearTimeout(this.state.searchTimeout);
                this.state.searchTimeout = setTimeout(() => func.apply(this, args), wait);
            };
        };
        this.debouncedFetchActiveList = this.debounceSearch(() => this.fetchActiveList(), 400);

        onWillUpdateProps((nextProps) => {
            if (nextProps.initialDirection && nextProps.initialDirection !== this.state.filters.transactions.direction) {
                this.state.filters.transactions.direction = nextProps.initialDirection;
                this.state.activeTab = 'transactions';
                this.state.viewMode = 'list';
                this.state.selectedTransaction = null;
                this.state.pagination.transactions.page = 1;
                this.fetchActiveList();
            }
        });

        onWillStart(async () => {
            if (!hasFinancialAccess()) return;
            await this.loadLookupJournals();
            await this.fetchActiveList();
        });
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

    changePage(tabName, direction) {
        const pag = this.state.pagination[tabName];
        const newPage = pag.page + direction;
        const maxPage = Math.max(1, Math.ceil(pag.total / pag.limit));
        
        if (newPage >= 1 && newPage <= maxPage) {
            pag.page = newPage;
            this.fetchActiveList();
        }
    }

    async refreshData() {
        await this.loadLookupJournals();
        await this.fetchActiveList();
    }

    async loadLookupJournals() {
        this.state.lookupJournals = await this.orm.searchRead(
            "account.journal", [["type", "in", ["bank", "cash"]]], ["id", "name"]
        );
    }

    // --- THE MASTER DATA ENGINE ---
    async fetchActiveList() {
        this.state.isLoading.data = true;
        try {
            const tab = this.state.activeTab;
            const pag = this.state.pagination[tab];
            const filters = this.state.filters[tab];
            
           if (tab === 'transactions') {
                let payDomain = [["journal_id.type", "in", ["bank", "cash"]]];
                let expDomain = [["journal_id.type", "in", ["bank", "cash"]]];
                
                if (filters.search) {
                    payDomain.push('|', '|', 
                        ['partner_id.name', 'ilike', filters.search], 
                        ['name', 'ilike', filters.search], 
                        ['shahtaj_instrument_reference', 'ilike', filters.search]
                    );
                    expDomain.push('|', '|', 
                        ['partner_id.name', 'ilike', filters.search], 
                        ['name', 'ilike', filters.search], 
                        ['description', 'ilike', filters.search]
                    );
                }
                
                if (filters.journal !== 'all') {
                    payDomain.push(['journal_id', '=', parseInt(filters.journal)]);
                    expDomain.push(['journal_id', '=', parseInt(filters.journal)]);
                }
                if (filters.dateFrom) {
                    payDomain.push(['date', '>=', filters.dateFrom]);
                    expDomain.push(['date', '>=', filters.dateFrom]);
                }
                if (filters.dateTo) {
                    payDomain.push(['date', '<=', filters.dateTo]);
                    expDomain.push(['date', '<=', filters.dateTo]);
                }
                
                // Fetch both up to a safe limit to paginate & sort locally
                const [payments, expenses] = await Promise.all([
                    this.orm.searchRead('account.payment', payDomain, [
                        "id", "name", "date", "journal_id", "partner_id", "amount", "amount_signed",
                        "state", "payment_type", "shahtaj_payment_channel",
                        "shahtaj_payer_bank_name", "shahtaj_payer_account_number",
                        "shahtaj_instrument_reference", "shahtaj_payment_notes"
                    ], { limit: 2000, order: "date desc" }),
                    
                    this.orm.searchRead('shahtaj.expense', expDomain, [
                        "id", "name", "date", "journal_id", "partner_id", "amount", 
                        "state", "description", "category_id", "notes"
                    ], { limit: 2000, order: "date desc" })
                ]);
                
                let combined = [];
                
                payments.forEach(p => {
                    if (filters.direction === 'outbound' && p.payment_type !== 'outbound') return;
                    if (filters.direction === 'inbound' && p.payment_type !== 'inbound') return;
                    if (filters.direction === 'expense') return;
                    
                    combined.push({
                        _model: 'account.payment',
                        id: p.id,
                        name: p.name,
                        date: p.date,
                        journal_name: p.journal_id ? p.journal_id[1] : 'Unknown',
                        partner_name: p.partner_id ? p.partner_id[1] : 'Unknown',
                        method_or_desc: p.shahtaj_payment_channel || 'System',
                        display_amount: Math.abs(p.amount_signed || p.amount || 0),
                        payment_type: p.payment_type, 
                        flow_label: p.payment_type === 'outbound' ? 'Paid Out' : 'Collected',
                        state: p.state,
                        raw: p
                    });
                });

                expenses.forEach(e => {
                    if (filters.direction === 'inbound' || filters.direction === 'outbound') return; 
                    
                    combined.push({
                        _model: 'shahtaj.expense',
                        id: e.id,
                        name: e.name,
                        date: e.date,
                        journal_name: e.journal_id ? e.journal_id[1] : 'Unknown',
                        partner_name: e.partner_id ? e.partner_id[1] : (e.category_id ? e.category_id[1] : 'Expense'),
                        method_or_desc: e.description || 'Operating Expense',
                        display_amount: e.amount || 0,
                        payment_type: 'outbound',
                        flow_label: 'Expense',
                        state: e.state,
                        raw: e
                    });
                });

                // Compute Real-time Totals (Ignoring Draft/Cancelled)
                let mIn = 0; let mOut = 0;
                combined.forEach(r => {
                    if (['posted', 'paid', 'in_process', 'reconciled'].includes(r.state)) {
                        if (r.payment_type === 'outbound') mOut += r.display_amount;
                        else mIn += r.display_amount;
                    }
                });
                this.state.totals = { moneyIn: mIn, moneyOut: mOut, net: mIn - mOut };

                // Apply dynamic sorting
                combined.sort((a, b) => {
                    if (filters.sortBy === 'date_desc') {
                        return a.date > b.date ? -1 : (a.date < b.date ? 1 : 0);
                    } else if (filters.sortBy === 'amount_asc') {
                        return a.display_amount - b.display_amount;
                    } else if (filters.sortBy === 'amount_desc') {
                        return b.display_amount - a.display_amount;
                    }
                    return 0;
                });

                // Paginate UI
                this.state.pagination.transactions.total = combined.length;
                const start = (pag.page - 1) * pag.limit;
                this.state.tableTransactions = combined.slice(start, start + pag.limit);
            }else if (tab === 'journals') {
                let domain = [["type", "in", ["bank", "cash"]]];
                if (filters.search) domain.push(['name', 'ilike', filters.search]);
                
                const [total, records] = await Promise.all([
                    this.orm.searchCount('account.journal', domain),
                    this.orm.searchRead('account.journal', domain, ["id", "name", "type", "code"], { limit: pag.limit, offset: (pag.page - 1) * pag.limit, order: "id desc" })
                ]);
                
                this.state.pagination.journals.total = total;
                this.state.tableJournals = records;
            }
        } catch (error) {
            this.notification.add("Failed to load data: " + (error.data?.message || error.message), { type: "danger" });
        } finally {
            this.state.isLoading.data = false;
        }
    }

    // --- NAVIGATION & MODALS ---
    switchTab(tabName) {
        this.state.activeTab = tabName;
        this.state.viewMode = 'list';
        this.state.selectedTransaction = null;
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
}
BankTransactions.template = "shahtaj_oil.BankTransactions";