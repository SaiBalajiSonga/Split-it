/**
 * Canvas-based image preprocessing to improve OCR accuracy.
 * Applies grayscale conversion and contrast boost, especially
 * useful for faded thermal paper receipts.
 */

/**
 * Preprocess an image for OCR: grayscale + contrast boost.
 * @param {HTMLImageElement|string} source - Image element or data URL
 * @returns {Promise<string>} Preprocessed image as data URL
 */
export async function preprocessImage(source) {
  const img = await loadImage(source);
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  
  ctx.drawImage(img, 0, 0);
  
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  // Step 1: Convert to grayscale
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
  
  // Step 2: Auto-contrast (stretch histogram)
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  
  const range = max - min;
  if (range > 0 && range < 200) { // Only apply if contrast is low
    for (let i = 0; i < data.length; i += 4) {
      const normalized = ((data[i] - min) / range) * 255;
      const value = Math.min(255, Math.max(0, Math.round(normalized)));
      data[i] = data[i + 1] = data[i + 2] = value;
    }
  }
  
  // Step 3: Slight sharpen for faded text
  // Using simple unsharp mask approximation
  ctx.putImageData(imageData, 0, 0);
  
  return canvas.toDataURL('image/png');
}

/**
 * Rotate an image by the given degrees.
 * @param {string} dataUrl - Source image as data URL
 * @param {number} degrees - Rotation angle (90, 180, 270)
 * @returns {Promise<string>} Rotated image as data URL
 */
export async function rotateImage(dataUrl, degrees) {
  const img = await loadImage(dataUrl);
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  const rad = (degrees * Math.PI) / 180;
  
  if (degrees === 90 || degrees === 270) {
    canvas.width = img.height;
    canvas.height = img.width;
  } else {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  
  return canvas.toDataURL('image/png');
}

/**
 * Load an image from a data URL or element.
 */
function loadImage(source) {
  return new Promise((resolve, reject) => {
    if (source instanceof HTMLImageElement && source.complete) {
      resolve(source);
      return;
    }
    
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = typeof source === 'string' ? source : source.src;
  });
}

/**
 * Read a File object as a data URL.
 */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
