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

// Matches a price at the end of a line: 123.45, 1,234.00, ₹ 500
const PRICE_REGEX = /(?:₹|rs\.?|inr\.?|rupees?)?\s*(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)\s*$/i;

// Matches a price anywhere in the line
const PRICE_ANYWHERE = /(?:₹|rs\.?|inr\.?)\s*(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)/gi;

// Quantity patterns
const QTY_REGEX = /(?:^|\s)(\d+)\s*[xX×]\s*|[xX×]\s*(\d+)(?:\s|$)|(?:qty|quantity)\s*[:.]?\s*(\d+)/i;

// Two-number pattern: "2 x 150.00 300.00" or "2 150 300"
const QTY_PRICE_TOTAL = /(\d+)\s*[xX×]?\s*(?:₹|rs\.?|inr\.?)?\s*(\d+(?:\.\d{1,2})?)\s+(?:₹|rs\.?|inr\.?)?\s*(\d+(?:\.\d{1,2})?)\s*$/i;

// Tax keywords
const TAX_KEYWORDS = /\b(c\.?g\.?s\.?t|s\.?g\.?s\.?t|i\.?g\.?s\.?t|g\.?s\.?t|tax|vat)\b/i;

// Service charge
const SERVICE_CHARGE_KEYWORDS = /\b(service\s*charge|s\.?\s*charge|service\s*tax|svc\s*chg)\b/i;

// Total keywords - including gross amount and final total
const TOTAL_KEYWORDS = /\b(grand\s*total|gross\s*amount|gross\s*total|total\s*amount|net\s*total|amount\s*due|bill\s*amount|total\s*payable|amount\s*payable|net\s*payable|balance\s*due|final\s*total|total)\b/i;

// Subtotal keywords
const SUBTOTAL_KEYWORDS = /\b(sub\s*-?\s*total|item\s*total|food\s*total|items?\s*sub\s*total)\b/i;

// Discount keywords
const DISCOUNT_KEYWORDS = /\b(discount|disc\.?|off|savings|offer|promo|coupon)\b/i;

// Round off & adjustments
const ROUNDOFF_KEYWORDS = /\b(round\s*off|rounding|adj\.?|adjustments?)\b/i;

// Table header keywords to skip
const TABLE_HEADER_REGEX = /^(?:qty|quantity|s\.?no|#)?\s*(?:item|items|description|desc|particulars)\s*(?:qty|quantity)?\s*(?:rate|price|unit\s*price)?\s*(?:amount|total|net|val)?$/i;

// Noise patterns — lines to skip
const NOISE_KEYWORDS = /\b(gstin|gst\s*n[ou]|fssai|tin\s*n[ou]|s\.?t\.?\s*n[ou]|vat\s*n[ou]|vat\s*no|vat\s*reg|cin|pan|address|phone|tel|mob|fax|email|thank|welcome|visit|www\.|\.com|\.in|invoice\s*n[ou]|bill\s*n[ou]|order\s*n[ou]|token|table\s*n[ou]|covers|shift|cashier|server|waiter|captain|date|time|print|duplicate|original|reprint|e\s*&\s*o\.?e|subject\s*to|jurisdiction|customer\s*copy|have\s*a\s*nice|come\s*again|feedback|rate\s*us|scan\s*to|upi|paytm|gpay|powered\s*by)\b/i;

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = (line.text || '').trim();
    
    // Skip empty / very short lines
    if (!text || text.length < 2) continue;
    
    // Skip lines that are just numbers/dates/dashes
    if (JUST_NUMBERS.test(text) || JUST_DASHES.test(text)) continue;

    // Skip table header lines like "QTY DESCRIPTION AMOUNT"
    if (TABLE_HEADER_REGEX.test(text)) continue;

    // Skip noise lines
    if (NOISE_KEYWORDS.test(text) && !TOTAL_KEYWORDS.test(text)) continue;

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

    // Check for tax lines
    if (TAX_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        // Extract tax name
        const taxMatch = text.match(TAX_KEYWORDS);
        const taxName = taxMatch ? taxMatch[0].toUpperCase().replace(/\./g, '') : 'TAX';
        taxes.push({ name: taxName, amountPaise: price });
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

    // Check for discount
    if (DISCOUNT_KEYWORDS.test(text)) {
      const price = extractPrice(text);
      if (price !== null) {
        discount = price;
      }
      continue;
    }

    // Check for round-off & adjustments (skip)
    if (ROUNDOFF_KEYWORDS.test(text)) continue;

    // Try to parse as a line item
    const item = parseLineItem(text, line);
    if (item) {
      items.push(item);
    }
  }

  // If no total was found, compute from items + taxes
  if (total === null && items.length > 0) {
    const itemsTotal = items.reduce((sum, item) => sum + item.totalPaise, 0);
    const taxTotal = taxes.reduce((sum, tax) => sum + tax.amountPaise, 0);
    const sc = serviceCharge || 0;
    const disc = discount || 0;
    total = itemsTotal + taxTotal + sc - disc;
  }

  return {
    items,
    subtotal,
    taxes,
    serviceCharge,
    discount,
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
    
    if (name && lineTotal > 0) {
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

  const totalPaise = parsePaise(priceMatch[1]);
  if (totalPaise <= 0) return null;

  // Everything before the price is the item name (possibly with quantity)
  let nameText = text.substring(0, text.lastIndexOf(priceMatch[1])).trim();
  
  // Remove trailing currency symbols
  nameText = nameText.replace(/[₹$€£]\s*$/, '').trim();
  nameText = nameText.replace(/\s*[-–—]\s*$/, '').trim();

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

  // Skip if name is empty or too short or looks like a total/header
  if (!name || name.length < 2) return null;
  if (TOTAL_KEYWORDS.test(name) || TAX_KEYWORDS.test(name) || TABLE_HEADER_REGEX.test(name)) return null;

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
  // First try price at end of line: e.g. "Total: 803.00" or "Total ₹803.00"
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
  const numMatch = text.match(/(\d{1,7}(?:[,]\d{3})*(?:\.\d{1,2})?)\s*$/);
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
  const { items, taxes, serviceCharge, discount, total } = parsedReceipt;
  
  if (total === null || total === 0) {
    return { valid: false, message: 'No total detected', difference: 0 };
  }

  const itemsTotal = items.reduce((sum, item) => sum + item.totalPaise, 0);
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amountPaise, 0);
  const sc = serviceCharge || 0;
  const disc = discount || 0;
  const computed = itemsTotal + taxTotal + sc - disc;
  const difference = total - computed;

  if (Math.abs(difference) <= 100) { // Allow ₹1 tolerance for rounding
    return {
      valid: true,
      message: `Items + taxes = ₹${formatRupees(computed)} ✓`,
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
