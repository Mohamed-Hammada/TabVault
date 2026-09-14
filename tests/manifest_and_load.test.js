import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');

test('manifest.json conforms to Chrome Manifest V3 and all files exist', () => {
  const manifestPath = path.join(ROOT, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.name.length > 0);
  assert.ok(manifest.version && manifest.version.length > 0);
  
  // Background service worker
  assert.ok(manifest.background?.service_worker);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)), `Service worker ${manifest.background.service_worker} must exist`);

  // Action popup
  if (manifest.action?.default_popup) {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)), `Popup ${manifest.action.default_popup} must exist`);
  }

  // Options UI
  if (manifest.options_ui?.page) {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.options_ui.page)), `Options page ${manifest.options_ui.page} must exist`);
  }

  // Content scripts
  if (manifest.content_scripts) {
    for (const cs of manifest.content_scripts) {
      for (const js of cs.js || []) {
        assert.ok(fs.existsSync(path.join(ROOT, js)), `Content script ${js} must exist`);
      }
    }
  }

  // Web accessible resources
  if (manifest.web_accessible_resources) {
    for (const war of manifest.web_accessible_resources) {
      for (const res of war.resources || []) {
        assert.ok(fs.existsSync(path.join(ROOT, res)), `Resource ${res} must exist`);
      }
    }
  }

  // Icons
  if (manifest.icons) {
    for (const [size, iconPath] of Object.entries(manifest.icons)) {
      assert.ok(fs.existsSync(path.join(ROOT, iconPath)), `Icon ${size} at ${iconPath} must exist`);
    }
  }
});

test('all extension javascript files compile without syntax errors', () => {
  const jsFiles = [
    'background.js',
    'content.js',
    'popup/popup.js',
    'options/options.js',
    'suspended/suspended.js'
  ];

  for (const js of jsFiles) {
    const fullPath = path.join(ROOT, js);
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--check', fullPath]);
    }, `Syntax check failed for ${js}`);
  }
});
