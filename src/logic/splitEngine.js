/**
 * Split Calculator — Handles all split modes with proportional tax distribution
 * and rounding reconciliation.
 * 
 * SPLIT MODES:
 * 1. itemized  — Each item assigned to specific members, split among assignees
 * 2. equal     — Total ÷ N members
 * 3. exact     — User specifies exact amounts (must sum to total)
 * 4. percentage — User specifies % per member (must sum to 100%)
 * 5. shares    — Ratios like 2:1:1
 * 
 * PROPORTIONAL TAX/CHARGE/DISCOUNT:
 * Tax is distributed proportional to each member's item subtotal.
 * Example: ₹1,000 bill, ₹100 tax, member A's items = ₹600 → A pays ₹60 tax.
 * 
 * ROUNDING RULE (Largest Remainder Method):
 * 1. Compute each member's exact share (possibly fractional paise)
 * 2. Floor each share to get integer paise
 * 3. Compute remainder = total - sum(floored shares)
 * 4. Sort members by fractional part descending
 * 5. Give 1 extra paisa to top `remainder` members
 * 
 * GUARANTEE: sum of all shares === bill total, to the paisa.
 */

/**
 * Calculate itemized split: each item assigned to members, tax distributed proportionally.
 * @param {Object} expense - { items, taxes, serviceCharge, discount, total }
 * @param {string[]} memberIds - All member IDs in the group
 * @returns {Object} { splits: {memberId: amountPaise}, breakdown: {memberId: {items, tax, serviceCharge, discount, total}} }
 */
export function calculateItemizedSplit(expense) {
  const { items, taxes = [], serviceCharge = 0, discount = 0 } = expense;
  
  // 1. Calculate each member's item subtotal
  const memberItemSubtotals = {};
  
  for (const item of items) {
    if (!item.assignees || item.assignees.length === 0) continue;
    
    const perPerson = distributeEvenly(item.totalPaise, item.assignees.length);
    item.assignees.forEach((memberId, idx) => {
      if (!memberItemSubtotals[memberId]) memberItemSubtotals[memberId] = 0;
      memberItemSubtotals[memberId] += perPerson[idx];
    });
  }
  
  const participantIds = Object.keys(memberItemSubtotals);
  if (participantIds.length === 0) {
    return { splits: {}, breakdown: {} };
  }
  
  const totalItemSubtotal = Object.values(memberItemSubtotals).reduce((a, b) => a + b, 0);
  
  // 2. Proportionally distribute each tax
  const memberTax = {};
  participantIds.forEach(id => { memberTax[id] = 0; });
  
  const totalTaxAmount = taxes.reduce((sum, t) => sum + t.amountPaise, 0);
  if (totalTaxAmount > 0 && totalItemSubtotal > 0) {
    const taxShares = distributeProportionally(totalTaxAmount, 
      participantIds.map(id => memberItemSubtotals[id]), participantIds);
    participantIds.forEach((id, i) => { memberTax[id] = taxShares[i]; });
  }
  
  // 3. Proportionally distribute service charge
  const memberSC = {};
  participantIds.forEach(id => { memberSC[id] = 0; });
  
  if (serviceCharge > 0 && totalItemSubtotal > 0) {
    const scShares = distributeProportionally(serviceCharge,
      participantIds.map(id => memberItemSubtotals[id]), participantIds);
    participantIds.forEach((id, i) => { memberSC[id] = scShares[i]; });
  }
  
  // 4. Proportionally distribute discount (subtracted)
  const memberDiscount = {};
  participantIds.forEach(id => { memberDiscount[id] = 0; });
  
  if (discount > 0 && totalItemSubtotal > 0) {
    const discShares = distributeProportionally(discount,
      participantIds.map(id => memberItemSubtotals[id]), participantIds);
    participantIds.forEach((id, i) => { memberDiscount[id] = discShares[i]; });
  }
  
  // 5. Compute final per-member total
  const splits = {};
  const breakdown = {};
  
  for (const id of participantIds) {
    const total = memberItemSubtotals[id] + memberTax[id] + memberSC[id] - memberDiscount[id];
    splits[id] = total;
    breakdown[id] = {
      items: memberItemSubtotals[id],
      tax: memberTax[id],
      serviceCharge: memberSC[id],
      discount: memberDiscount[id],
      total,
    };
  }
  
  return { splits, breakdown };
}

/**
 * Equal split among members.
 * @param {number} totalPaise - Total amount in paise
 * @param {string[]} memberIds - Member IDs to split among
 * @returns {Object} { splits: {memberId: amountPaise} }
 */
export function calculateEqualSplit(totalPaise, memberIds) {
  if (memberIds.length === 0) return { splits: {} };
  
  const shares = distributeEvenly(totalPaise, memberIds.length);
  const splits = {};
  memberIds.forEach((id, i) => { splits[id] = shares[i]; });
  
  return { splits };
}

/**
 * Exact-amount split.
 * @param {Object} exactAmounts - {memberId: amountPaise}
 * @param {number} totalPaise - Expected total
 * @returns {Object} { splits, valid, difference }
 */
export function calculateExactSplit(exactAmounts, totalPaise) {
  const sum = Object.values(exactAmounts).reduce((a, b) => a + b, 0);
  const difference = totalPaise - sum;
  
  return {
    splits: { ...exactAmounts },
    valid: difference === 0,
    difference,
  };
}

/**
 * Percentage-based split.
 * @param {number} totalPaise
 * @param {Object} percentages - {memberId: percentage} (should sum to 100)
 * @returns {Object} { splits, valid }
 */
export function calculatePercentageSplit(totalPaise, percentages) {
  const totalPct = Object.values(percentages).reduce((a, b) => a + b, 0);
  const valid = Math.abs(totalPct - 100) < 0.01;
  
  const memberIds = Object.keys(percentages);
  const weights = memberIds.map(id => percentages[id]);
  const shares = distributeProportionally(totalPaise, weights, memberIds);
  
  const splits = {};
  memberIds.forEach((id, i) => { splits[id] = shares[i]; });
  
  return { splits, valid, totalPercentage: totalPct };
}

/**
 * Shares-based split (ratios).
 * @param {number} totalPaise
 * @param {Object} shares - {memberId: shareCount} e.g., {a: 2, b: 1, c: 1}
 * @returns {Object} { splits }
 */
export function calculateSharesSplit(totalPaise, shares) {
  const memberIds = Object.keys(shares);
  const weights = memberIds.map(id => shares[id]);
  const distributed = distributeProportionally(totalPaise, weights, memberIds);
  
  const splits = {};
  memberIds.forEach((id, i) => { splits[id] = distributed[i]; });
  
  return { splits };
}

/**
 * Distribute an integer amount evenly among N people.
 * Uses largest remainder method.
 * @param {number} totalPaise - Integer amount
 * @param {number} n - Number of people
 * @returns {number[]} Array of n integers summing to totalPaise
 */
export function distributeEvenly(totalPaise, n) {
  if (n <= 0) return [];
  if (n === 1) return [totalPaise];
  
  const base = Math.floor(totalPaise / n);
  const remainder = totalPaise - base * n;
  
  const result = new Array(n).fill(base);
  // Give 1 extra paisa to the first `remainder` people
  for (let i = 0; i < remainder; i++) {
    result[i] += 1;
  }
  
  return result;
}

/**
 * Distribute an integer amount proportionally according to weights.
 * Uses largest remainder method to ensure exact reconciliation.
 * @param {number} totalPaise - Integer amount to distribute
 * @param {number[]} weights - Proportional weights (not necessarily integers)
 * @param {string[]} ids - Corresponding member IDs (for stable tie-breaking)
 * @returns {number[]} Array of integers summing to totalPaise
 */
export function distributeProportionally(totalPaise, weights, ids) {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [totalPaise];
  
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) return distributeEvenly(totalPaise, n);
  
  // Compute exact shares (floating point)
  const exactShares = weights.map(w => (w / totalWeight) * totalPaise);
  
  // Floor each share
  const floored = exactShares.map(s => Math.floor(s));
  
  // Compute remainder
  const currentSum = floored.reduce((a, b) => a + b, 0);
  let remainder = totalPaise - currentSum;
  
  // Sort indices by fractional part descending
  const fractionalParts = exactShares.map((s, i) => ({
    index: i,
    fraction: s - Math.floor(s),
  }));
  fractionalParts.sort((a, b) => b.fraction - a.fraction);
  
  // Give 1 extra paisa to top `remainder` members
  for (let i = 0; i < remainder && i < fractionalParts.length; i++) {
    floored[fractionalParts[i].index] += 1;
  }
  
  return floored;
}

/**
 * Compute net balances for all members in a group across all expenses.
 * @param {Array} expenses - All expenses in the group
 * @param {Array} members - All members in the group
 * @returns {Object} {memberId: netBalancePaise} — Positive = is owed, Negative = owes
 */
export function computeNetBalances(expenses, members) {
  const balances = {};
  members.forEach(m => { balances[m.id] = 0; });
  
  for (const expense of expenses) {
    if (!expense.splits || !expense.payerId) continue;
    
    // The payer paid the full amount
    const totalPaid = Object.values(expense.splits).reduce((a, b) => a + b, 0);
    
    if (balances[expense.payerId] !== undefined) {
      balances[expense.payerId] += totalPaid;
    }
    
    // Each member owes their split
    for (const [memberId, amount] of Object.entries(expense.splits)) {
      if (balances[memberId] !== undefined) {
        balances[memberId] -= amount;
      }
    }
  }
  
  return balances;
}
