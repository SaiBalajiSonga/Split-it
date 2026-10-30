import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';
import { parseReceiptRobust } from '../test_improved_parser.js';
import { computeCER, normalizeMoneyToPaise } from './eval_harness.js';

async function runImprovedEval() {
  const baseJson = JSON.parse(fs.readFileSync('eval/baseline.json', 'utf8'));
  console.log(`\n======================================================`);
  console.log(`🚀 Benchmarking Improved Parser on Baseline Test Cases`);
  console.log(`======================================================\n`);

  const worker = await Tesseract.createWorker('eng', 1, { cachePath: '.' });
  await worker.setParameters({ preserve_interword_spaces: '1' });

  const results = [];
  const latencies = [];
  let totalNumericMatches = 0;
  let totalCompanyCER = 0;
  let totalDateEM = 0;
  let totalDateEvaluated = 0;
  let totalItemPrecisionSum = 0;
  let totalItemRecallSum = 0;
  let itemEvaluatedCount = 0;

  for (let idx = 0; idx < baseJson.results.length; idx++) {
    const item = baseJson.results[idx];
    const imagePath = item.source === 'samples' 
      ? path.join('samples', `${item.id}.jpg`)
      : path.join('/Users/mallajaswanthnarayana/.cache/kagglehub/datasets/urbikn/sroie-datasetv2/versions/4/SROIE2019/test/img', `${item.id}.jpg`);

    // Ensure ground truth is fresh from label file if present
    let gt = item.gt;
    if (item.source === 'samples') {
      const lblPath = path.join('samples', 'labels', `${item.id}.json`);
      if (fs.existsSync(lblPath)) {
        gt = JSON.parse(fs.readFileSync(lblPath, 'utf8'));
      }
    }

    const t0 = Date.now();
    const ocrRes = await worker.recognize(imagePath, {}, { blocks: true });
    const latency = Date.now() - t0;
    latencies.push(latency);

    const parsed = parseReceiptRobust(ocrRes.data);

    // Evaluate Total
    const gtTotalPaise = normalizeMoneyToPaise(gt.total);
    let totalMatch = false;
    if (gtTotalPaise !== null && gtTotalPaise > 0) {
      if (Math.abs(parsed.total - gtTotalPaise) <= 100) {
        totalMatch = true;
        totalNumericMatches++;
      }
    }

    // Evaluate Merchant
    const gtCompany = (gt.company || gt.merchant || '').trim();
    let companyCER = 1.0;
    let companyMatch = false;
    if (gtCompany) {
      companyCER = computeCER(parsed.merchant, gtCompany);
      companyMatch = companyCER < 0.3;
      totalCompanyCER += companyCER;
    }

    // Evaluate Date
    const gtDate = (gt.date || '').trim();
    let dateMatch = false;
    if (gtDate) {
      totalDateEvaluated++;
      const pDate = parsed.date;
      if (pDate) {
        // match YYYY-MM-DD against DD/MM/YYYY
        const cleanGT = gtDate.replace(/[-/.]/g, '');
        const cleanP = pDate.replace(/[-/.]/g, '');
        if (cleanGT === cleanP || pDate === gtDate) {
          dateMatch = true;
          totalDateEM++;
        } else {
          // Check inverted format DDMMYYYY vs YYYYMMDD
          const dmy = pDate.split('-').reverse().join('');
          if (dmy === cleanGT) {
            dateMatch = true;
            totalDateEM++;
          }
        }
      }
    }

    // Evaluate Items
    let itemPrecision = 0;
    let itemRecall = 0;
    let itemF1 = 0;
    if (Array.isArray(gt.items) && gt.items.length > 0) {
      itemEvaluatedCount++;
      const gtItems = gt.items;
      const predItems = parsed.items || [];
      let tp = 0;
      for (const p of predItems) {
        const match = gtItems.find(g => {
          const priceMatch = Math.abs((p.totalPaise || 0) - normalizeMoneyToPaise(g.total || g.line_total || g.price)) <= 100;
          const cer = computeCER(p.name, g.name || g.item || '');
          return priceMatch && cer <= 0.45;
        });
        if (match) tp++;
      }
      itemPrecision = predItems.length > 0 ? tp / predItems.length : 0;
      itemRecall = gtItems.length > 0 ? tp / gtItems.length : 0;
      itemF1 = itemPrecision + itemRecall > 0 ? (2 * itemPrecision * itemRecall) / (itemPrecision + itemRecall) : 0;
      totalItemPrecisionSum += itemPrecision;
      totalItemRecallSum += itemRecall;
    }

    results.push({
      id: item.id,
      totalMatch,
      companyMatch,
      companyCER,
      dateMatch,
      predTotal: parsed.total,
      gtTotal: gtTotalPaise,
      predMerchant: parsed.merchant,
      gtCompany,
      predDate: parsed.date,
      gtDate,
      itemPrecision,
      itemRecall,
      itemF1,
    });

    console.log(`[${idx + 1}/${baseJson.results.length}] ${item.id} -> Total: ${totalMatch ? '✓' : '✗'} (p: ${parsed.total}, gt: ${gtTotalPaise}) | Merchant: ${companyMatch ? '✓' : '✗'} (CER: ${(companyCER * 100).toFixed(0)}%) | Date: ${dateMatch ? '✓' : '✗'} (${parsed.date})`);
  }

  await worker.terminate();

  const totalExactMatchRate = +(totalNumericMatches / baseJson.results.length).toFixed(4);
  const avgCompanyCER = +(totalCompanyCER / baseJson.results.length).toFixed(4);
  const dateExactMatchRate = +(totalDateEM / totalDateEvaluated).toFixed(4);
  const avgItemPrecision = itemEvaluatedCount > 0 ? +(totalItemPrecisionSum / itemEvaluatedCount).toFixed(4) : 0;
  const avgItemRecall = itemEvaluatedCount > 0 ? +(totalItemRecallSum / itemEvaluatedCount).toFixed(4) : 0;
  const avgItemF1 = avgItemPrecision + avgItemRecall > 0 ? +((2 * avgItemPrecision * avgItemRecall) / (avgItemPrecision + avgItemRecall)).toFixed(4) : 0;

  latencies.sort((a, b) => a - b);
  const meanLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

  const improvedSummary = {
    evaluatedAt: new Date().toISOString(),
    metrics: {
      totalNumericAccuracy: totalExactMatchRate,
      companyCER: avgCompanyCER,
      dateExactMatch: dateExactMatchRate,
      itemPrecision: avgItemPrecision,
      itemRecall: avgItemRecall,
      itemF1: avgItemF1,
    },
    latencyMeanMs: meanLatency,
    results,
  };

  fs.writeFileSync('eval/after_parsing_fix.json', JSON.stringify(improvedSummary, null, 2));

  console.log(`\n========================================================================`);
  console.log(`📊 BEFORE vs AFTER METRICS TABLE`);
  console.log(`========================================================================`);
  console.table([
    { Metric: 'Total Numeric Accuracy', Baseline: `${(baseJson.metrics.totalNumericAccuracy * 100).toFixed(1)}%`, 'After Fix': `${(totalExactMatchRate * 100).toFixed(1)}%` },
    { Metric: 'Merchant / Company CER', Baseline: `${(baseJson.metrics.companyCER * 100).toFixed(1)}%`, 'After Fix': `${(avgCompanyCER * 100).toFixed(1)}%` },
    { Metric: 'Date Exact Match', Baseline: `${(baseJson.metrics.dateExactMatch * 100).toFixed(1)}%`, 'After Fix': `${(dateExactMatchRate * 100).toFixed(1)}%` },
    { Metric: 'Item Precision', Baseline: `${(baseJson.metrics.itemPrecision * 100).toFixed(1)}%`, 'After Fix': `${(avgItemPrecision * 100).toFixed(1)}%` },
    { Metric: 'Item Recall', Baseline: `${(baseJson.metrics.itemRecall * 100).toFixed(1)}%`, 'After Fix': `${(avgItemRecall * 100).toFixed(1)}%` },
    { Metric: 'Item F1-Score', Baseline: `${(baseJson.metrics.itemF1 * 100).toFixed(1)}%`, 'After Fix': `${(avgItemF1 * 100).toFixed(1)}%` },
    { Metric: 'Mean Latency', Baseline: `${baseJson.latency.meanMs}ms`, 'After Fix': `${meanLatency}ms` },
  ]);
}

runImprovedEval().catch(console.error);
