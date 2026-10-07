// Repeats the profile journey of web-ui-check.mjs for several collection sizes and reports
// median / worst-of-N per measurement. Usage:
//   node test-fixtures/performance/web-scale-report.mjs [--runs=3] [--sizes=100,1000,10000] [--virtual-grid=off|on]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argument = (name, fallback) => process.argv.find(item => item.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const runs = Math.max(1, Number(argument('runs', 3)));
const sizes = argument('sizes', '100,1000,10000').split(',').map(Number);
const virtualGrid = argument('virtual-grid', 'off');
const checker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-ui-check.mjs');

const median = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
const worst = values => Math.max(...values);
const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) =>
  item && typeof item === 'object' ? flatten(item, `${prefix}${key}.`) : typeof item === 'number' ? [[`${prefix}${key}`, item]] : []);

const rows = [];
for (const size of sizes) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const result = spawnSync(process.execPath, [checker, `--notes=${size}`, '--profile', `--virtual-grid=${virtualGrid}`], { encoding: 'utf8', timeout: 240000 });
    const line = (result.stdout || '').split('\n').find(item => item.startsWith('PROFILE '));
    if (!line) throw new Error(`Profile run failed for ${size} notes:\n${result.stderr || result.stdout}`);
    samples.push(Object.fromEntries(flatten(JSON.parse(line.slice(8)).journey)));
  }
  const keys = Object.keys(samples[0]);
  rows.push({ size, summary: Object.fromEntries(keys.map(key => [key, { median: +median(samples.map(sample => sample[key])).toFixed(1), worst: +worst(samples.map(sample => sample[key])).toFixed(1) }])) });
}
console.log(JSON.stringify({ runs, virtualGrid, rows }, null, 2));
