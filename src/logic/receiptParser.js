/**
 * Receipt Parser — Converts raw Tesseract.js OCR output into structured receipt data.
 * 
 * STRATEGY:
 * 1. Analyze each OCR line for item patterns
 * 2. Detect prices via regex (right-aligned numbers like ₹123.45 or 123.00)
 * 3. Detect quantity patterns: "2 x", "x2", "Qty: 2"
 * 4. Identify tax lines by keywords: GST, CGST, SGST, Tax, Service Charge
 * 5. Identify totals, subtotals, discounts
 * 6. Filter noise: addresses, GSTIN, phone numbers, footer text
 * 
 * All monetary values are stored as integers in PAISE (1 rupee = 100 paise)
 * to avoid floating-point errors.
 */

import { generateId } from '../db/database.js';
import { classifyItemFast } from './categorizer.js';

// ===== REGEX PATTERNS =====

// Matches a price at or near the end of a line (allows optional short trailing OCR noise like "200.00 ha", "225.00 Bo", "325.00 v", "360.00 |")
// Uses negative lookbehind (?<!\d) so it never slices the tail of an alphanumeric ID or phone number
const PRICE_REGEX = /(?:₹|rs\.?|inr\.?|rupees?)?\s*(?<!\d)(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)\s*(?:[a-zA-Z]{1,5}|[^\w\s]{1,5})?\s*$/i;

// Matches a price anywhere in the line
const PRICE_ANYWHERE = /(?:₹|rs\.?|inr\.?)\s*(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)/gi;

// Quantity patterns
const QTY_REGEX = /(?:^|\s)(\d+)\s*[xX×]\s*|[xX×]\s*(\d+)(?:\s|$)|(?:qty|quantity)\s*[:.]?\s*(\d+)/i;

// Two-number pattern: "2 x 150.00 300.00" or "2 150 300"
const QTY_PRICE_TOTAL = /(\d+)\s*[xX×]?\s*(?:₹|rs\.?|inr\.?)?\s*(\d+(?:\.\d{1,2})?)\s+(?:₹|rs\.?|inr\.?)?\s*(\d+(?:\.\d{1,2})?)\s*(?:[a-zA-Z]{1,5}|[^\w\s]{1,5})?\s*$/i;

// Tax keywords (including CGST, SGST, SGT, IGST, VAT, Service Tax, and '% on' phrases)
const TAX_KEYWORDS = /\b(c\.?g\.?s\.?t|s\.?g\.?s\.?t|i\.?g\.?s\.?t|g\.?s\.?t|sgt\b|cgst\b|sgst\b|ses[t1]\b|service\s*tax|tax|vat)\b|%\s*on\b/i;

// Service charge (note: Service Tax is a tax, not a service charge)
const SERVICE_CHARGE_KEYWORDS = /\b(service\s*charge|s\.?\s*charge|svc\s*chg)\b/i;

// Total keywords (handles OCR variants like Tota), Tota1, Totl)
const TOTAL_KEYWORDS = /\b(grand\s*tota[l1I\)]|gross\s*amount|gross\s*tota[l1I\)]|bill\s*tota[l1I\)]|net\s*tota[l1I\)]|total\s*amount|amount\s*due|bill\s*amount|total\s*payable|amount\s*payable|net\s*payable|balance\s*due|final\s*tota[l1I\)]|invoice\s*tota[l1I\)]|tota[l1I\)])/i;

// Subtotal keywords
const SUBTOTAL_KEYWORDS = /\b(sub\s*-?\s*tota[l1I\)]|item\s*tota[l1I\)]|food\s*tota[l1I\)]|items?\s*sub\s*tota[l1I\)])/i;

// Discount keywords
const DISCOUNT_KEYWORDS = /\b(discount|disc\.?|off|savings|offer|promo|coupon)\b/i;

// Round off & adjustments
const ROUNDOFF_KEYWORDS = /\b(round\s*off|rounding|adj\.?|adjustments?)\b/i;

// Table header keywords to skip (matches traditional tabular headers like "ITEM QTY RATE AMOUNT")
const TABLE_HEADER_REGEX = /(?:^(?:qty|quantity|s\.?no|#)?\s*(?:item|items|description|desc|particulars)\s*(?:qty|quantity)?\s*(?:rate|price|unit\s*price)?\s*(?:amount|total|net|val)?$|\b(?:item|items|description|desc|particulars)\b.*\b(?:qty|quantity|rate|price|amount|total|val)\b)/i;

// Universal Noise Patterns: addresses, postal pincodes, store metadata, phone numbers, POS terminals, payment tenders
const NOISE_KEYWORDS = /\b(pvt|ltd|limited|corporate|park|road|street|marg|vihar|nagar|floor|complex|bldg|building|tower|mall|plaza|avenue|lane|highway|sector|phase|block|opp\.?|near\b|mumbai|delhi|bangalore|bengaluru|hyderabad|chennai|pune|kolkata|ahmedabad|maharashtra|karnataka|gujarat|india|pincode|pin\s*code|pin\s*-\s*\d|[1-9]\d{5}\b|draft\b|invoice\b|bill\s*n[ou]|order\s*#|order\s*n[ou]|token\b|covers?\b|shift\b|pax\b|cashier\b|server\b|waiter\b|captain\b|steward\b|host\b|hostess\b|guest\b|counter\b|outlet\b|branch\b|station\b|terminal\b|table\b|foodandbeverages|f\s*&\s*b|gstin|fssai|tin\s*n[ou]|cin\b|pan\b|s\.?t\.?\s*n[ou]|vat\s*no|vat\s*reg|hsn\b|sac\b|address|phone|tel|mob|fax|email|thank|welcome|visit|www\.|\.com|\.in|duplicate|original|reprint|e\s*&\s*o\.?e|customer\s*copy|merchant\s*copy|have\s*a\s*nice|come\s*again|feedback|rate\s*us|scan\s*to|upi|paytm|gpay|phonepe|visa\b|mastercard\b|amex\b|rupay\b|card\s*ending|chip\s*read|swipe|auth\s*code|appr\s*code|rrn\b|aid\b|mid\b|tid\b|batch\b|trace\b|txn\b|kpt\b|kot\b|dine\s*in|take\s*away|parcel|delivery|wi-?fi\s*(?:pass|key|network|code)|free\s*wi-?fi|password\b|goods\s*once\s*sold|subject\s*to|jurisdiction)\b/i;

// Matches random alphanumeric codes, hashes, serial numbers, barcodes (10-18 digits), or multi-part reference codes
const RANDOM_CODE_REGEX = /\b(?:(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}|[A-Z0-9]{2,}[-#/][A-Z0-9]{2,}[-#/][A-Z0-9]{2,}|\d{10,18})\b/i;

// Matches timestamps and dates (e.g. 11:08 PM, 15:49, 21/05/2016, Oct 04 2026)
const DATE_TIME_REGEX = /\b(?:\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{2,4})\b/i;

// Lines that are just numbers/dates
const JUST_NUMBERS = /^\s*[\d\s/\-.:,]+\s*$/;
const JUST_DASHES = /^[\s\-=_*#.]+$/;


/**
 * Parse raw OCR output into structured receipt data.
 * @param {Object|string} ocrResult — Tesseract.js recognition result or text string
 * @returns {Object} { items, subtotal, taxes, serviceCharge, discount, total, rawText }
 */
export function parseReceipt(ocrResult) {
  let lines = [];
  if (Array.isArray(ocrResult?.lines) && ocrResult.lines.length > 0) {
    lines = ocrResult.lines;
  } else if (ocrResult?.blocks && Array.isArray(ocrResult.blocks)) {
    lines = ocrResult.blocks.flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
  }

  // Universal text fallback: split text by newline
  const rawText = typeof ocrResult === 'string'
    ? ocrResult
    : (ocrResult?.text || (Array.isArray(ocrResult) ? ocrResult.join('\n') : ''));

  if (lines.length === 0 && rawText) {
    lines = rawText
      .split(/\r?\n/)
      .map(t => ({ text: t.trim(), words: [] }))
      .filter(l => l.text.length > 0);
  }

  // Spatial Line Ordering: If lines have vertical coordinates (bbox.y0), sort top-to-bottom
  if (lines.length > 0 && lines[0]?.bbox?.y0 !== undefined) {
    lines.sort((a, b) => (a.bbox?.y0 || 0) - (b.bbox?.y0 || 0));
  }

  const items = [];
  const taxes = [];
  let subtotal = null;
  let total = null;
  let serviceCharge = null;
  let discount = null;
  let roundoff = 0;
  const usedLines = new Set();

  // ===== 1. ZONE SEGMENTATION =====
  // Professional Receipt Architecture isolates the receipt into 3 zones:
  // Zone 1: Header (Store name, addresses, GSTIN, invoice/table metadata)
  // Zone 2: Line Items Body (Item names, quantities, unit prices, line totals)
  // Zone 3: Financial Summary (Subtotal, taxes, charges, roundoff, grand total)

  let bodyStartIndex = 0;
  let summaryStartIndex = lines.length;

  // Find summaryStartIndex (first financial summary keyword)
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i].text || '').trim();
    if (SUBTOTAL_KEYWORDS.test(text) || (TOTAL_KEYWORDS.test(text) && !/covers|pax|items?\s*\(\d+\s*qty\)/i.test(text))) {
      summaryStartIndex = i;
      break;
    }
  }

  // Find bodyStartIndex: Skip lines until table header or dashed separator,
  // or skip initial consecutive header metadata lines BEFORE any line item.
  let foundFirstItemOrPrice = false;
  for (let i = 0; i < summaryStartIndex; i++) {
    const text = (lines[i].text || '').trim();
    if (TABLE_HEADER_REGEX.test(text) || /^[-=_.]{4,}$/.test(text)) {
      bodyStartIndex = i + 1;
      foundFirstItemOrPrice = false;
    } else if (!foundFirstItemOrPrice && (NOISE_KEYWORDS.test(text) || DATE_TIME_REGEX.test(text) || RANDOM_CODE_REGEX.test(text))) {
      bodyStartIndex = i + 1;
    } else if (PRICE_REGEX.test(text)) {
      foundFirstItemOrPrice = true;
    }
  }

  // Safety fallback if boundaries collapsed
  if (bodyStartIndex >= summaryStartIndex) {
    bodyStartIndex = 0;
  }

  // ===== 2. PASS 1: EXTRACT TAXES, CHARGES & TOTALS =====
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = (line.text || '').trim();
    if (!text || text.length < 2) continue;
    if (TABLE_HEADER_REGEX.test(text) || JUST_DASHES.test(text)) continue;

    // Check for grand total
    if (TOTAL_KEYWORDS.test(text) && !SUBTOTAL_KEYWORDS.test(text) && !/covers|pax|items?\s*\(\d+\s*qty\)/i.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        total = price;
        usedLines.add(i);
      }
      continue;
    }

    // Check for subtotal
    if (SUBTOTAL_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        subtotal = price;
        usedLines.add(i);
      }
      continue;
    }

    // Check for service charge
    if (SERVICE_CHARGE_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        serviceCharge = price;
        usedLines.add(i);
      }
      continue;
    }

    // Check for tax lines (exclude registration numbers like VAT NO, GSTIN, TIN NO, S.T.NO, and headers)
    if (TAX_KEYWORDS.test(text) && !/\b(vat\s*n[ou]|tin\s*n[ou]|gstin|s\.?t\.?\s*n[ou]|cin\b|pan\b|invoice\b)\b/i.test(text) && !NOISE_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null && price < 5000000) {
        let taxName = 'Tax';
        if (text.match(/cgst|c\.g\.s\.t/i)) taxName = 'CGST';
        else if (text.match(/sgst|s\.g\.s\.t|sgt\b|ses[t1]\b/i)) taxName = 'SGST';
        else if (text.match(/vat/i)) taxName = 'VAT';
        else if (text.match(/service\s*tax/i)) taxName = 'Service Tax';
        else taxName = 'Tax';

        const rateMatch = text.match(/(?:2\.5|5|6|9|12|18|28|\d(?:\.\d+)?)\s*%/i);
        if (rateMatch) {
          taxName += ` ${rateMatch[0].trim()}`;
        }
        taxes.push({ name: taxName, amountPaise: price });
        usedLines.add(i);
      }
      continue;
    }

    // Check for discount
    if (DISCOUNT_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        discount = price;
        usedLines.add(i);
      }
      continue;
    }

    // Check for round-off & adjustments
    if (ROUNDOFF_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        const isNegative = /-\s*\d|minus|\(less\)/i.test(text);
        roundoff = isNegative ? -price : price;
        usedLines.add(i);
      }
      continue;
    }
  }

  // ===== 3. PASS 2: EXTRACT LINE ITEMS (STRICTLY IN ZONE 2) =====
  for (let i = bodyStartIndex; i < summaryStartIndex; i++) {
    if (usedLines.has(i)) continue;
    const line = lines[i];
    const text = (line.text || '').trim();

    // Skip empty / very short lines / dashes / numbers
    if (!text || text.length < 2) continue;
    if (JUST_NUMBERS.test(text) || JUST_DASHES.test(text)) continue;
    if (TABLE_HEADER_REGEX.test(text)) continue;

    // Skip metadata noise & random codes
    if (NOISE_KEYWORDS.test(text) || RANDOM_CODE_REGEX.test(text) || DATE_TIME_REGEX.test(text)) continue;

    // --- TWO-LINE ITEM CHECK (Rate line with /ea or @) ---
    // e.g. "1@ 169/ea 169.00 ~" or "! 38 20/ea 60.00" or "4 4 999.75/ea 3,999.00"
    const lower = text.toLowerCase();
    const eaIdx = lower.indexOf('/ea');
    if (eaIdx !== -1 && i > bodyStartIndex) {
      const before = text.substring(0, eaIdx).trim();
      const after = text.substring(eaIdx + 3).trim();

      const afterMatch = after.match(/(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)/);
      const lineTotal = afterMatch ? parsePaise(afterMatch[1]) : 0;

      const beforeMatch = before.match(/(\d+(?:\.\d{1,2})?)\s*$/);
      const unitPrice = beforeMatch ? parsePaise(beforeMatch[1]) : 0;

      if (lineTotal > 0) {
        let prevIdx = i - 1;
        while (prevIdx >= bodyStartIndex && (usedLines.has(prevIdx) || (lines[prevIdx].text || lines[prevIdx] || '').trim().length === 0 || NOISE_KEYWORDS.test(lines[prevIdx].text || lines[prevIdx] || ''))) {
          prevIdx--;
        }
        if (prevIdx >= bodyStartIndex) {
          let candidateName = (lines[prevIdx].text || lines[prevIdx] || '').trim();
          candidateName = candidateName.replace(/\s+\d+\s*$/, '').trim();
          candidateName = cleanItemName(candidateName);

          if (candidateName.length >= 2 && !NOISE_KEYWORDS.test(candidateName) && !RANDOM_CODE_REGEX.test(candidateName)) {
            const qty = unitPrice > 0 ? Math.round(lineTotal / unitPrice) : 1;
            items.push({
              id: generateId(),
              name: candidateName,
              qty: qty > 0 ? qty : 1,
              unitPricePaise: unitPrice || Math.round(lineTotal / (qty || 1)),
              totalPaise: lineTotal,
              category: classifyItemFast(candidateName),
              assignees: [],
              confidence: getLineConfidence(lines[prevIdx]),
            });
            usedLines.add(prevIdx);
            usedLines.add(i);
            continue;
          }
        }
      }
    }

    // Try to parse as single-line item
    const item = parseLineItem(text, line);
    if (item) {
      item.category = classifyItemFast(item.name);
      items.push(item);
      usedLines.add(i);
    }
  }

  // Robust total calculation & sanity check
  const itemsTotal = items.reduce((sum, item) => sum + item.totalPaise, 0);
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amountPaise, 0);
  const sc = serviceCharge || 0;
  const disc = discount || 0;
  const computed = itemsTotal + taxTotal + sc - disc + roundoff;

  // If detected total is missing or completely unreasonable (< subtotal), auto-correct to computed!
  if (total === null || (subtotal && total < subtotal) || (itemsTotal > 0 && total < itemsTotal)) {
    total = computed;
  }

  return {
    items,
    subtotal: subtotal || itemsTotal,
    taxes,
    serviceCharge,
    discount,
    roundoff,
    total,
    rawText,
  };
}

/**
 * Try to parse a line of text as a line item.
 * Returns null if it doesn't look like an item.
 */
function parseLineItem(text, ocrLine) {
  // First try the qty × unitPrice = total pattern
  const qptMatch = text.match(QTY_PRICE_TOTAL);
  if (qptMatch) {
    const qty = parseInt(qptMatch[1], 10);
    const unitPrice = parsePaise(qptMatch[2]);
    const lineTotal = parsePaise(qptMatch[3]);
    
    // Extract item name (everything before the numbers)
    const nameEnd = text.indexOf(qptMatch[0]);
    let name = text.substring(0, nameEnd).trim();
    name = cleanItemName(name);
    
    if (name && lineTotal > 0 && !NOISE_KEYWORDS.test(name) && !RANDOM_CODE_REGEX.test(name) && /[a-zA-Z]/.test(name)) {
      return {
        id: generateId(),
        name,
        qty,
        unitPricePaise: unitPrice,
        totalPaise: lineTotal,
        category: classifyItemFast(name),
        assignees: [],
        confidence: getLineConfidence(ocrLine),
      };
    }
  }

  // Try to extract a price from the end of the line
  const priceMatch = text.match(PRICE_REGEX);
  if (!priceMatch) return null;

  const rawPriceStr = priceMatch[1];
  const totalPaise = parsePaise(rawPriceStr);
  if (totalPaise <= 0) return null;

  // Discard speck noise:
  // 1. Single digit integers without decimal point (< ₹10 / 1000 paise) are speck noise/table numbers
  const hasDecimal = /\.\d{1,2}/.test(rawPriceStr);
  const hasCurrency = /(?:₹|rs\.?|inr\.?)/i.test(text);
  if (totalPaise < 1000 && !hasDecimal && !hasCurrency) {
    return null;
  }

  // 2. Discard amounts > ₹50,000 (pincodes, phone numbers)
  if (totalPaise > 5000000) {
    return null;
  }

  // Everything before the price is the item name (possibly with quantity)
  let nameText = text.substring(0, text.lastIndexOf(priceMatch[1])).trim();
  
  // Remove trailing currency symbols
  nameText = nameText.replace(/[₹$€£]\s*$/, '').trim();
  nameText = nameText.replace(/\s*[-–—:]\s*$/, '').trim();

  // Try to find quantity
  let qty = 1;
  let unitPricePaise = totalPaise;

  // Pattern A: Leading quantity e.g. "1 MASALA COKE", "3 MALABAR PARATHA"
  const leadingQtyMatch = nameText.match(/^(\d{1,3})\s+(?=[A-Za-z])/);
  if (leadingQtyMatch) {
    const q = parseInt(leadingQtyMatch[1], 10);
    if (q > 0 && q < 100) {
      qty = q;
      unitPricePaise = Math.round(totalPaise / qty);
      nameText = nameText.substring(leadingQtyMatch[0].length).trim();
    }
  } else {
    // Pattern B: Trailing or inline quantity e.g. "Naan 2x", "Coke x2", "Qty: 2"
    const qtyMatch = nameText.match(QTY_REGEX);
    if (qtyMatch) {
      qty = parseInt(qtyMatch[1] || qtyMatch[2] || qtyMatch[3], 10);
      if (qty > 0 && qty < 100) {
        unitPricePaise = Math.round(totalPaise / qty);
        nameText = nameText.replace(QTY_REGEX, ' ').trim();
      } else {
        qty = 1;
      }
    } else {
      // Pattern C: Trailing standalone quantity column e.g. "Paneer Tikka 1", "Butter Garlic Naan 2"
      const trailingQtyMatch = nameText.match(/\s+(\d{1,2})$/);
      if (trailingQtyMatch) {
        const q = parseInt(trailingQtyMatch[1], 10);
        if (q > 0 && q < 50) {
          qty = q;
          unitPricePaise = Math.round(totalPaise / qty);
          nameText = nameText.substring(0, trailingQtyMatch.index).trim();
        }
      }
    }
  }

  let name = cleanItemName(nameText);

  // Skip if name is empty, too short, or lacks any alphabetic characters (e.g. pure numbers/dates/barcodes)
  if (!name || name.length < 2 || !/[a-zA-Z]/.test(name)) return null;

  // Discard OCR noise/creases/staple marks (low alphanumeric character density)
  const alphaNumCount = (name.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphaNumCount < 2 || (alphaNumCount / name.replace(/\s+/g, '').length) < 0.6) {
    return null;
  }

  // Skip if name looks like a total, tax, table header, roundoff, charge, noise, date, or random code
  if (
    TOTAL_KEYWORDS.test(name) ||
    TAX_KEYWORDS.test(name) ||
    TABLE_HEADER_REGEX.test(name) ||
    ROUNDOFF_KEYWORDS.test(name) ||
    SERVICE_CHARGE_KEYWORDS.test(name) ||
    NOISE_KEYWORDS.test(name) ||
    RANDOM_CODE_REGEX.test(name) ||
    DATE_TIME_REGEX.test(name)
  ) {
    return null;
  }

  return {
    id: generateId(),
    name,
    qty,
    unitPricePaise,
    totalPaise,
    category: classifyItemFast(name),
    assignees: [],
    confidence: getLineConfidence(ocrLine),
  };
}

/**
 * Clean up an item name from OCR artifacts.
 * Strips leading non-alphanumeric noise (e.g. colons ':', currency '¥', quotes '"', bullets '•'),
 * removes stray leading item index numbers (e.g. '4"', '1.'), and resolves common thermal font OCR confusions.
 */
export function cleanItemName(name) {
  if (!name) return '';
  return name
    // 1. Strip leading non-alphanumerics (symbols, colons, currency symbols, quotes, bullets, punctuation)
    .replace(/^[^a-zA-Z0-9]+/, '')
    // 2. Strip stray leading item numbers / OCR quote artifacts (e.g. '4" ', '1. ', '2) ', '3- ')
    .replace(/^\d+["'`\-\.\):#*~]+\s*/, '')
    // 3. Resolve common thermal dot-matrix font confusion (e.g. '17 Dinner' -> 'TT Dinner')
    .replace(/\b17\s+(Dinner|Lunch|Buffet)\b/i, (m, w) => 'TT ' + w)
    // 4. Strip any remaining leading non-alphanumerics exposed by step 2
    .replace(/^[^a-zA-Z0-9]+/, '')
    // 5. Strip trailing punctuation/smudges
    .replace(/[\s:;\-~*|/\\,]+$/, '')
    // 6. Remove OCR table separators and normalize whitespace
    .replace(/[|\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Extract price from a text line.
 */
function extractPrice(text) {
  if (!text) return null;
  // First try price at end of line: e.g. "Total: 803.00" or "Total ₹803.00" (allows trailing noise)
  const endMatch = text.match(PRICE_REGEX);
  if (endMatch) {
    return parsePaise(endMatch[1]);
  }
  // Try price anywhere with currency prefix
  const anyMatches = [...text.matchAll(PRICE_ANYWHERE)];
  if (anyMatches.length > 0) {
    const last = anyMatches[anyMatches.length - 1];
    return parsePaise(last[1]);
  }
  // Fallback: look for trailing numeric pattern (e.g., "730.00" or "803")
  const numMatch = text.match(/(?<!\d)(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)\s*(?:[a-zA-Z]{1,5}|[^\w\s]{1,5})?\s*$/);
  if (numMatch) {
    return parsePaise(numMatch[1]);
  }
  return null;
}

/**
 * Parse a numeric string to paise (integer).
 */
function parsePaise(str) {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

/**
 * Get the average confidence for a Tesseract line.
 */
function getLineConfidence(ocrLine) {
  if (!ocrLine || !ocrLine.words || ocrLine.words.length === 0) return 100;
  const sum = ocrLine.words.reduce((acc, w) => acc + (w.confidence || 0), 0);
  return Math.round(sum / ocrLine.words.length);
}

/**
 * Get per-word confidence data for highlighting.
 */
export function getWordConfidences(ocrResult) {
  const wordConfidences = [];
  if (!ocrResult.words) return wordConfidences;
  
  for (const word of ocrResult.words) {
    if (word.confidence < 70) {
      wordConfidences.push({
        text: word.text,
        confidence: Math.round(word.confidence),
        bbox: word.bbox,
      });
    }
  }
  return wordConfidences;
}

/**
 * Validate that parsed items + taxes match the total.
 */
export function validateTotal(parsedReceipt) {
  const { items, taxes, serviceCharge, discount, roundoff = 0, total } = parsedReceipt;
  
  if (total === null || total === 0) {
    return { valid: false, message: 'No total detected', difference: 0 };
  }

  const itemsTotal = items.reduce((sum, item) => sum + item.totalPaise, 0);
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amountPaise, 0);
  const sc = serviceCharge || 0;
  const disc = discount || 0;
  const ro = roundoff || 0;
  const computed = itemsTotal + taxTotal + sc - disc + ro;
  const difference = total - computed;

  if (Math.abs(difference) <= 100) { // Allow ₹1 tolerance for rounding
    return {
      valid: true,
      message: `Items + taxes + charges = ₹${formatRupees(computed)} ✓`,
      difference: 0,
      computed,
      total,
    };
  }

  return {
    valid: false,
    message: `Mismatch: computed ₹${formatRupees(computed)}, detected total ₹${formatRupees(total)} (diff ₹${formatRupees(Math.abs(difference))})`,
    difference,
    computed,
    total,
  };
}

/**
 * Format paise as rupees string.
 */
export function formatRupees(paise) {
  const rupees = Math.abs(paise) / 100;
  return rupees.toFixed(2);
}
