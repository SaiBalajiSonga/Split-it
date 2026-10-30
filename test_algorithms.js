import { parseReceipt, validateTotal, cleanItemName } from './src/logic/receiptParser.js';
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
assert(parsedBombay.roundoff === 76, `Adjustments = ₹0.76 (76 paise) (got ${parsedBombay.roundoff})`);
assert(parsedBombay.total === 327500, `Gross Total = ₹3,275.00 (got ${parsedBombay.total})`);

const val = validateTotal(parsedBombay);
assert(val.valid === true, `Validation passes with ₹0 discrepancy (${val.message})`);

// Ensure noisy table header lines are never parsed as items
const noiseReceipt = parseReceipt({
  text: `
BILL NO: 00047224 TABLE : 20 120.00
STL No i0002T224 TABLE 120.00
1 MASALA COKE 200.00
Total: 200.00
`
});
assert(noiseReceipt.items.length === 1, `Noisy table header rejected: exactly 1 item parsed (got ${noiseReceipt.items.length})`);
assert(noiseReceipt.items[0].name === 'MASALA COKE', 'Item is MASALA COKE');

console.log('\n[8] Real-world Multi-Line Receipt (Absolute Barbecues):');
const abText = `
Absolute Barbecues
AB's-POWAI
Absolute Barbeque Pvt Ltd
1st Floor, ATL Corporate Park, Saki Vihar
Road, Powai,
Mumbai, Maharashtra - 400072
FoodandBeverages

DRAFT Invoice (Split 1-FoodandBeverages)

E1 (Pax - 8)

Vedant

DRAFT Invoice GABSPMY2679943 items (8 Qty)
Oct 04 2026 11:08 PM Cashier AB's

Masala Margarita
1 @ 169/ea 169.00
Water Btl
3 @ 20/ea 60.00
TT Dinner sun nvg
4 @ 999.75/ea 3,999.00

Sub Total 4,228.00
CGST 2.5 2.5% on 4,228.00 105.70
SGST 2.5 2.5% on 4,228.00 105.70

Bill Total 4,439.40

scd
`;

const parsedAB = parseReceipt({ text: abText });
assert(parsedAB.items.length === 3, `Detected all 3 food/beverage items (got ${parsedAB.items.length})`);
assert(parsedAB.items[0].name === 'Masala Margarita' && parsedAB.items[0].qty === 1 && parsedAB.items[0].totalPaise === 16900, 'Detected Masala Margarita qty 1 @ ₹169');
assert(parsedAB.items[1].name === 'Water Btl' && parsedAB.items[1].qty === 3 && parsedAB.items[1].totalPaise === 6000, 'Detected Water Btl qty 3 @ ₹20 (₹60 total)');
assert(parsedAB.items[2].name === 'TT Dinner sun nvg' && parsedAB.items[2].qty === 4 && parsedAB.items[2].totalPaise === 399900, 'Detected TT Dinner qty 4 @ ₹999.75 (₹3,999 total)');
assert(parsedAB.taxes.length === 2, `Detected 2 GST taxes (got ${parsedAB.taxes.length})`);
assert(parsedAB.taxes[0].name.includes('CGST') && parsedAB.taxes[0].amountPaise === 10570, 'Detected CGST 2.5% ₹105.70');
assert(parsedAB.taxes[1].name.includes('SGST') && parsedAB.taxes[1].amountPaise === 10570, 'Detected SGST 2.5% ₹105.70');
assert(parsedAB.subtotal === 422800, `Subtotal = ₹4,228.00 (got ${parsedAB.subtotal})`);
assert(parsedAB.total === 443940, `Bill Total = ₹4,439.40 (got ${parsedAB.total})`);

const valAB = validateTotal(parsedAB);
assert(valAB.valid === true, `Validation passes with ₹0 discrepancy (${valAB.message})`);

console.log('\n[9] Item Name Artifact Cleaning & Symbol Stripping:');
assert(cleanItemName(': Masala Margarita') === 'Masala Margarita', 'Strips leading colon from ": Masala Margarita"');
assert(cleanItemName('¥ Water Btl') === 'Water Btl', 'Strips leading yen symbol from "¥ Water Btl"');
assert(cleanItemName('4" 17 Dinner sun nvg') === 'TT Dinner sun nvg', 'Strips 4" and repairs TT in "4" 17 Dinner sun nvg"');
assert(cleanItemName('1. MASALA COKE') === 'MASALA COKE', 'Strips leading index from "1. MASALA COKE"');
assert(cleanItemName('- Chicken Biryani') === 'Chicken Biryani', 'Strips leading dash from "- Chicken Biryani"');
assert(cleanItemName('• Garlic Naan') === 'Garlic Naan', 'Strips leading bullet from "• Garlic Naan"');
assert(cleanItemName('7 Up') === '7 Up', 'Preserves legitimate brand name "7 Up"');

// Test end-to-end receipt parsing with dirty OCR output
const dirtyReceipt = parseReceipt({
  text: `
: Masala Margarita
1 @ 169/ea 169.00
¥ Water Btl
3 @ 20/ea 60.00
4" 17 Dinner sun nvg
4 @ 999.75/ea 3,999.00
Total: 4228.00
`
});
assert(dirtyReceipt.items[0].name === 'Masala Margarita', `Dirty item 1 cleaned: "${dirtyReceipt.items[0].name}"`);
assert(dirtyReceipt.items[1].name === 'Water Btl', `Dirty item 2 cleaned: "${dirtyReceipt.items[1].name}"`);
assert(dirtyReceipt.items[2].name === 'TT Dinner sun nvg', `Dirty item 3 cleaned: "${dirtyReceipt.items[2].name}"`);

console.log('\n[10] Strict Noise & Random Code Elimination:');
const noisyTerminalReceipt = `
========================================
       SUPER BISTRO & RETAIL
   12/A HIGHWAY PLAZA, MUMBAI 400072
GSTIN: 27AABCU9603R1ZM | FSSAI: 11516034000372
========================================
ORDER #9042 | DINE IN | TABLE: 14 | PAX: 3
CAPTAIN: RAMESH | CASHIER: PRIYA | SHIFT: 1
DATE: 30/10/2026 08:45 PM | POS: 02
----------------------------------------
BARCODE: 8901030381029
ITEM DESCRIPTION          QTY    AMOUNT
----------------------------------------
Paneer Tikka               1     250.00
Butter Garlic Naan         2      90.00
Fresh Lime Soda            2      80.00
INV-2026-90428             1     150.00
GABSPMY2679943             1     200.00
8901030381029              1     100.00
----------------------------------------
Sub Total: 420.00
CGST 2.5%: 10.50
SGST 2.5%: 10.50
TOTAL AMOUNT: 441.00
----------------------------------------
PAYMENT: VISA DEBIT
CARD: ************4821
AUTH CODE: 092831 | TID: 90283401
AID: A0000000041010 | RRN: 9283471029
BATCH: 000142 | TRACE: 009214
CUSTOMER COPY | CHIP READ
WWW.SUPERBISTRO.COM
THANK YOU! VISIT AGAIN
`;

const parsedNoisy = parseReceipt({ text: noisyTerminalReceipt });
assert(parsedNoisy.items.length === 3, `Extracted exactly 3 genuine items, rejected all random codes/metadata (got ${parsedNoisy.items.length})`);
assert(parsedNoisy.items[0].name === 'Paneer Tikka', `Item 1 is Paneer Tikka (got "${parsedNoisy.items[0]?.name}")`);
assert(parsedNoisy.items[1].name === 'Butter Garlic Naan', `Item 2 is Butter Garlic Naan (got "${parsedNoisy.items[1]?.name}")`);
assert(parsedNoisy.items[2].name === 'Fresh Lime Soda', `Item 3 is Fresh Lime Soda (got "${parsedNoisy.items[2]?.name}")`);
assert(parsedNoisy.subtotal === 42000, `Subtotal = ₹420.00 (got ${parsedNoisy.subtotal})`);
assert(parsedNoisy.total === 44100, `Grand Total = ₹441.00 (got ${parsedNoisy.total})`);

console.log('\n[11] Automatic Item Categorization (Tier 2 Requirement):');
assert(parsedNoisy.items[0].category === 'Food', `Paneer Tikka categorized as Food (got "${parsedNoisy.items[0]?.category}")`);
assert(parsedNoisy.items[1].category === 'Food', `Butter Garlic Naan categorized as Food (got "${parsedNoisy.items[1]?.category}")`);
assert(parsedNoisy.items[2].category === 'Food', `Fresh Lime Soda categorized as Food (got "${parsedNoisy.items[2]?.category}")`);
assert(parsedAB.items[1].category === 'Groceries', `Water Btl categorized as Groceries (got "${parsedAB.items[1]?.category}")`);

const groceryReceipt = parseReceipt({
  text: `
Milk Carton 60.00
Eggs 12pk 95.00
Bread Loaf 45.00
Uber Airport Cab 650.00
Cinema Tickets IMAX 700.00
Wi-Fi Monthly Bill 999.00
Office Pen Set 120.00
Total: 2669.00
`
});
assert(groceryReceipt.items.find(i => i.name.includes('Milk'))?.category === 'Groceries', 'Milk -> Groceries');
assert(groceryReceipt.items.find(i => i.name.includes('Eggs'))?.category === 'Groceries', 'Eggs -> Groceries');
assert(groceryReceipt.items.find(i => i.name.includes('Uber'))?.category === 'Travel', 'Uber -> Travel');
assert(groceryReceipt.items.find(i => i.name.includes('Cinema'))?.category === 'Entertainment', 'Cinema -> Entertainment');
assert(groceryReceipt.items.find(i => i.name.includes('Wi-Fi'))?.category === 'Utilities', 'Wi-Fi -> Utilities');
assert(groceryReceipt.items.find(i => i.name.includes('Pen'))?.category === 'Other', 'Pen -> Other');

console.log(`\n[12] Noisy Real-World Bombay Canteen OCR with Specular Highlights & Margin Noise:`);
const noisyBombayOCR = `FHEREPRINT*##
Tel /02249666666 Rs
THE BOMBAY CANTEEN oat
INDIAN CAFE & BAR fe ass
Facebook /thebombaycanteen v fo
Twitter /bombay_canteen 9
Instagram /thebombaycanteen &
BILL NO 100047224 TABLE :20 = ok
BILL DATE :21/05/2016 COVERS:2 SEAS
BILL TIME :15:49 SHIFT Ng
QTY DESCRIPTION AMOUNT BS
<
mT Teen + ni
1 MASALA COKE 200.00 ih
1 Tz's ELIXIR 200.00 wi
1 CHETTINAD PRAWNS ALI-YOL400.00 po
1 B**F FRY 375.00 +4
3 MALABAR PARATHA 270.00
1 BARLEY SALAD 225.00 =
1 mutton curry 325.00
1 COFFEE RASGULLA 350.00
1 MANGO TRIFLE (SINGLE) 150.00
sub Total 2495.00
Service charge 10% 249.50
service Tax 5.80% 159.18
VAT ON CARB BEV 25% 55.00
VAT ON FOOD 12.5% 315.56
Adjustments 0.76
Gross Amount 3275.00
VAT NO: 27965280003v
S.T.NO: AADCH3020RSD001
CHINTU, CHHOTA AND BADA
SAY THANK YOU AND HOPE
THAT YOU COME BACK SOON!
CASHIER : ANAND`;

const noisyParsed = parseReceipt(noisyBombayOCR);
assert(noisyParsed.items.length === 9, `Detected all 9 food/beverage items despite margin noise (got ${noisyParsed.items.length})`);
assert(noisyParsed.items.find(i => i.name.includes('B**F FRY'))?.totalPaise === 37500, 'Detected B**F FRY ₹375.00');
assert(noisyParsed.items.find(i => i.name.includes('MALABAR PARATHA'))?.qty === 3, 'Detected 3x MALABAR PARATHA');
assert(noisyParsed.serviceCharge === 24950, `Detected Service Charge ₹249.50 (got ${noisyParsed.serviceCharge})`);
assert(noisyParsed.taxes.length === 3, `Detected 3 VAT/Service taxes (got ${noisyParsed.taxes.length})`);
assert(noisyParsed.roundoff === 76, `Detected Adjustments ₹0.76 (got ${noisyParsed.roundoff})`);
assert(noisyParsed.total === 327500, `Detected Gross Total ₹3,275.00 (got ${noisyParsed.total})`);
const noisyVal = validateTotal(noisyParsed);
assert(noisyVal.valid === true, `Validation passes with ₹0 discrepancy (${noisyVal.message})`);

console.log('\n[13] Fast-Food Combo Receipt & Tax-Inclusive Parsing (McDonald\x27s Malaysia):');
const mcdOCR = `
Gerbang Alaf Restaurants Sdn Bhd
Licensee of McDonald's
Level 6, Bangunan TH, Damansara Uptown3
TAX INVOICE
INV 141900016842
ORD #90 -REG #19- 18/01/2018 17:09:21
ary ITEM TOTAL
2 M SpicyDeluxe 25.40
2 M Coke
2 M Fries
1M GrilChicBgr 12.50
1 M Coke
1 M Fries
1 Small Cone 1.00
TakeOut Total {incl GST) 38.90
Total Rounded 38.90
Cash Tendered 50.00
Change 11.10
TOTAL INCLUDES 6% GST 2.20
Thank You and Please Come Again.
`;

const mcdParsed = parseReceipt(mcdOCR);
assert(mcdParsed.merchant === 'Gerbang Alaf Restaurants Sdn Bhd', `Detected merchant "${mcdParsed.merchant}"`);
assert(mcdParsed.date === '2018-01-18', `Detected date "${mcdParsed.date}"`);
assert(mcdParsed.items.length === 3, `Detected exactly 3 priced menu items (got ${mcdParsed.items.length})`);
assert(mcdParsed.items[0].name === 'M SpicyDeluxe' && mcdParsed.items[0].qty === 2 && mcdParsed.items[0].totalPaise === 2540, 'Detected 2 M SpicyDeluxe 25.40');
assert(mcdParsed.items[1].name === 'M GrilChicBgr' && mcdParsed.items[1].qty === 1 && mcdParsed.items[1].totalPaise === 1250, 'Detected 1M GrilChicBgr 12.50 with split fused qty');
assert(mcdParsed.items[2].name === 'Small Cone' && mcdParsed.items[2].qty === 1 && mcdParsed.items[2].totalPaise === 100, 'Detected 1 Small Cone 1.00');
assert(mcdParsed.total === 3890, `Total = 38.90 / 3890 paise (got ${mcdParsed.total})`);
assert(mcdParsed.taxes.length === 1 && mcdParsed.taxes[0].amountPaise === 220, `Detected GST 6% tax breakdown ₹2.20 (got ${mcdParsed.taxes[0]?.amountPaise})`);
assert(mcdParsed.warnings.length === 0, `No arithmetic discrepancy warnings (got ${mcdParsed.warnings.length})`);

console.log(`\n========================================`);
console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
