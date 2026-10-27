#!/usr/bin/env node
// Claude Code statusLine script for MultiTerminal
// Reads JSON from stdin (model, context-window fill, rate-limit/quota stats),
// writes it to a temp file for the MultiTerminal status bar to pick up, then
// prints the user's own statusLine (task 452d33a4): MT forces this script as the
// statusLine of every terminal it launches, so without the hand-off Claude Code's
// status line row stayed empty.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    writeMtStats();
    printUserStatusLine(input);
});

function writeMtStats() {
    try {
        const data = JSON.parse(input);
        const terminalName = process.env.MULTITERMINAL_NAME;
        const docId = process.env.MULTITERMINAL_DOC_ID;

        // Graceful no-op when running outside MultiTerminal. Both name and docId
        // are required — docId scopes the output file so sibling terminals with
        // the same name can't clobber each other's statusline data.
        if (!terminalName || !docId) {
            return;
        }

        const cwd = data.workspace?.current_dir || '';
        const model = normalizeModel(data.model);
        const contextPct = data.context_window?.used_percentage ?? null;

        // Extract rate limits for quota pacing (Claude Code v2.1.80+)
        const rateLimits = data.rate_limits || null;
        let quota5h = null, quota7d = null, pace5h = null, pace7d = null;
        let resetIn5h = null;

        if (rateLimits) {
            if (rateLimits.five_hour) {
                quota5h = Math.floor(rateLimits.five_hour.used_percentage ?? 0);
                const resetsAt = rateLimits.five_hour.resets_at;
                if (resetsAt) {
                    const minutesRemaining = Math.max(0, Math.floor((new Date(resetsAt) - Date.now()) / 60000));
                    const windowMinutes = 300; // 5 hours
                    if (minutesRemaining <= windowMinutes) {
                        pace5h = Math.round(((windowMinutes - minutesRemaining) * 100 / windowMinutes) - quota5h);
                    }
                    // Reset countdown (e.g. "2h 15m")
                    if (minutesRemaining > 0) {
                        const h = Math.floor(minutesRemaining / 60);
                        const m = minutesRemaining % 60;
                        resetIn5h = h > 0 ? `${h}h ${m}m` : `${m}m`;
                    }
                }
            }
            if (rateLimits.seven_day) {
                quota7d = Math.floor(rateLimits.seven_day.used_percentage ?? 0);
                const resetsAt = rateLimits.seven_day.resets_at;
                if (resetsAt) {
                    const minutesRemaining = Math.max(0, Math.floor((new Date(resetsAt) - Date.now()) / 60000));
                    const windowMinutes = 10080; // 7 days
                    if (minutesRemaining <= windowMinutes) {
                        pace7d = Math.round(((windowMinutes - minutesRemaining) * 100 / windowMinutes) - quota7d);
                    }
                }
            }
        }

        const output = {
            terminalName,
            model,
            folder: cwd,
            folderName: cwd ? path.basename(cwd) : '',
            contextPct,
            quota5h,
            quota7d,
            pace5h,
            pace7d,
            resetIn5h,
            // sessionId + transcriptPath let the MT token meter (task f2702f69) locate
            // this terminal's Claude transcript JSONL to tail for live token totals.
            // Both come straight from Claude Code's statusLine stdin; null outside it.
            sessionId: data.session_id ?? null,
            transcriptPath: data.transcript_path ?? null,
            timestamp: Date.now()
        };

        // Write to temp file keyed by terminal name + docId so sibling terminals
        // sharing a name (e.g. a zombie session) can't clobber each other.
        // Atomic write so two near-simultaneous renders can't tear the file.
        const outPath = path.join(os.tmpdir(), `mt-statusline-${terminalName}-${docId}.json`);
        // Best-effort: a failed per-terminal write (e.g. a transient rename
        // collision with the C# poller) must NOT skip the shared-quota write
        // below — the two files are independent.
        try { atomicWriteFileSync(outPath, JSON.stringify(output)); } catch { /* best-effort */ }

        // Write account-level quota data to a shared file so all terminals
        // see the same 5h/7d usage stats. Only overwrite if our data is newer.
        if (rateLimits) {
            const sharedPath = path.join(os.tmpdir(), 'mt-statusline-quota.json');
            const sharedData = {
                quota5h, quota7d, pace5h, pace7d, resetIn5h,
                timestamp: Date.now(),
                updatedBy: terminalName
            };
            // Decide whether our data supersedes what's already there. The
            // read+parse is in its OWN try so a corrupt/unreadable existing file
            // is treated as "missing" (shouldWrite stays true) and gets repaired
            // by the atomic write below. The previous code parsed inside the same
            // try as the write, so a corrupt file threw before the write and the
            // file stayed corrupt forever — the bug this fixes.
            let shouldWrite = true;
            try {
                if (fs.existsSync(sharedPath)) {
                    const existing = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
                    // Only skip if existing data is newer (500ms tolerance for near-simultaneous writes)
                    if (existing.timestamp && existing.timestamp > sharedData.timestamp + 500) {
                        shouldWrite = false;
                    }
                }
            } catch {
                // Corrupt/unreadable shared file — treat as missing and overwrite to self-heal.
                shouldWrite = true;
            }
            if (shouldWrite) {
                // Atomic + best-effort: concurrent terminals can't produce a torn file.
                try { atomicWriteFileSync(sharedPath, JSON.stringify(sharedData)); } catch { /* best-effort */ }
            }
        }
    } catch {
        // Silently fail — don't break Claude Code
    }
}

// Runs the statusLine the user configured in their own settings.json (the active
// CLAUDE_CONFIG_DIR, else ~/.claude) with the same stdin, and prints its output.
// Only the user level: MT's --settings outranks project settings for statusLine
// anyway. Any failure prints nothing, which is what this script did before.
function printUserStatusLine(stdinText) {
    try {
        if (process.env.MT_STATUSLINE_CHAINED) return; // never re-enter ourselves
        const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
        const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
        const statusLine = settings && settings.statusLine;
        const command = statusLine && statusLine.type === 'command' ? statusLine.command : null;
        if (typeof command !== 'string' || !command.trim()) return;
        if (normPath(command).includes(normPath(__filename))) return;

        const shell = findShell();
        if (!shell) return;
        // coreutils `timeout` signals the command's whole process group. taskkill /T alone is
        // not enough under Git Bash: its emulated fork gives a grandchild a parent outside the
        // Windows process tree, so a hung command would leave an orphan behind on every render.
        // The command travels in an env var, so no quoting of user text is needed.
        //
        // WHY 15s / 18s (not 4s / 6s). User statusLines often run git status. On a large dirty
        // worktree that routinely takes 5–8s (measured ~6.5s for ca-statusline.sh on this machine).
        // The earlier 4s kill always blanked the Claude console row — the bug that looked like
        // "I lost the status line". A hung command still dies; a slow-but-live one finishes.
        const child = spawn(shell, ['-c', 'if command -v timeout >/dev/null 2>&1; then exec timeout -k 1 15 bash -c "$MT_USER_STATUSLINE"; else exec bash -c "$MT_USER_STATUSLINE"; fi'], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore'],
            env: { ...process.env, MT_STATUSLINE_CHAINED: '1', MT_USER_STATUSLINE: command }
        });
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { out += chunk; });
        // A wall-clock deadline for the whole tree: killing bash alone leaves its children
        // holding the output pipe open, so a spawnSync timeout never actually fires.
        const timer = setTimeout(() => {
            killTree(child.pid);
            process.exit(0); // timed out: print nothing, not a partial line
        }, 18000); // backstop only: `timeout -k 1 15` has normally ended it by 16s

        child.on('error', () => clearTimeout(timer));
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            // 124/137: coreutils `timeout` expired (137 = it had to KILL). A partial line is not printed.
            if (signal || code === 124 || code === 137) return;
            if (out) process.stdout.write(out);
        });
        child.stdin.on('error', () => { /* the command may not read stdin */ });
        child.stdin.end(stdinText);
    } catch {
        // No user statusLine, unreadable settings, or a failing command: print nothing.
    }
}

function killTree(pid) {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch { /* already gone */ }
}

// Claude Code runs statusLine commands through Git Bash on Windows. A bare `bash`
// is not good enough there: C:\Windows\System32\bash.exe is WSL, which cannot see
// ~/.claude/... the way Git Bash does.
function findShell() {
    if (process.platform !== 'win32') return '/bin/sh';
    const candidates = [];
    if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
    for (const dir of (process.env.PATH || '').split(';')) {
        if (dir && fs.existsSync(path.join(dir, 'git.exe'))) {
            candidates.push(path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, 'bash.exe'));
        }
    }
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
        if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
    }
    const system32 = normPath(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
    return candidates.find((p) => !normPath(path.resolve(p)).startsWith(system32) && fs.existsSync(p)) || null;
}

function normPath(s) {
    return s.replace(/\\/g, '/').toLowerCase();
}

// Synchronous sleep without a busy-spin (this is a one-shot CLI process, so
// blocking the main thread briefly is fine and we have no event loop to yield to).
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Atomic write: write to a unique per-process temp file, then rename it over
// the target. rename() is a whole-file swap, so a concurrent reader or writer
// never observes a half-written (torn) file. Torn concurrent writes to the
// shared quota file were the root cause of the 5h/7d/context stats sticking on
// "--%" — the file became invalid JSON that no reader could parse.
//
// The temp name includes random bytes (not just the pid) so a hostile or racing
// process in the shared temp dir can't predict/pre-place the path, and two
// writers never collide on it.
//
// On Windows, rename-replacing a file another process holds open (e.g. the C#
// StatusLinePoll reader) can throw a transient EPERM/EACCES/EBUSY. The C# reader
// now opens with FileShare.Delete so this is rare, but we still retry a few times
// with a short backoff so a normal poll collision doesn't drop the update.
function atomicWriteFileSync(targetPath, content) {
    const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmpPath, content, 'utf8');
        let lastErr;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                fs.renameSync(tmpPath, targetPath);
                return;
            } catch (e) {
                lastErr = e;
                const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
                if (!transient) throw e;
                if (attempt < 3) sleepSync(15); // no point sleeping after the last attempt
            }
        }
        throw lastErr;
    } catch (e) {
        // Best-effort cleanup of the temp file; rethrow so the caller can decide.
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw e;
    }
}

function normalizeModel(model) {
    if (!model) return 'claude';
    let name = typeof model === 'object' ? (model.id || model.name || 'claude') : String(model);
    // Remove claude- prefix and date suffix, truncate
    name = name.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    if (name.length > 12) name = name.substring(0, 12);
    return name;
}

