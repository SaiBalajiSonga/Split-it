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
  
  const MAX_DIM = 1800;
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;
  if (width > MAX_DIM || height > MAX_DIM) {
    if (width > height) {
      height = Math.round((height * MAX_DIM) / width);
      width = MAX_DIM;
    } else {
      width = Math.round((width * MAX_DIM) / height);
      height = MAX_DIM;
    }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = width;
  canvas.height = height;
  
  ctx.drawImage(img, 0, 0, width, height);
  
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  // Step 1: Grayscale + Local Adaptive Thresholding (Bradley-Roth)
  // Perfectly handles receipts on dark tables, uneven shadows, and faint thermal print
  applyAdaptiveThreshold(data, width, height, 35, 10);

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Bradley-Roth Adaptive Local Thresholding via Integral Image.
 * Compares each pixel to its local s x s window to extract crisp black text
 * regardless of background darkness, shadows, or lighting gradients.
 */
function applyAdaptiveThreshold(data, width, height, s = 35, t = 10) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  const integral = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const yOff = y * width;
    const prevYOff = (y - 1) * width;
    for (let x = 0; x < width; x++) {
      sum += gray[yOff + x];
      integral[yOff + x] = sum + (y > 0 ? integral[prevYOff + x] : 0);
    }
  }

  const s2 = Math.floor(s / 2);
  const factor = (100 - t) / 100;

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - s2);
    const y2 = Math.min(height - 1, y + s2);
    const yOff = y * width;
    const y2Off = y2 * width;
    const y1Off = y1 * width;

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - s2);
      const x2 = Math.min(width - 1, x + s2);
      const count = (x2 - x1) * (y2 - y1);
      const sum = integral[y2Off + x2] 
                - integral[y1Off + x2] 
                - integral[y2Off + x1] 
                + integral[y1Off + x1];

      const idx = yOff + x;
      const pixelIdx = idx * 4;

      if (gray[idx] * count <= sum * factor) {
        data[pixelIdx] = 0;
        data[pixelIdx + 1] = 0;
        data[pixelIdx + 2] = 0;
      } else {
        data[pixelIdx] = 255;
        data[pixelIdx + 1] = 255;
        data[pixelIdx + 2] = 255;
      }
    }
  }
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
