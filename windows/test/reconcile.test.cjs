const {readFileSync, readdirSync} = require('node:fs');
const {join} = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const {reconcile} = require('../reconcile.cjs');

const fixtures = join(__dirname, '../../fixtures/reconcile');
for (const file of readdirSync(fixtures).filter(name => name.endsWith('.json')).sort()) {
 test(file.slice(0, -5), () => {
  const {inputs, expected} = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  assert.deepEqual(reconcile(inputs), expected);
 });
}
