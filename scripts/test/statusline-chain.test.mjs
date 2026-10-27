// statusline-chain.test.mjs — MT forces scripts/statusline.js as every terminal's
// Claude Code statusLine so it can write mt-statusline-*.json for the pane header.
// That override used to print nothing, so the Claude console row went blank
// (task 452d33a4). This suite locks the hand-off: write MT stats, then print the
// user's configured statusLine command from settings.json.
//
// WHY A NODE TEST. The chain is pure JS + a shell child; it does not need the C#
// host. Catching "stdout empty" / "stats file missing" here is cheaper than a
// live Claude pane, and it is what actually regressed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'statusline.js');

const STDIN = JSON.stringify({
  model: { id: 'claude-sonnet-4-test' },
  workspace: { current_dir: 'C:/tmp/statusline-chain' },
  context_window: { used_percentage: 17 },
  session_id: 'sess-chain-1',
});

function runStatusline({ settingsDir, name = 'ChainAgent', docId = 'docc0001', env = {} }) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: STDIN,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      CLAUDE_CONFIG_DIR: settingsDir,
      MULTITERMINAL_NAME: name,
      MULTITERMINAL_DOC_ID: docId,
      // Drop any ambient chain guard from the parent test process.
      MT_STATUSLINE_CHAINED: '',
    },
    timeout: 20000,
    windowsHide: true,
  });
  return result;
}

function writeSettings(dir, statusLineCommand) {
  fs.mkdirSync(dir, { recursive: true });
  const body = statusLineCommand == null
    ? {}
    : { statusLine: { type: 'command', command: statusLineCommand } };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(body), 'utf8');
}

test('writes the MT stats file and prints the user statusLine command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sl-chain-'));
  try {
    writeSettings(dir, "printf 'USERLINE model=%s' demo");
    const name = 'ChainAgent';
    const docId = 'docc0001';
    const result = runStatusline({ settingsDir: dir, name, docId });

    assert.equal(result.status, 0, `statusline exited ${result.status}: ${result.stderr}`);
    assert.match(result.stdout || '', /USERLINE model=demo/,
      `expected user statusLine on stdout, got ${JSON.stringify(result.stdout)}`);

    const statsPath = path.join(os.tmpdir(), `mt-statusline-${name}-${docId}.json`);
    assert.ok(fs.existsSync(statsPath), `missing stats file ${statsPath}`);
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    assert.equal(stats.terminalName, name);
    assert.equal(stats.contextPct, 17);
    assert.equal(stats.sessionId, 'sess-chain-1');
    assert.match(String(stats.model), /sonnet-4-test|sonnet-4/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prints nothing when the user has no statusLine configured, but still writes stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sl-none-'));
  try {
    writeSettings(dir, null);
    const name = 'NoUserSL';
    const docId = 'docc0002';
    const result = runStatusline({ settingsDir: dir, name, docId });

    assert.equal(result.status, 0, `statusline exited ${result.status}: ${result.stderr}`);
    assert.equal((result.stdout || '').trim(), '',
      `expected empty stdout without a user statusLine, got ${JSON.stringify(result.stdout)}`);

    const statsPath = path.join(os.tmpdir(), `mt-statusline-${name}-${docId}.json`);
    assert.ok(fs.existsSync(statsPath), `missing stats file ${statsPath}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('does not re-enter itself when the user command points at this script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sl-self-'));
  try {
    // Point the "user" command at our own script — the chain guard must refuse.
    // Use a node invocation so Windows resolves it without bash path gymnastics.
    const selfCmd = `node "${SCRIPT.replace(/\\/g, '/')}"`;
    writeSettings(dir, selfCmd);
    const result = runStatusline({ settingsDir: dir, name: 'SelfChain', docId: 'docc0003' });

    assert.equal(result.status, 0, `statusline exited ${result.status}: ${result.stderr}`);
    assert.equal((result.stdout || '').trim(), '',
      `self-chain must print nothing, got ${JSON.stringify(result.stdout)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
