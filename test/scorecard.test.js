import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeScorecard, readmeSection, renderScorecard } from '../scripts/scorecard.js';

test('scorecard: every injected problem is found and nothing extra is flagged', () => {
  const s = computeScorecard();
  assert.ok(s.demo.every((d) => d.ok), 'a demo note does not match its expected result');
  assert.equal(s.totals.missed, 0);
  assert.equal(s.totals.falseFlags, 0);
  assert.equal(s.cleanOk, s.cleanNotes);
});

test('scorecard: the same holds on corpora from other seeds', () => {
  for (const seed of [1, 7, 42, 2027]) {
    const s = computeScorecard({ seed });
    assert.equal(s.totals.missed, 0, `seed ${seed} missed findings`);
    assert.equal(s.totals.falseFlags, 0, `seed ${seed} flagged extra findings`);
  }
});

test('scorecard: README table is the output of a fresh run', () => {
  // Line endings are normalised so a Windows checkout compares the same as a Unix one.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(readmeSection(readme), renderScorecard(computeScorecard()).trim(), 'README scorecard is stale: run npm run scorecard');
});
