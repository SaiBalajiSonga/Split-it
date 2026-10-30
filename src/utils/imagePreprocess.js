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
  
  // Draw scaled image cleanly with smooth anti-aliased rendering
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  // Auto-detect receipt paper boundaries to crop away dark tables, shadows, and reflections
  const bounds = detectReceiptBounds(ctx, width, height);
  if (bounds) {
    const croppedCanvas = document.createElement('canvas');
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCanvas.width = bounds.width;
    croppedCanvas.height = bounds.height;
    croppedCtx.imageSmoothingEnabled = true;
    croppedCtx.imageSmoothingQuality = 'high';
    if (croppedCtx.filter !== undefined) {
      croppedCtx.filter = 'contrast(1.18) brightness(1.02)';
    }
    croppedCtx.drawImage(
      canvas,
      bounds.x, bounds.y, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );
    return croppedCanvas.toDataURL('image/jpeg', 0.94);
  }

  if (ctx.filter !== undefined) {
    ctx.filter = 'contrast(1.18) brightness(1.02)';
    ctx.drawImage(img, 0, 0, width, height);
  }

  return canvas.toDataURL('image/jpeg', 0.92);
}

/**
 * Detect the bright paper bounding box of a receipt sitting on a darker table/background.
 * Discards table glare, reflections, and dark borders that corrupt OCR readings.
 */
function detectReceiptBounds(ctx, width, height) {
  try {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    // Sample pixels to compute histogram
    const step = 8;
    const lums = [];
    for (let y = 0; y < height; y += step) {
      const yOff = y * width * 4;
      for (let x = 0; x < width; x += step) {
        const idx = yOff + x * 4;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        lums.push(lum);
      }
    }

    if (lums.length < 50) return null;
    lums.sort((a, b) => a - b);
    const p25 = lums[Math.floor(lums.length * 0.25)];
    const p75 = lums[Math.floor(lums.length * 0.75)];

    // If contrast between 25th and 75th percentile is low, it's already a full-frame scan
    if (p75 - p25 < 35) return null;

    const paperThreshold = (p25 + p75) / 2;

    // Scan column paper densities
    const colPaperRatio = new Float32Array(width);
    for (let x = 0; x < width; x += 4) {
      let paper = 0;
      let count = 0;
      for (let y = 0; y < height; y += 8) {
        const idx = (y * width + x) * 4;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        if (lum > paperThreshold) paper++;
        count++;
      }
      colPaperRatio[x] = count > 0 ? paper / count : 0;
    }

    let minX = 0;
    for (let x = 0; x < width; x += 4) {
      if (colPaperRatio[x] > 0.35) { minX = x; break; }
    }

    let maxX = width - 1;
    for (let x = width - 1; x >= 0; x -= 4) {
      if (colPaperRatio[x] > 0.35) { maxX = x; break; }
    }

    // Scan row paper densities within [minX, maxX]
    const rowPaperRatio = new Float32Array(height);
    for (let y = 0; y < height; y += 4) {
      let paper = 0;
      let count = 0;
      for (let x = minX; x <= maxX; x += 8) {
        const idx = (y * width + x) * 4;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        if (lum > paperThreshold) paper++;
        count++;
      }
      rowPaperRatio[y] = count > 0 ? paper / count : 0;
    }

    let minY = 0;
    for (let y = 0; y < height; y += 4) {
      if (rowPaperRatio[y] > 0.35) { minY = y; break; }
    }

    let maxY = height - 1;
    for (let y = height - 1; y >= 0; y -= 4) {
      if (rowPaperRatio[y] > 0.35) { maxY = y; break; }
    }

    // Add safe 2.5% padding so no printed text near edges is clipped
    const padX = Math.round((maxX - minX) * 0.025);
    const padY = Math.round((maxY - minY) * 0.025);

    const finalMinX = Math.max(0, minX - padX);
    const finalMaxX = Math.min(width - 1, maxX + padX);
    const finalMinY = Math.max(0, minY - padY);
    const finalMaxY = Math.min(height - 1, maxY + padY);

    const cropW = finalMaxX - finalMinX;
    const cropH = finalMaxY - finalMinY;

    const areaRatio = (cropW * cropH) / (width * height);
    if (areaRatio > 0.25 && areaRatio < 0.98 && cropW > 120 && cropH > 120) {
      return { x: finalMinX, y: finalMinY, width: cropW, height: cropH };
    }
  } catch {
    // Non-fatal fallback to full image
  }
  return null;
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
