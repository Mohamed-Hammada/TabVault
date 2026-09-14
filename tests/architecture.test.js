import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');

test('architecture documentation exists and thoroughly details all responsibilities and code paths', () => {
  const docPath = path.join(ROOT, 'docs', 'architecture.md');
  assert.ok(fs.existsSync(docPath), 'docs/architecture.md must exist');

  const content = fs.readFileSync(docPath, 'utf8');
  assert.match(content, /Background Service Worker/i);
  assert.match(content, /Popup Interface/i);
  assert.match(content, /Options Panel/i);
  assert.match(content, /Content Script/i);
  assert.match(content, /Suspension and Restoration Pipelines/i);
  assert.match(content, /Suspension Code Path/i);
  assert.match(content, /Restoration Code Path/i);
  assert.match(content, /Lifecycle/i);
});
