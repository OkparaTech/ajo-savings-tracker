// Target HTML Elements
const descInput = document.getElementById('desc-input');
const amountInput = document.getElementById('amount-input');
const typeSelect = document.getElementById('type-select');
const submitBtn = document.getElementById('submit-btn');
const ledgerList = document.getElementById('ledger-list');

const totalBalance = document.getElementById('total-balance');
const totalIncome = document.getElementById('total-income');
const totalExpense = document.getElementById('total-expense');

// The Local API URL path connected directly to your Go Backend Routing
const API_URL = '/api/transactions';

// 1. Initial Launch Routing Loop
document.addEventListener('DOMContentLoaded', fetchTransactions);
submitBtn.addEventListener('click', postTransaction);

// 2. Fetch Data (GET) from Go Server
async function fetchTransactions() {
    try {
        const response = await fetch(API_URL);
        const transactions = await response.json();
        renderDashboard(transactions);
    } catch (error) {
        console.error('Error hitting backend server database:', error);
    }
}

// 3. Send Data (POST) to Go Server
async function postTransaction() {
    const description = descInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const type = typeSelect.value;

    if (description === '' || isNaN(amount) || amount <= 0) {
        alert('Please fill input entries with positive numerical adjustments.');
        return;
    }

    const payload = { description, amount, type };

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            // Clear Inputs and re-fetch freshest transaction array stack from backend
            descInput.value = '';
            amountInput.value = '';
            fetchTransactions();
        }
    } catch (error) {
        console.error('Network data packaging dispatch failure:', error);
    }
}

// 4. Calculate Financial Sums and Update UI Layout View
function renderDashboard(transactions) {
    ledgerList.innerHTML = ''; // Reset UI Ledger rows completely
    
    let incomeSum = 0;
    let expenseSum = 0;

    transactions.forEach(tx => {
        // Build Ledger HTML Entry Row
        const li = document.createElement('li');
        li.className = `transaction-item ${tx.type}-type`;
        
        const prefix = tx.type === 'income' ? '+' : '-';
        li.innerHTML = `
            <span class="item-desc">${tx.description}</span>
            <span class="item-amt">${prefix} ₦${tx.amount.toFixed(2)}</span>
        `;
        ledgerList.appendChild(li);

        // Sum values using execution calculation logic blocks
        if (tx.type === 'income') {
            incomeSum += tx.amount;
        } else {
            expenseSum += tx.amount;
        }
    });

    const netBalance = incomeSum - expenseSum;

    // Direct DOM Text Injection
    totalIncome.textContent = `+ ₦${incomeSum.toFixed(2)}`;
    totalExpense.textContent = `- ₦${expenseSum.toFixed(2)}`;
    totalBalance.textContent = `₦${netBalance.toFixed(2)}`;
    
    // Safety check styling rule: turn remaining layout balance red if overspent
    totalBalance.style.color = netBalance < 0 ? '#ef4444' : '#0f172a';
}
