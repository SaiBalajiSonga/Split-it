/**
 * Debt Simplifier — Computes minimum number of transactions to settle all balances.
 * 
 * ALGORITHM: Greedy Net-Balance Settlement
 * 
 * 1. Compute net balance for each member:
 *    netBalance = totalPaid - totalOwed
 *    Positive = is owed money (creditor)
 *    Negative = owes money (debtor)
 * 
 * 2. Greedy matching:
 *    a. Separate into creditors (positive) and debtors (negative)
 *    b. Sort both lists by amount descending
 *    c. Match largest debtor with largest creditor
 *    d. Transfer min(|debt|, |credit|)
 *    e. Remove fully settled party, repeat
 * 
 * This produces O(n-1) transactions in the worst case, which is optimal
 * for the general case. The NP-hard optimal solution (minimum transfers
 * with group cancellation) is overkill for typical group sizes (< 10).
 * 
 * TIME COMPLEXITY: O(n log n) for sorting + O(n) for matching = O(n log n)
 * SPACE COMPLEXITY: O(n)
 * 
 * All amounts are in PAISE (integers).
 */

/**
 * Simplify debts to minimum transactions.
 * @param {Object} memberBalances - { memberId: netBalancePaise }
 *   Positive = is owed money, Negative = owes money
 * @returns {Array} [{from, to, amountPaise}] — Minimum transactions
 */
export function simplifyDebts(memberBalances) {
  const creditors = []; // People who are owed money (positive balance)
  const debtors = [];   // People who owe money (negative balance)

  for (const [id, balance] of Object.entries(memberBalances)) {
    if (balance > 1) { // Ignore sub-paisa balances
      creditors.push({ id, amount: balance });
    } else if (balance < -1) {
      debtors.push({ id, amount: -balance }); // Store as positive for easier math
    }
  }

  // Sort both lists descending by amount
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0; // debtor pointer
  let j = 0; // creditor pointer

  while (i < debtors.length && j < creditors.length) {
    const transfer = Math.min(debtors[i].amount, creditors[j].amount);
    
    if (transfer > 0) {
      transactions.push({
        from: debtors[i].id,
        to: creditors[j].id,
        amountPaise: transfer,
      });
    }

    debtors[i].amount -= transfer;
    creditors[j].amount -= transfer;

    if (debtors[i].amount <= 0) i++;
    if (creditors[j].amount <= 0) j++;
  }

  return transactions;
}

/**
 * Verify that all transactions sum to zero (sanity check).
 * @param {Array} transactions - [{from, to, amountPaise}]
 * @param {Object} originalBalances - {memberId: netBalancePaise}
 * @returns {boolean}
 */
export function verifySettlement(transactions, originalBalances) {
  const simulated = { ...originalBalances };
  
  for (const t of transactions) {
    simulated[t.from] = (simulated[t.from] || 0) + t.amountPaise;
    simulated[t.to] = (simulated[t.to] || 0) - t.amountPaise;
  }
  
  // All balances should be approximately zero
  return Object.values(simulated).every(b => Math.abs(b) <= 1);
}
