/**
 * Currency and date formatting utilities.
 * All monetary values are stored as integers in PAISE.
 */

/**
 * Format paise as a rupee string: ₹1,234.56
 */
export function formatCurrency(paise) {
  if (paise === null || paise === undefined) return '₹0.00';
  const rupees = Math.abs(paise) / 100;
  const formatted = rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${paise < 0 ? '-' : ''}₹${formatted}`;
}

/**
 * Format paise as a short rupee string: ₹1,235
 */
export function formatCurrencyShort(paise) {
  if (paise === null || paise === undefined) return '₹0';
  const rupees = Math.abs(paise) / 100;
  const formatted = Math.round(rupees).toLocaleString('en-IN');
  return `${paise < 0 ? '-' : ''}₹${formatted}`;
}

/**
 * Parse a rupee string to paise.
 */
export function parseRupees(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[₹,\s]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

/**
 * Format a timestamp as a readable date.
 */
export function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Format a timestamp as a short date: "30 Oct"
 */
export function formatDateShort(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Format relative time: "2 hours ago", "yesterday"
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDateShort(timestamp);
}

/**
 * Get initials from a name: "Arjun Mehta" → "AM"
 */
export function getInitials(name) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .map(w => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Predefined avatar colors (vibrant, distinct).
 */
export const AVATAR_COLORS = [
  '#7c3aed', // violet
  '#06b6d4', // cyan
  '#f43f5e', // rose
  '#10b981', // emerald
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#ec4899', // pink
  '#8b5cf6', // purple
  '#14b8a6', // teal
  '#ef4444', // red
  '#84cc16', // lime
  '#6366f1', // indigo
];

/**
 * Get a deterministic color for a member based on their index.
 */
export function getMemberColor(index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

/**
 * Category display info.
 */
export const CATEGORIES = {
  Food: { emoji: '🍔', cssClass: 'category-food' },
  Groceries: { emoji: '🛒', cssClass: 'category-groceries' },
  Travel: { emoji: '✈️', cssClass: 'category-travel' },
  Utilities: { emoji: '⚡', cssClass: 'category-utilities' },
  Entertainment: { emoji: '🎬', cssClass: 'category-entertainment' },
  Other: { emoji: '📦', cssClass: 'category-other' },
};

/**
 * Generate a UPI payment deep link.
 */
export function generateUPILink({ payeeUPI, payeeName, amount, note }) {
  const params = new URLSearchParams();
  if (payeeUPI) params.set('pa', payeeUPI);
  if (payeeName) params.set('pn', payeeName);
  if (amount) params.set('am', (amount / 100).toFixed(2));
  if (note) params.set('tn', note);
  params.set('cu', 'INR');
  return `upi://pay?${params.toString()}`;
}
