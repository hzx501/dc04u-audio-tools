#!/usr/bin/env node
// Install user-supplied JSON locally. No network requests are made.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const math = require('../eq-math.js');
const [curvePath, catalogPath] = process.argv.slice(2);
if (!curvePath) {
  console.error('Usage: node scripts/use-local-library.mjs path/to/curves.json [path/to/huihifi-catalog.json]');
  process.exit(1);
}
const library = JSON.parse(await readFile(resolve(curvePath), 'utf8'));
if (!Array.isArray(library.curves) || !library.curves.length) throw new Error('curves.json must contain a nonempty curves array.');
const ids = new Set();
for (const curve of library.curves) {
  if (typeof curve.id !== 'string' || !curve.id || ids.has(curve.id)) throw new Error('Curve IDs must be nonempty and unique.');
  if (typeof curve.name !== 'string' || !curve.name.trim()) throw new Error('Every curve needs a name.');
  ids.add(curve.id);
  curve.points = math.canonicalCurve(curve.points);
  if (curve.points.length < 10) throw new Error('Each curve needs at least ten distinct valid frequencies.');
  math.normalizeCurve(curve.points, 1000);
}
let catalog;
if (catalogPath) {
  catalog = JSON.parse(await readFile(resolve(catalogPath), 'utf8'));
  if (!Array.isArray(catalog.records)) throw new Error('The catalog must contain a records array.');
  const seen = new Set(), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const record of catalog.records) {
    if (!uuid.test(record.id) || seen.has(record.id)) throw new Error('Catalog record IDs must be unique UUIDs.');
    seen.add(record.id);
    const endpoint = `https://cdn-service.moondroplab.tech/api/v1/huihifi/evaluations/${record.id}/raw-fr`;
    if (record.rawUrl !== endpoint) throw new Error('Catalog records must use their exact supported public endpoint.');
  }
}
const dataDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../data');
await mkdir(dataDirectory, { recursive: true });
async function save(name, value, globalName) {
  const json = JSON.stringify(value, null, 2) + '\n';
  await writeFile(resolve(dataDirectory, name + '.json'), json);
  await writeFile(resolve(dataDirectory, name + '.js'), `// User-supplied local data. Check its redistribution terms before publishing.\nwindow.${globalName} = ${json.trim()};\n`);
}
await save('curves', library, 'DC04UCurveLibrary');
if (catalog) await save('huihifi-catalog', catalog, 'DC04UHuiHiFiCatalog');
console.log(`Installed ${library.curves.length} curves${catalog ? ` and ${catalog.records.length} catalog records` : ''} locally. Reload the extension and control page to use them.`);
console.log('This changed data files in your local checkout. Check source permissions before committing or publishing them.');
