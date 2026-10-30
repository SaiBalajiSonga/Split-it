import { parseReceipt } from './src/logic/receiptParser.js';
import { calculateItemizedSplit, calculateEqualSplit, calculatePercentageSplit, calculateSharesSplit, computeNetBalances } from './src/logic/splitEngine.js';
import { simplifyDebts, verifySettlement } from './src/logic/debtSimplifier.js';
import { formatCurrency, parseRupees, generateUPILink } from './src/utils/formatters.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

console.log('=== TEST SUITE: SplitSmart Core Logic ===\n');

// --- Test 1: Currency Formatting & Parsing ---
console.log('[1] Currency & Paise Arithmetic:');
assert(formatCurrency(145050) === '₹1,450.50', 'Format 145050 paise -> ₹1,450.50');
assert(formatCurrency(0) === '₹0.00', 'Format 0 paise -> ₹0.00');
assert(formatCurrency(-5000) === '-₹50.00', 'Format -5000 paise -> -₹50.00');
assert(parseRupees('₹1,450.50') === 145050, 'Parse ₹1,450.50 -> 145050 paise');
assert(parseRupees('250') === 25000, 'Parse 250 -> 25000 paise');

// --- Test 2: Split Engine - Equal Split with Paise Reconcile ---
console.log('\n[2] Equal Split Rounding Reconciliation:');
const members = ['m1', 'm2', 'm3'];
const equalSplitResult = calculateEqualSplit(10000, members); // 100.00 / 3 = 33.333...
const equalSplit = equalSplitResult.splits;
const equalSum = Object.values(equalSplit).reduce((a, b) => a + b, 0);
assert(equalSum === 10000, `Equal split sum equals total exactly (${equalSum} === 10000)`);
assert(equalSplit['m1'] === 3334 || equalSplit['m2'] === 3334 || equalSplit['m3'] === 3334, 'Largest remainder got the extra 1 paisa');

// --- Test 3: Split Engine - Itemized Split with Proportional Tax ---
console.log('\n[3] Itemized Split with Proportional Tax & Discount:');
const sampleExpense = {
  items: [
    { id: '1', name: 'Butter Chicken', totalPaise: 40000, assignees: ['m1'] },
    { id: '2', name: 'Paneer Tikka', totalPaise: 20000, assignees: ['m2'] },
    { id: '3', name: 'Garlic Naan (4x)', totalPaise: 20000, assignees: ['m1', 'm2'] }, // 10000 each
  ],
  taxes: [{ name: 'GST 5%', amountPaise: 4000 }], // 40.00 tax total on 800.00 = 5%
  serviceCharge: 8000, // 80.00
  discount: 4000, // 40.00
};
// Subtotals:
// m1 = 40000 + 10000 = 50000 (5/8 of subtotal)
// m2 = 20000 + 10000 = 30000 (3/8 of subtotal)
// Total items = 80000
// Net total = 80000 + 4000 + 8000 - 4000 = 88000
const itemizedResult = calculateItemizedSplit(sampleExpense);
const itemizedSum = Object.values(itemizedResult.splits).reduce((a, b) => a + b, 0);
assert(itemizedSum === 88000, `Itemized sum (${itemizedSum}) matches expected total (88000)`);
assert(itemizedResult.splits['m1'] === 55000, `m1 pays 5/8 of total: ${itemizedResult.splits['m1']} === 55000`);
assert(itemizedResult.splits['m2'] === 33000, `m2 pays 3/8 of total: ${itemizedResult.splits['m2']} === 33000`);

// --- Test 4: Debt Simplifier ---
console.log('\n[4] Debt Simplifier Greedy Matching:');
// 4 roommates:
// A paid 12000 (owed 3000 -> net +9000)
// B paid 0 (owed 3000 -> net -3000)
// C paid 0 (owed 3000 -> net -3000)
// D paid 0 (owed 3000 -> net -3000)
const balances = {
  'A': 9000,
  'B': -3000,
  'C': -3000,
  'D': -3000,
};
const txs = simplifyDebts(balances);
assert(txs.length === 3, `Simplified to exactly 3 transactions (got ${txs.length})`);
assert(verifySettlement(txs, balances), 'All balances verified to zero after settlement');

// Complex 5-person circular debt test:
const complexBalances = {
  'Alice': 5000,
  'Bob': -2500,
  'Charlie': -2500,
  'Dave': 3000,
  'Eve': -3000,
};
const complexTxs = simplifyDebts(complexBalances);
assert(complexTxs.length <= 4, `Complex 5-party debt reduced to <= 4 transactions (got ${complexTxs.length})`);
assert(verifySettlement(complexTxs, complexBalances), 'Complex debt settlement balances to zero');

// --- Test 5: UPI Deep Link Generation ---
console.log('\n[5] UPI Link Generation:');
const upiLink = generateUPILink({
  payeeUPI: 'aarav@okhdfcbank',
  payeeName: 'Aarav Sharma',
  amount: 145000,
  note: 'SplitSmart: Midnight Biryani',
});
assert(upiLink.startsWith('upi://pay?'), 'UPI link starts with upi://pay?');
assert(upiLink.includes('pa=aarav%40okhdfcbank'), 'Contains correct UPI ID');
assert(upiLink.includes('am=1450.00'), 'Contains formatted rupee amount 1450.00');

// --- Test 6: OCR Receipt Parser ---
console.log('\n[6] Receipt Parser Heuristics:');
const mockOcrResult = {
  lines: [
    { text: 'CAFE COFFEE DAY' },
    { text: 'GSTIN: 29AABCU9603R1ZM' },
    { text: 'Table No: 4' },
    { text: '--------------------------------' },
    { text: 'Cappuccino Large  2 x 180.00  360.00' },
    { text: 'Chocolate Muffin  1 x 120.00  120.00' },
    { text: 'Chicken Sandwich             250.00' },
    { text: '--------------------------------' },
    { text: 'Sub Total: 730.00' },
    { text: 'CGST 2.5%: 18.25' },
    { text: 'SGST 2.5%: 18.25' },
    { text: 'Service Charge 5%: 36.50' },
    { text: 'Round Off: 0.00' },
    { text: 'Grand Total: 803.00' },
    { text: 'Thank You Visit Again' },
  ],
};

const parsed = parseReceipt(mockOcrResult);
assert(parsed.items.length === 3, `Detected 3 items (got ${parsed.items.length})`);
assert(parsed.items[0].name.toLowerCase().includes('cappuccino'), 'Item 1 name detected correctly');
assert(parsed.items[0].qty === 2, `Item 1 qty = 2 (got ${parsed.items[0].qty})`);
assert(parsed.items[0].totalPaise === 36000, `Item 1 total = 36000 paise (got ${parsed.items[0].totalPaise})`);
assert(parsed.total === 80300, `Grand total = 80300 paise (got ${parsed.total})`);
assert(parsed.taxes.length === 2, `Detected 2 tax lines (CGST & SGST) (got ${parsed.taxes.length})`);
assert(parsed.serviceCharge === 3650, `Detected service charge 36.50 -> 3650 paise (got ${parsed.serviceCharge})`);

// --- Test 7: Real-world Bombay Canteen Receipt (Raw Text from Tesseract) ---
console.log('\n[7] Real-world Restaurant Receipt (The Bombay Canteen):');
const bombayText = `
***REPRINT***
Tel /02249666666
THE BOMBAY CANTEEN
INDIAN CAFE & BAR
Facebook /thebombaycanteen
Twitter /bombay_canteen
Instagram /thebombaycanteen
BILL NO : 00047224 TABLE : 20
BILL DATE : 21/05/2016 COVERS: 2
BILL TIME : 15:49 SHIFT : 1
QTY DESCRIPTION AMOUNT
1 MASALA COKE 200.00
1 TZ'S ELIXIR 200.00
1 CHETTINAD PRAWNS ALI-YOL 400.00
1 B**F FRY 375.00
3 MALABAR PARATHA 270.00
1 BARLEY SALAD 225.00
1 MUTTON CURRY 325.00
1 COFFEE RASGULLA 350.00
1 MANGO TRIFLE (SINGLE) 150.00
Sub Total 2495.00
Service Charge 10% 249.50
Service Tax 5.80% 159.18
VAT ON CARB BEV 25% 55.00
VAT ON FOOD 12.5% 315.56
Adjustments 0.76
Gross Amount 3275.00
VAT NO: 27965280003V
S.T.NO: AADCH3020RSD001
CHINTU, CHHOTA AND BADA
SAY THANK YOU AND HOPE
THAT YOU COME BACK SOON!
`;

const parsedBombay = parseReceipt({ text: bombayText });
assert(parsedBombay.items.length === 9, `Detected all 9 food/beverage items (got ${parsedBombay.items.length})`);
assert(parsedBombay.items[0].name === 'MASALA COKE', 'Detected MASALA COKE');
assert(parsedBombay.items[4].name === 'MALABAR PARATHA' && parsedBombay.items[4].qty === 3, 'Detected 3x MALABAR PARATHA with qty 3');
assert(parsedBombay.items[4].unitPricePaise === 9000, 'MALABAR PARATHA unit price = ₹90.00 (9000 paise)');
assert(parsedBombay.subtotal === 249500, `Subtotal = ₹2,495.00 (got ${parsedBombay.subtotal})`);
assert(parsedBombay.serviceCharge === 24950, `Service Charge = ₹249.50 (got ${parsedBombay.serviceCharge})`);
assert(parsedBombay.total === 327500, `Gross Total = ₹3,275.00 (got ${parsedBombay.total})`);

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
