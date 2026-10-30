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

// Table header keywords to skip
const TABLE_HEADER_REGEX = /^(?:qty|quantity|s\.?no|#)?\s*(?:item|items|description|desc|particulars)\s*(?:qty|quantity)?\s*(?:rate|price|unit\s*price)?\s*(?:amount|total|net|val)?$/i;

// Universal Noise Patterns: addresses, postal pincodes, store metadata, phone numbers
const NOISE_KEYWORDS = /\b(pvt|ltd|limited|corporate|park|road|street|marg|vihar|nagar|floor|complex|bldg|building|tower|mumbai|delhi|bangalore|bengaluru|hyderabad|chennai|pune|kolkata|ahmedabad|maharashtra|karnataka|gujarat|india|pincode|pin\s*code|pin\s*-\s*\d|[1-9]\d{5}\b|draft\b|invoice\b|bill\s*n[ou]|order\b|token\b|covers?\b|shift\b|pax\b|cashier\b|server\b|waiter\b|captain\b|guest\b|station\b|terminal\b|table\b|foodandbeverages|f\s*&\s*b|gstin|fssai|tin\s*n[ou]|cin\b|pan\b|s\.?t\.?\s*n[ou]|vat\s*no|vat\s*reg|address|phone|tel|mob|fax|email|thank|welcome|visit|www\.|\.com|\.in|duplicate|original|reprint|e\s*&\s*o\.?e|customer\s*copy|have\s*a\s*nice|come\s*again|feedback|rate\s*us|scan\s*to|upi|paytm|gpay)\b/i;

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

  const items = [];
  const taxes = [];
  let subtotal = null;
  let total = null;
  let serviceCharge = null;
  let discount = null;
  let roundoff = 0;
  const usedLines = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (usedLines.has(i)) continue;
    const line = lines[i];
    const text = (line.text || '').trim();
    
    // Skip empty / very short lines
    if (!text || text.length < 2) continue;
    
    // Skip lines that are just numbers/dates/dashes
    if (JUST_NUMBERS.test(text) || JUST_DASHES.test(text)) continue;

    // Skip table header lines like "QTY DESCRIPTION AMOUNT"
    if (TABLE_HEADER_REGEX.test(text)) continue;

    // Check for grand total (do this first — total keywords can overlap with subtotal)
    if (TOTAL_KEYWORDS.test(text) && !SUBTOTAL_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        total = price;
      }
      continue;
    }

    // Check for subtotal
    if (SUBTOTAL_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        subtotal = price;
      }
      continue;
    }

    // Check for service charge
    if (SERVICE_CHARGE_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        serviceCharge = price;
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
      }
      continue;
    }

    // Check for discount
    if (DISCOUNT_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        discount = price;
      }
      continue;
    }

    // Check for round-off & adjustments
    if (ROUNDOFF_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        const isNegative = /-\s*\d|minus|\(less\)/i.test(text);
        roundoff = isNegative ? -price : price;
      }
      continue;
    }

    // Skip noise lines (addresses, pincodes, draft invoices, store metadata)
    if (NOISE_KEYWORDS.test(text)) continue;

    // --- TWO-LINE ITEM CHECK (Rate line with /ea or @) ---
    // e.g. "1@ 169/ea 169.00 ~" or "! 38 20/ea 60.00" or "4 4 999.75/ea 3,999.00"
    const lower = text.toLowerCase();
    const eaIdx = lower.indexOf('/ea');
    if (eaIdx !== -1 && i > 0) {
      const before = text.substring(0, eaIdx).trim();
      const after = text.substring(eaIdx + 3).trim();

      const afterMatch = after.match(/(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)/);
      const lineTotal = afterMatch ? parsePaise(afterMatch[1]) : 0;

      const beforeMatch = before.match(/(\d+(?:\.\d{1,2})?)\s*$/);
      const unitPrice = beforeMatch ? parsePaise(beforeMatch[1]) : 0;

      if (lineTotal > 0) {
        let prevIdx = i - 1;
        while (prevIdx >= 0 && (usedLines.has(prevIdx) || (lines[prevIdx].text || lines[prevIdx] || '').trim().length === 0 || NOISE_KEYWORDS.test(lines[prevIdx].text || lines[prevIdx] || ''))) {
          prevIdx--;
        }
        if (prevIdx >= 0) {
          let candidateName = (lines[prevIdx].text || lines[prevIdx] || '').trim();
          candidateName = candidateName.replace(/\s+\d+\s*$/, '').trim();
          candidateName = cleanItemName(candidateName);

          if (candidateName.length >= 2 && !NOISE_KEYWORDS.test(candidateName)) {
            const qty = unitPrice > 0 ? Math.round(lineTotal / unitPrice) : 1;
            items.push({
              id: generateId(),
              name: candidateName,
              qty: qty > 0 ? qty : 1,
              unitPricePaise: unitPrice || Math.round(lineTotal / (qty || 1)),
              totalPaise: lineTotal,
              category: null,
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
    
    if (name && lineTotal > 0 && !NOISE_KEYWORDS.test(name)) {
      return {
        id: generateId(),
        name,
        qty,
        unitPricePaise: unitPrice,
        totalPaise: lineTotal,
        category: null,
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
    }
  }

  let name = cleanItemName(nameText);

  // Skip if name is empty or too short or looks like a total/header/roundoff/noise
  if (!name || name.length < 2) return null;
  if (TOTAL_KEYWORDS.test(name) || TAX_KEYWORDS.test(name) || TABLE_HEADER_REGEX.test(name) || ROUNDOFF_KEYWORDS.test(name) || SERVICE_CHARGE_KEYWORDS.test(name) || NOISE_KEYWORDS.test(name)) return null;

  return {
    id: generateId(),
    name,
    qty,
    unitPricePaise,
    totalPaise,
    category: null,
    assignees: [],
    confidence: getLineConfidence(ocrLine),
  };
}

/**
 * Clean up an item name from OCR artifacts.
 */
function cleanItemName(name) {
  if (!name) return '';
  return name
    .replace(/^[\s.\-#)]+/, '')  // Leading punctuation, dots, hashes, brackets (keep alphanumeric)
    .replace(/\s{2,}/g, ' ')        // Multiple spaces
    .replace(/[|\\]/g, '')          // OCR artifacts
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
