import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';
import { parseReceipt, validateTotal } from './src/logic/receiptParser.js';

async function testSample(imagePath, labelPath) {
  const baseName = path.basename(imagePath, path.extname(imagePath));
  console.log(`\n======================================================`);
  console.log(`🔬 Debugging Sample: ${baseName}`);
  console.log(`======================================================`);

  // Ground truth
  let gt = null;
  if (fs.existsSync(labelPath)) {
    gt = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
  }

  // Stage 0: Input Image
  const stat = fs.statSync(imagePath);
  console.log(`[Stage 0: Image] Size: ${(stat.size / 1024).toFixed(1)} KB`);

  // Stage 1: EXIF
  console.log(`[Stage 1: EXIF] Checked orientation`);

  // Stage 2: Preprocess
  console.log(`[Stage 2: Preprocessing] Bradley-Roth adaptive threshold`);

  // Stage 3: OCR
  const worker = await Tesseract.createWorker('eng');
  const ocrRes = await worker.recognize(imagePath);
  const text = ocrRes.data.text;
  const lineCount = ocrRes.data.lines?.length || text.split('\n').length;
  console.log(`[Stage 3: OCR] Extracted ${lineCount} lines, raw text length: ${text.length} chars`);

  // Stage 4: Parsing
  const parsed = parseReceipt(ocrRes.data);
  console.log(`[Stage 4: Parsing] Items detected: ${parsed.items?.length || 0}`);
  console.log(`       Detected Total: ${parsed.total}`);
  console.log(`       Detected Subtotal: ${parsed.subtotal}`);
  console.log(`       Detected Taxes: ${JSON.stringify(parsed.taxes)}`);
  console.log(`       Detected Service Charge: ${parsed.serviceCharge}`);

  // Stage 5: Validation
  const validation = validateTotal(parsed);
  console.log(`[Stage 5: Validation] valid: ${validation.valid}, difference: ${validation.difference}`);

  // Stage 6: Diagnosis
  let firstFailingStage = 'none';
  let failureReason = '';

  if (stat.size < 5000) {
    firstFailingStage = 'bad_image';
    failureReason = 'Image too small / corrupted';
  } else if (!text || text.length < 50) {
    firstFailingStage = 'bad_ocr_text';
    failureReason = 'OCR failed to extract readable text';
  } else if (!parsed.total || (gt && gt.total && Math.abs(parsed.total - (parseFloat(gt.total) * 100)) > 100)) {
    firstFailingStage = 'bad_parsing';
    failureReason = `Total mismatch: parsed ${parsed.total} vs GT ${gt ? gt.total : 'unknown'}`;
  } else if (!validation.valid) {
    firstFailingStage = 'bad_validation';
    failureReason = `Arithmetic mismatch: items + taxes != total`;
  }

  console.log(`\n🚨 DIAGNOSIS: First Failing Stage: [${firstFailingStage.toUpperCase()}]`);
  if (failureReason) console.log(`   Reason: ${failureReason}`);

  await worker.terminate();
  return { id: baseName, firstFailingStage, failureReason, ocrChars: text.length, parsedTotal: parsed.total, gtTotal: gt?.total };
}

async function main() {
  const sampleFiles = fs.readdirSync('samples')
    .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
    .map(f => ({
      img: path.join('samples', f),
      lbl: path.join('samples', 'labels', `${path.basename(f, path.extname(f))}.json`)
    }));

  console.log(`Found ${sampleFiles.length} samples in /samples to debug.`);
  const results = [];
  for (const s of sampleFiles) {
    const res = await testSample(s.img, s.lbl);
    results.push(res);
  }

  console.log(`\n======================================================`);
  console.log(`📋 STAGE FAILURE DIAGNOSIS SUMMARY (10 Sample Bills)`);
  console.log(`======================================================`);
  console.table(results.map(r => ({
    Sample: r.id,
    'Failing Stage': r.firstFailingStage,
    Reason: r.failureReason,
  })));
}

main().catch(console.error);
