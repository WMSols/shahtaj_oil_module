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

        this.state = useState({
            // View Control
            activeTab: 'transactions', // 'transactions' or 'journals'
            viewMode: 'list', // 'list' or 'detail'
            selectedTransaction: null,

            // Loading States
            isLoading: {
                data: true,
                saveJournal: false
            },

            // Modal State
            showJournalModal: false,
            journalForm: {
                name: '',
                type: 'bank',
                code: '' // Odoo requires a short code for journals
            },

            // Data
            transactions: [],
            journals: [],

            // Filters
            searchQuery: '',
            filterJournal: 'all',
            filterDirection: this.props.initialDirection || 'all',
            sortBy: 'date_desc',
            dateFrom: '',
            dateTo: ''
        });

        onWillUpdateProps((nextProps) => {
            if (
                nextProps.initialDirection
                && nextProps.initialDirection !== this.state.filterDirection
            ) {
                this.state.filterDirection = nextProps.initialDirection;
                this.state.activeTab = 'transactions';
                this.state.viewMode = 'list';
                this.state.selectedTransaction = null;
            }
        });

        onWillStart(async () => {
            if (!hasFinancialAccess()) {
                return;
            }
            await this.fetchAllData();
        });
    }

    async fetchAllData() {
        this.state.isLoading.data = true;
        try {
            await Promise.all([
                this.loadJournals(),
                this.loadTransactions()
            ]);
        } catch (error) {
            console.error("Failed to load data:", error);
        } finally {
            this.state.isLoading.data = false;
        }
    }

    async refreshData() {
        await this.fetchAllData();
    }

    async loadJournals() {
        const journals = await this.orm.searchRead(
            "account.journal",
            [["type", "in", ["bank", "cash"]]],
            ["id", "name", "type", "code", "currency_id"]
        );
        this.state.journals = journals;
    }

    async loadTransactions() {
        const payments = await this.orm.searchRead(
            "account.payment",
            [["journal_id.type", "in", ["bank", "cash"]]],
            [
                "id", "name", "date", "journal_id", "partner_id", "amount_signed",
                "state", "payment_type", "shahtaj_payment_channel",
                "shahtaj_payer_bank_name", "shahtaj_payer_account_number",
                "shahtaj_instrument_reference", "shahtaj_payment_notes"
            ]
        );
        this.state.transactions = payments.map(p => ({
            ...p,
            partner_name: p.partner_id ? p.partner_id[1] : 'Unknown',
            journal_name: p.journal_id ? p.journal_id[1] : 'Unknown',
            display_amount: Math.abs(p.amount_signed || 0),
            flow_label: p.payment_type === 'outbound' ? 'Paid Out' : 'Collected',
        }));
    }

    get filteredTransactions() {
        let list = this.state.transactions.filter(t => {
            const query = this.state.searchQuery.toLowerCase();
            const matchesSearch = t.partner_name.toLowerCase().includes(query) ||
                                  t.name.toLowerCase().includes(query) ||
                                  (t.shahtaj_instrument_reference || '').toLowerCase().includes(query);

            const matchesJournal = this.state.filterJournal === 'all' ||
                                   (t.journal_id && t.journal_id[0] === parseInt(this.state.filterJournal));

            const matchesDateFrom = !this.state.dateFrom || t.date >= this.state.dateFrom;
            const matchesDateTo = !this.state.dateTo || t.date <= this.state.dateTo;

            const matchesDirection = this.state.filterDirection === 'all'
                || t.payment_type === this.state.filterDirection;

            return matchesSearch && matchesJournal && matchesDateFrom && matchesDateTo && matchesDirection;
        });

        if (this.state.sortBy === 'amount_asc') list.sort((a, b) => a.display_amount - b.display_amount);
        if (this.state.sortBy === 'amount_desc') list.sort((a, b) => b.display_amount - a.display_amount);
        if (this.state.sortBy === 'date_desc') list.sort((a, b) => new Date(b.date) - new Date(a.date));

        return list;
    }

    get activityTotals() {
        let moneyIn = 0;
        let moneyOut = 0;
        for (const t of this.filteredTransactions) {
            if (t.payment_type === 'outbound') {
                moneyOut += t.display_amount;
            } else {
                moneyIn += t.display_amount;
            }
        }
        return {
            moneyIn,
            moneyOut,
            net: moneyIn - moneyOut,
        };
    }

    openJournalModal() {
        this.state.journalForm = { name: '', type: 'bank', code: '' };
        this.state.showJournalModal = true;
    }

    closeJournalModal() {
        this.state.showJournalModal = false;
    }

    switchTab(tabName) {
        this.state.activeTab = tabName;
        this.state.viewMode = 'list';
        this.state.selectedTransaction = null;
    }

    viewDetails(transaction) {
        this.state.selectedTransaction = transaction;
        this.state.viewMode = 'detail';
    }

    goBack() {
        this.state.viewMode = 'list';
        this.state.selectedTransaction = null;
    }

    editJournal(journal) {
        this.state.journalForm = {
            id: journal.id,
            name: journal.name,
            type: journal.type,
            code: journal.code || ''
        };
        this.state.showJournalModal = true;
    }

    async saveJournal() {
        if (!this.state.journalForm.name || !this.state.journalForm.code) {
            alert("Name and Short Code are required.");
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
            await this.loadJournals();
            this.closeJournalModal();
        } catch (error) {
            alert("Failed to save journal: " + (error.data?.message || error.message));
        } finally {
            this.state.isLoading.saveJournal = false;
        }
    }
}

BankTransactions.template = "shahtaj_oil.BankTransactions";
