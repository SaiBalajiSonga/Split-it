/**
 * SplitSmart Evaluation Harness
 * Runs the receipt scanning pipeline end-to-end on test datasets (SROIE and /samples).
 * Measures:
 *  - Field Exact Match (EM) & F1
 *  - Character Error Rate (CER) for text fields
 *  - Money Exact Match (tolerance 0 or 100 paise)
 *  - Line Item Precision, Recall, F1
 *  - Latency (mean, p50, p90 ms)
 *  - Failure rate (crashes, timeouts, empty outputs)
 * Saves baseline to /eval/baseline.json.
 */

import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';
import { parseReceipt, validateTotal } from '../src/logic/receiptParser.js';

// --- LEVENSHTEIN DISTANCE FOR CER ---
export function levenshteinDistance(s1, s2) {
  const a = (s1 || '').trim().toLowerCase();
  const b = (s2 || '').trim().toLowerCase();
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const aChar = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = aChar === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  return prev[n];
}

export function computeCER(prediction, groundTruth) {
  const pred = (prediction || '').trim();
  const gt = (groundTruth || '').trim();
  if (!gt) return pred ? 1.0 : 0.0;
  const dist = levenshteinDistance(pred, gt);
  return +(dist / Math.max(1, gt.length)).toFixed(4);
}

export function normalizeMoneyToPaise(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  const cleaned = str.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  // If explicitly labelled as paise or already scaled > 10000 integer
  if (typeof val === 'number' && Number.isInteger(val) && val >= 50000) {
    return val;
  }
  return Math.round(num * 100);
}

// --- EVALUATION RUNNER ---
export async function runEvaluation({ datasetDir, samplesDir, limit = 50, outputJson = 'eval/baseline.json' }) {
  console.log(`\n======================================================`);
  console.log(`📊 SplitSmart Document-AI Pipeline Evaluation Harness`);
  console.log(`======================================================\n`);

  // Initialize Tesseract Worker
  console.log('⚡ Initializing Tesseract.js Worker...');
  const worker = await Tesseract.createWorker('eng', 1, {
    cachePath: '.',
  });
  await worker.setParameters({
    preserve_interword_spaces: '1',
  });

  const testCases = [];

  // 1. Load SROIE dataset cases
  if (datasetDir && fs.existsSync(datasetDir)) {
    console.log(`🔍 Inspecting SROIE dataset at: ${datasetDir}`);
    // SROIE usually contains test/train folders with 'img' and 'box' or flat image/entities files
    const findFiles = (dir) => {
      let results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results = results.concat(findFiles(full));
        } else if (file.endsWith('.jpg') || file.endsWith('.png')) {
          results.push(full);
        }
      }
      return results;
    };

    const imageFiles = findFiles(datasetDir);
    console.log(`Found ${imageFiles.length} images in SROIE dataset.`);

    for (const imgPath of imageFiles.slice(0, limit)) {
      const baseName = path.basename(imgPath, path.extname(imgPath));
      const dir = path.dirname(imgPath);

      // Check corresponding annotation: entities (txt or json)
      let gt = null;
      const candidates = [
        path.join(dir, `${baseName}.txt`),
        path.join(dir, `${baseName}.json`),
        path.join(dir, '..', 'entities', `${baseName}.txt`),
        path.join(dir, '..', 'entities', `${baseName}.json`),
      ];

      for (const c of candidates) {
        if (fs.existsSync(c)) {
          try {
            const content = fs.readFileSync(c, 'utf8');
            gt = JSON.parse(content);
            break;
          } catch {
            // SROIE text format: { "company": ..., "date": ..., "address": ..., "total": ... }
            try {
              const content = fs.readFileSync(c, 'utf8');
              const lines = content.split('\n');
              const obj = {};
              lines.forEach(l => {
                const parts = l.split(',');
                if (parts.length >= 2) obj[parts[0].trim()] = parts.slice(1).join(',').trim();
              });
              gt = obj;
              break;
            } catch { /* continue */ }
          }
        }
      }

      if (gt) {
        testCases.push({
          source: 'SROIE',
          imagePath: imgPath,
          id: baseName,
          groundTruth: {
            company: gt.company || gt.merchant || '',
            date: gt.date || '',
            address: gt.address || '',
            total: gt.total || '',
            items: gt.items || [],
          },
        });
      }
    }
  }

  // 2. Load custom /samples cases with ground-truth in /samples/labels
  if (samplesDir && fs.existsSync(samplesDir)) {
    console.log(`🔍 Checking custom failing samples in: ${samplesDir}`);
    const files = fs.readdirSync(samplesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    const labelsDir = path.join(samplesDir, 'labels');

    for (const file of files) {
      const imgPath = path.join(samplesDir, file);
      const baseName = path.basename(file, path.extname(file));
      const labelPath = path.join(labelsDir, `${baseName}.json`);

      let gt = { company: '', date: '', total: '', items: [] };
      if (fs.existsSync(labelPath)) {
        try {
          gt = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
        } catch { /* ignore */ }
      }

      testCases.push({
        source: 'samples',
        imagePath: imgPath,
        id: baseName,
        groundTruth: gt,
      });
    }
  }

  console.log(`\nReady to benchmark on ${testCases.length} total test cases.\n`);

  if (testCases.length === 0) {
    console.warn('⚠️ No test cases found to evaluate! Please ensure dataset paths exist.');
    await worker.terminate();
    return null;
  }

  // Metrics tracking
  const results = [];
  const latencies = [];
  let crashes = 0;
  let emptyOutputs = 0;

  let totalNumericMatches = 0;
  let totalEvaluatedTotals = 0;
  let totalCompanyCER = 0;
  let totalDateEM = 0;
  let totalDateEvaluated = 0;

  let totalItemPrecisionSum = 0;
  let totalItemRecallSum = 0;
  let itemEvaluatedCount = 0;

  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    process.stdout.write(`[${idx + 1}/${testCases.length}] Testing ${tc.id} (${tc.source})... `);

    const t0 = Date.now();
    let ocrOutput = null;
    let parsed = null;
    let latencyMs = 0;

    try {
      // 1. OCR Stage
      const ocrRes = await worker.recognize(tc.imagePath, {}, { blocks: true });
      latencyMs = Date.now() - t0;
      latencies.push(latencyMs);
      ocrOutput = ocrRes.data;

      // 2. Parsing Stage
      parsed = parseReceipt(ocrOutput);
    } catch (err) {
      crashes++;
      console.log(`❌ CRASH: ${err.message}`);
      results.push({
        id: tc.id,
        source: tc.source,
        status: 'CRASH',
        error: err.message,
        latencyMs,
      });
      continue;
    }

    if (!ocrOutput?.text || ocrOutput.text.trim().length === 0) {
      emptyOutputs++;
      console.log(`⚠️ EMPTY OCR`);
    } else {
      console.log(`✓ (${latencyMs}ms, ${parsed.items?.length || 0} items, total: ${parsed.total || 'None'})`);
    }

    // Evaluate Total
    const gtTotalPaise = normalizeMoneyToPaise(tc.groundTruth.total);
    let totalMatch = false;
    if (gtTotalPaise !== null && gtTotalPaise > 0) {
      totalEvaluatedTotals++;
      const predTotalPaise = parsed.total || 0;
      // Exact match or within 100 paise tolerance
      if (Math.abs(predTotalPaise - gtTotalPaise) <= 100) {
        totalMatch = true;
        totalNumericMatches++;
      }
    }

    // Evaluate Company / Merchant
    let companyCER = 1.0;
    let companyMatch = false;
    const gtCompany = (tc.groundTruth.company || tc.groundTruth.merchant || '').trim();
    if (gtCompany) {
      const predCompany = (parsed.merchant || parsed.company || '').trim();
      companyCER = computeCER(predCompany, gtCompany);
      companyMatch = companyCER < 0.2 || predCompany.toLowerCase() === gtCompany.toLowerCase();
      totalCompanyCER += companyCER;
    }

    // Evaluate Date
    let dateMatch = false;
    const gtDate = (tc.groundTruth.date || '').trim();
    if (gtDate) {
      totalDateEvaluated++;
      const predDate = (parsed.date || '').trim();
      if (predDate && (predDate === gtDate || predDate.replace(/[-/]/g, '') === gtDate.replace(/[-/]/g, ''))) {
        dateMatch = true;
        totalDateEM++;
      }
    }

    // Evaluate Items if ground truth items provided
    let itemPrecision = 0;
    let itemRecall = 0;
    let itemF1 = 0;

    if (Array.isArray(tc.groundTruth.items) && tc.groundTruth.items.length > 0) {
      itemEvaluatedCount++;
      const gtItems = tc.groundTruth.items;
      const predItems = parsed.items || [];

      let truePositives = 0;
      for (const p of predItems) {
        const match = gtItems.find(g => {
          const priceMatch = Math.abs((p.totalPaise || 0) - normalizeMoneyToPaise(g.total || g.line_total || g.price)) <= 100;
          const cer = computeCER(p.name, g.name || g.item || '');
          return priceMatch && cer <= 0.45;
        });
        if (match) truePositives++;
      }

      itemPrecision = predItems.length > 0 ? truePositives / predItems.length : 0;
      itemRecall = gtItems.length > 0 ? truePositives / gtItems.length : 0;
      itemF1 = (itemPrecision + itemRecall > 0) 
        ? (2 * itemPrecision * itemRecall) / (itemPrecision + itemRecall) 
        : 0;

      totalItemPrecisionSum += itemPrecision;
      totalItemRecallSum += itemRecall;
    }

    results.push({
      id: tc.id,
      source: tc.source,
      status: 'OK',
      latencyMs,
      pred: {
        merchant: parsed.merchant || '',
        date: parsed.date || '',
        total: parsed.total,
        itemCount: parsed.items?.length || 0,
        subtotal: parsed.subtotal,
        taxes: parsed.taxes,
      },
      gt: tc.groundTruth,
      metrics: {
        totalMatch,
        companyMatch,
        companyCER,
        dateMatch,
        itemPrecision,
        itemRecall,
        itemF1,
      },
    });
  }

  await worker.terminate();

  // Aggregate statistics
  latencies.sort((a, b) => a - b);
  const meanLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length));
  const p50Latency = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p90Latency = latencies[Math.floor(latencies.length * 0.9)] || 0;

  const totalExactMatchRate = totalEvaluatedTotals > 0 ? +(totalNumericMatches / totalEvaluatedTotals).toFixed(4) : 0;
  const avgCompanyCER = totalEvaluatedTotals > 0 ? +(totalCompanyCER / totalEvaluatedTotals).toFixed(4) : 1.0;
  const dateExactMatchRate = totalDateEvaluated > 0 ? +(totalDateEM / totalDateEvaluated).toFixed(4) : 0;
  const avgItemPrecision = itemEvaluatedCount > 0 ? +(totalItemPrecisionSum / itemEvaluatedCount).toFixed(4) : 0;
  const avgItemRecall = itemEvaluatedCount > 0 ? +(totalItemRecallSum / itemEvaluatedCount).toFixed(4) : 0;
  const avgItemF1 = (avgItemPrecision + avgItemRecall > 0) 
    ? +((2 * avgItemPrecision * avgItemRecall) / (avgItemPrecision + avgItemRecall)).toFixed(4)
    : 0;
  const failureRate = +((crashes + emptyOutputs) / Math.max(1, testCases.length)).toFixed(4);

  const summary = {
    evaluatedAt: new Date().toISOString(),
    totalTestCases: testCases.length,
    datasetSources: [...new Set(testCases.map(t => t.source))],
    metrics: {
      totalNumericAccuracy: totalExactMatchRate,
      companyCER: avgCompanyCER,
      dateExactMatch: dateExactMatchRate,
      itemPrecision: avgItemPrecision,
      itemRecall: avgItemRecall,
      itemF1: avgItemF1,
      failureRate,
      crashes,
      emptyOutputs,
    },
    latency: {
      meanMs: meanLatency,
      p50Ms: p50Latency,
      p90Ms: p90Latency,
    },
    results,
  };

  // Save to output file
  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  fs.writeFileSync(outputJson, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n======================================================`);
  console.log(`📈 EVALUATION SUMMARY (Saved to ${outputJson})`);
  console.log(`======================================================`);
  console.table([
    { Metric: 'Total Numeric Accuracy', Value: `${(totalExactMatchRate * 100).toFixed(1)}%` },
    { Metric: 'Merchant / Company CER', Value: `${(avgCompanyCER * 100).toFixed(1)}%` },
    { Metric: 'Date Exact Match', Value: `${(dateExactMatchRate * 100).toFixed(1)}%` },
    { Metric: 'Item Precision', Value: `${(avgItemPrecision * 100).toFixed(1)}%` },
    { Metric: 'Item Recall', Value: `${(avgItemRecall * 100).toFixed(1)}%` },
    { Metric: 'Item F1-Score', Value: `${(avgItemF1 * 100).toFixed(1)}%` },
    { Metric: 'Failure Rate (Crash/Empty)', Value: `${(failureRate * 100).toFixed(1)}%` },
    { Metric: 'Latency Mean / p50 / p90', Value: `${meanLatency}ms / ${p50Latency}ms / ${p90Latency}ms` },
  ]);

  return summary;
}

// CLI entrypoint
if (process.argv[1] && process.argv[1].endsWith('eval_harness.js')) {
  const args = process.argv.slice(2);
  let datasetDir = '';
  let samplesDir = 'samples';
  let limit = 25;
  let out = 'eval/baseline.json';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dataset') datasetDir = args[++i];
    if (args[i] === '--samples') samplesDir = args[++i];
    if (args[i] === '--limit') limit = parseInt(args[++i], 10);
    if (args[i] === '--out') out = args[++i];
  }

  runEvaluation({ datasetDir, samplesDir, limit, outputJson: out })
    .catch(err => {
      console.error('Eval harness failed:', err);
      process.exit(1);
    });
}
