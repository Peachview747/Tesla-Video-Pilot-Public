import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));

test('every element app.js looks up by ID exists in index.html', () => {
  const used = new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map(match => match[1]));
  for (const view of ['channels', 'all']) used.add(`view-${view}`);
  const missing = [...used].filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});
test('IDs are unique and every nav target is a panel', () => {
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(all.length, ids.size, 'duplicate id in index.html');
  for (const [, target] of html.matchAll(/data-tab="([\w-]+)"/g)) {
    assert.ok(ids.has(target), `missing panel ${target}`);
    assert.match(html, new RegExp(`id="${target}" class="tab-panel`), `${target} is a tab panel`);
  }
});
test('no inline styles or scripts (the page CSP is style-src/script-src self)', () => {
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/);
  assert.doesNotMatch(html, /\son[a-z]+="/);
});
test('the old dropdown menu and hero decoration are gone', () => {
  assert.ok(!ids.has('menu-toggle') && !ids.has('tab-menu'));
  assert.doesNotMatch(html, /hero-heading|brand-mark/);
});
