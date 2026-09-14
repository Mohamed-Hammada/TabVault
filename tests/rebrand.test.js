import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');

test('project is renamed to TabVault in root configurations', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'tabvault');

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^# TabVault/m);
  assert.match(readme, /A privacy-first, intelligent tab suspension and restoration system/);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'TabVault — Smart Tab Suspension & Restoration');
  assert.equal(manifest.short_name, 'TabVault');
  assert.equal(manifest.action.default_title, 'TabVault');
  assert.equal(manifest.commands['open-options'].description, 'Open TabVault settings');

  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  assert.match(popupHtml, /<title>TabVault<\/title>/);
  assert.match(popupHtml, /<span class="brand-name">TabVault<\/span>/);

  const optionsHtml = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
  assert.match(optionsHtml, /<title>TabVault · Settings<\/title>/);
  assert.match(optionsHtml, /<div class="brand-name">TabVault<\/div>/);

  const suspendedHtml = fs.readFileSync(path.join(ROOT, 'suspended', 'suspended.html'), 'utf8');
  assert.match(suspendedHtml, /SUSPENDED · TABVAULT/);
  assert.match(suspendedHtml, /<span>TabVault<\/span>/);

  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(bg, /const ALARM_TICK = "tabvault-tick";/);
  assert.match(bg, /id: "tabvault-suspend"/);

  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(content, /window\.__tabvault_injected/);

  // Verify all source code files have zero tabzen references
  const sourceFiles = [
    'manifest.json',
    'background.js',
    'content.js',
    'popup/popup.html',
    'popup/popup.js',
    'options/options.html',
    'options/options.js',
    'suspended/suspended.html',
    'suspended/suspended.js',
    'suspended/suspended.css'
  ];

  for (const relPath of sourceFiles) {
    const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    assert.doesNotMatch(text, /tabzen/i, `Found unexpected tabzen reference in ${relPath}`);
  }
});
