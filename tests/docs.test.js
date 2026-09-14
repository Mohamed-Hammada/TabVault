import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');

test('docs/contributing.md exists and contains guidelines', () => {
  const file = path.join(ROOT, 'docs', 'contributing.md');
  assert.ok(fs.existsSync(file), 'docs/contributing.md must exist');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /Contribution Guidelines/i);
  assert.match(content, /Coding Standards/i);
  assert.match(content, /Testing Requirements/i);
});

test('docs/dev_setup.md exists and contains setup instructions', () => {
  const file = path.join(ROOT, 'docs', 'dev_setup.md');
  assert.ok(fs.existsSync(file), 'docs/dev_setup.md must exist');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /Prerequisites/i);
  assert.match(content, /Loading the Extension in Chrome/i);
  assert.match(content, /Debugging & Inspection/i);
});

test('docs/testing.md exists and contains testing instructions', () => {
  const file = path.join(ROOT, 'docs', 'testing.md');
  assert.ok(fs.existsSync(file), 'docs/testing.md must exist');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /Running Automated Tests/i);
  assert.match(content, /Test Suite Organization/i);
  assert.match(content, /Writing Unit & Mock Tests/i);
});

test('docs/limitations.md exists and covers Chrome API boundaries', () => {
  const file = path.join(ROOT, 'docs', 'limitations.md');
  assert.ok(fs.existsSync(file), 'docs/limitations.md must exist');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /JavaScript Execution & Heap Serialization/i);
  assert.match(content, /Real-Time Network & Media Connections/i);
  assert.match(content, /Memory Measurement Granularity/i);
  assert.match(content, /captureVisibleTab/i);
  assert.match(content, /Manifest V3 Service Worker Ephemeral Lifecycle/i);
});

test('docs/roadmap.md exists and contains phase breakdown', () => {
  const file = path.join(ROOT, 'docs', 'roadmap.md');
  assert.ok(fs.existsSync(file), 'docs/roadmap.md must exist');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /Roadmap Overview/i);
  assert.match(content, /Phase 1/i);
  assert.match(content, /Phase 2/i);
  assert.match(content, /Phase 7/i);
  assert.match(content, /Phase 14/i);
});

test('docs/task_completion_rules.md exists and enforces strict execution protocol', () => {
  const file = path.join(ROOT, 'docs', 'task_completion_rules.md');
  assert.ok(fs.existsSync(file), 'docs/task_completion_rules.md must exist');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /Golden Rule of Task Integrity/i);
  assert.match(content, /Allowed Task Statuses/i);
  assert.match(content, /Step-by-Step Execution Protocol/i);
});
