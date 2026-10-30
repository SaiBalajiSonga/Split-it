/**
 * Item Auto-Categorization Engine (Tier 2 Problem Statement Requirement)
 * 
 * Model: Xenova/mobilebert-uncased-mnli (Zero-shot classification via Transformers.js)
 * Categories: Food, Groceries, Travel, Utilities, Entertainment, Other
 * 
 * Strategy:
 * 1. Instant heuristic classifier (0ms latency, zero memory) for common receipt items.
 * 2. Asynchronous lazy-loaded Zero-Shot classification pipeline via @xenova/transformers.
 * 3. Never blocks the UI or initial screen rendering.
 */

// Lazy-loaded transformers references so initial app bundle stays tiny (< 150KB)
let pipelineRef = null;

export const CANDIDATE_CATEGORIES = [
  'Food',
  'Groceries',
  'Travel',
  'Utilities',
  'Entertainment',
  'Other',
];

// High-precision keyword taxonomy for instantaneous classification
const KEYWORD_TAXONOMY = {
  Food: [
    'margarita', 'pizza', 'burger', 'bgr', 'deluxe', 'cone', 'sundae', 'wrap', 'nugget', 'fries', 'taco', 'sandwich', 'pasta', 'naan', 'roti', 'paratha',
    'curry', 'biryani', 'dal', 'rice', 'paneer', 'chicken', 'mutton', 'prawn', 'fish',
    'kebab', 'tikka', 'salad', 'soup', 'coke', 'pepsi', 'coffee', 'tea', 'latte',
    'cappuccino', 'shake', 'juice', 'dessert', 'ice cream', 'cake', 'muffin', 'dosa',
    'idli', 'vada', 'chutney', 'samosa', 'maggi', 'noodle', 'beverage', 'drink',
    'dinner', 'lunch', 'breakfast', 'buffet', 'meal', 'thali', 'snack', 'platter',
    'fry', 'elixir', 'rasgulla', 'trifle', 'carb bev', 'soda', 'lime', 'lemonade',
    'mojito', 'mocktail', 'cocktail', 'beer', 'wine', 'whiskey', 'rum', 'vodka', 'gin', 'chai', 'lassi',
  ],
  Groceries: [
    'water btl', 'water bottle', 'mineral water', 'milk', 'bread', 'butter', 'cheese',
    'egg', 'eggs', 'flour', 'atta', 'sugar', 'salt', 'oil', 'spice', 'vegetable',
    'onion', 'potato', 'tomato', 'fruit', 'apple', 'banana', 'soap', 'shampoo',
    'toothpaste', 'detergent', 'biscuit', 'grocery', 'supermarket', 'provisions',
  ],
  Travel: [
    'uber', 'ola', 'cab', 'taxi', 'auto', 'fare', 'toll', 'parking', 'fuel',
    'petrol', 'diesel', 'cng', 'flight', 'airline', 'train', 'metro', 'bus',
    'fastag', 'transit',
  ],
  Utilities: [
    'wifi', 'wi-fi', 'internet', 'broadband', 'recharge', 'mobile', 'electricity',
    'power', 'water bill', 'maintenance', 'rent', 'lpg', 'gas cylinder', 'pipe',
  ],
  Entertainment: [
    'movie', 'cinema', 'theatre', 'theater', 'imax', 'pvr', 'inox', 'netflix', 'prime',
    'spotify', 'game', 'gaming', 'bowling', 'concert', 'show', 'amusement', 'party',
    'ticket', 'tickets',
  ],
};

let zeroShotClassifier = null;
let isModelLoading = false;
let modelLoadFailed = false;

/**
 * Fast synchronous pre-classifier.
 * Uses domain taxonomy to classify in 0ms without waiting for transformer weights.
 */
export function classifyItemFast(itemName) {
  if (!itemName) return 'Other';
  const lower = itemName.toLowerCase();

  for (const [category, keywords] of Object.entries(KEYWORD_TAXONOMY)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return category;
      }
    }
  }

  return 'Other';
}

/**
 * Lazy-load the MobileBERT zero-shot classification model.
 * Loads asynchronously in the background so it never blocks UI.
 */
export async function loadClassifierModel(onProgress) {
  if (zeroShotClassifier) return zeroShotClassifier;
  if (isModelLoading) return null;

  isModelLoading = true;
  try {
    if (!pipelineRef) {
      const moduleName = '@xenova/transformers';
      const { pipeline, env } = await import(/* @vite-ignore */ moduleName);
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      pipelineRef = pipeline;
    }
    zeroShotClassifier = await pipelineRef(
      'zero-shot-classification',
      'Xenova/mobilebert-uncased-mnli',
      {
        progress_callback: onProgress,
      }
    );
    isModelLoading = false;
    return zeroShotClassifier;
  } catch (err) {
    console.warn('Transformers.js model loading deferred or offline:', err);
    modelLoadFailed = true;
    isModelLoading = false;
    return null;
  }
}

/**
 * Classify an item name using MobileBERT Zero-Shot Classification.
 * Falls back to fast taxonomy if model is still loading or offline.
 */
export async function classifyItemZeroShot(itemName) {
  // First get fast taxonomy prediction
  const fastCategory = classifyItemFast(itemName);
  if (fastCategory !== 'Other') {
    return fastCategory;
  }

  // If fast taxonomy didn't find a high-confidence match, load model and run zero-shot
  if (!zeroShotClassifier) {
    await loadClassifierModel();
  }

  // If model is ready, run zero-shot inference
  if (zeroShotClassifier) {
    try {
      const output = await zeroShotClassifier(itemName, CANDIDATE_CATEGORIES);
      if (output && output.labels && output.labels.length > 0) {
        return output.labels[0];
      }
    } catch (err) {
      console.warn('Zero-shot inference fallback:', err);
    }
  }

  return fastCategory;
}

/**
 * Batch classify multiple items.
 */
export async function classifyItems(items) {
  const results = [];
  for (const item of items) {
    const category = await classifyItemZeroShot(item.name);
    results.push({ ...item, category });
  }
  return results;
}
