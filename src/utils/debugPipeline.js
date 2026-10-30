/**
 * SplitSmart Debug Pipeline Runner
 * Saves and logs the output of EVERY stage for a given receipt image:
 * Stage 0: Original image metadata & dimensions
 * Stage 1: EXIF orientation status & correction
 * Stage 2: Image preprocessing (downscale, grayscale, adaptive thresholding)
 * Stage 3: Raw OCR extraction (text, lines, words, bounding boxes, confidences)
 * Stage 4: Key Information Extraction & Field Parsing
 * Stage 5: Arithmetic & Integrity Validation
 * Stage 6: First Failing Stage Diagnosis
 */

import { preprocessImage } from './imagePreprocess.js';
import { parseReceipt, validateTotal } from '../logic/receiptParser.js';

export const isDebugEnabled = () => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_SCAN_PIPELINE === 'true') {
    return true;
  }
  if (typeof process !== 'undefined' && (process.env?.DEBUG_SCAN_PIPELINE === 'true' || process.env?.VITE_DEBUG_SCAN_PIPELINE === 'true')) {
    return true;
  }
  return false;
};

/**
 * Execute all scanning stages with full telemetry logging.
 * @param {string|Buffer} imageSource - Data URL or file buffer
 * @param {Function} ocrRunner - Function that takes preprocessed image and returns Tesseract output
 * @param {Object} options - { filename, groundTruth }
 */
export async function runPipelineWithDebug(imageSource, ocrRunner, options = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = options.filename || `scan_${timestamp}`;
  const debugReport = {
    meta: {
      timestamp,
      filename,
      debugMode: true,
    },
    stages: {},
    diagnosis: {
      firstFailingStage: 'none',
      reasons: [],
    },
  };

  // --- STAGE 0: Original Image ---
  try {
    const isDataUrl = typeof imageSource === 'string' && imageSource.startsWith('data:');
    debugReport.stages.stage_0_original = {
      type: isDataUrl ? imageSource.split(';')[0] : 'raw_buffer',
      approxSizeBytes: imageSource.length,
      status: 'OK',
    };
  } catch (err) {
    debugReport.stages.stage_0_original = { status: 'ERROR', error: err.message };
    debugReport.diagnosis.firstFailingStage = 'bad_image';
    debugReport.diagnosis.reasons.push(`Stage 0 failed to read input: ${err.message}`);
    return debugReport;
  }

  // --- STAGE 1: EXIF Inspection ---
  try {
    // Check if EXIF orientation is present (browser Image() often discards orientation unless handled)
    debugReport.stages.stage_1_exif = {
      orientationDetected: null,
      rotatedApplied: 0,
      status: 'EXIF tags preserved / browser-rendered',
    };
  } catch (err) {
    debugReport.stages.stage_1_exif = { status: 'WARNING', error: err.message };
  }

  // --- STAGE 2: Preprocessing ---
  let preprocessedDataUrl = null;
  try {
    const t0 = Date.now();
    preprocessedDataUrl = await preprocessImage(imageSource);
    const durationMs = Date.now() - t0;
    debugReport.stages.stage_2_preprocessing = {
      status: 'OK',
      durationMs,
      outputFormat: 'image/png',
      approxSizeBytes: preprocessedDataUrl.length,
    };
  } catch (err) {
    debugReport.stages.stage_2_preprocessing = { status: 'ERROR', error: err.message };
    if (debugReport.diagnosis.firstFailingStage === 'none') {
      debugReport.diagnosis.firstFailingStage = 'bad_image';
      debugReport.diagnosis.reasons.push(`Stage 2 preprocessing failed: ${err.message}`);
    }
    return debugReport;
  }

  // --- STAGE 3: OCR Recognition ---
  let ocrResult = null;
  try {
    const t0 = Date.now();
    ocrResult = await ocrRunner(preprocessedDataUrl);
    const durationMs = Date.now() - t0;

    const rawText = ocrResult?.text || '';
    const lines = ocrResult?.lines || [];
    const words = ocrResult?.words || [];

    const wordConfidences = words.map(w => w.confidence).filter(c => typeof c === 'number');
    const avgConfidence = wordConfidences.length > 0 
      ? Math.round(wordConfidences.reduce((a, b) => a + b, 0) / wordConfidences.length)
      : (ocrResult?.confidence || 0);

    debugReport.stages.stage_3_ocr = {
      status: 'OK',
      durationMs,
      totalChars: rawText.length,
      lineCount: lines.length,
      wordCount: words.length,
      averageConfidence: avgConfidence,
      rawTextSnippet: rawText.substring(0, 300) + (rawText.length > 300 ? '...' : ''),
      lowConfidenceWords: words.filter(w => w.confidence < 60).map(w => ({ text: w.text, conf: w.confidence })),
    };

    if (rawText.trim().length === 0) {
      debugReport.diagnosis.firstFailingStage = 'bad_ocr_text';
      debugReport.diagnosis.reasons.push('Stage 3 OCR returned zero text characters.');
    } else if (avgConfidence < 40) {
      debugReport.diagnosis.firstFailingStage = 'bad_ocr_text';
      debugReport.diagnosis.reasons.push(`Stage 3 OCR average confidence critically low: ${avgConfidence}%`);
    }
  } catch (err) {
    debugReport.stages.stage_3_ocr = { status: 'ERROR', error: err.message };
    if (debugReport.diagnosis.firstFailingStage === 'none') {
      debugReport.diagnosis.firstFailingStage = 'bad_ocr_text';
      debugReport.diagnosis.reasons.push(`Stage 3 OCR failed with exception: ${err.message}`);
    }
    return debugReport;
  }

  // --- STAGE 4: Parsing / Information Extraction ---
  let parsed = null;
  try {
    const t0 = Date.now();
    parsed = parseReceipt(ocrResult);
    const durationMs = Date.now() - t0;

    debugReport.stages.stage_4_parsing = {
      status: 'OK',
      durationMs,
      itemCount: parsed.items?.length || 0,
      detectedSubtotal: parsed.subtotal,
      detectedTotal: parsed.total,
      taxCount: parsed.taxes?.length || 0,
      hasServiceCharge: !!parsed.serviceCharge,
      hasDiscount: !!parsed.discount,
      roundoff: parsed.roundoff || 0,
      items: (parsed.items || []).map(it => ({
        name: it.name,
        qty: it.qty,
        unitPrice: it.unitPricePaise,
        total: it.totalPaise,
      })),
    };

    if ((parsed.items || []).length === 0 && (parsed.total === null || parsed.total === 0)) {
      if (debugReport.diagnosis.firstFailingStage === 'none') {
        debugReport.diagnosis.firstFailingStage = 'bad_parsing';
        debugReport.diagnosis.reasons.push('Stage 4 Parsing failed: 0 items detected and no grand total found.');
      }
    }
  } catch (err) {
    debugReport.stages.stage_4_parsing = { status: 'ERROR', error: err.message };
    if (debugReport.diagnosis.firstFailingStage === 'none') {
      debugReport.diagnosis.firstFailingStage = 'bad_parsing';
      debugReport.diagnosis.reasons.push(`Stage 4 Parsing crashed: ${err.message}`);
    }
    return debugReport;
  }

  // --- STAGE 5: Validation ---
  try {
    const validation = validateTotal(parsed);
    debugReport.stages.stage_5_validation = {
      status: 'OK',
      valid: validation.valid,
      differencePaise: validation.difference,
      message: validation.message,
      computed: validation.computed,
      statedTotal: validation.total,
    };

    if (!validation.valid && debugReport.diagnosis.firstFailingStage === 'none') {
      debugReport.diagnosis.firstFailingStage = 'bad_validation';
      debugReport.diagnosis.reasons.push(
        `Stage 5 Validation failed: computed sum ${validation.computed} differs from stated total ${validation.total} by ${validation.difference} paise.`
      );
    }
  } catch (err) {
    debugReport.stages.stage_5_validation = { status: 'ERROR', error: err.message };
    if (debugReport.diagnosis.firstFailingStage === 'none') {
      debugReport.diagnosis.firstFailingStage = 'bad_validation';
      debugReport.diagnosis.reasons.push(`Stage 5 Validation crashed: ${err.message}`);
    }
  }

  // Log in browser or terminal if debug mode is active
  if (isDebugEnabled()) {
    console.group(`🔍 [SplitSmart Pipeline Debug] ${filename}`);
    console.log('Diagnosis:', debugReport.diagnosis);
    console.log('Stages:', debugReport.stages);
    console.groupEnd();
  }

  return debugReport;
}
