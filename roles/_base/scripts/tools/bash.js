import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUTPUT_DIR = '/workspace/.tool-output';
const MAX_INLINE_LINES = 100;
const ASYNC_THRESHOLD_MS = 5000;
const AGENT_PORT = process.env.PORT || '3000';

// Global registry of running background jobs (shared with bash_kill tool via globalThis)
if (!globalThis.__bashJobs) globalThis.__bashJobs = new Map();
const jobs = globalThis.__bashJobs;

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function formatResult(output) {
  if (!output) return '(no output)';
  const lines = output.split('\n');
  if (lines.length <= MAX_INLINE_LINES) return output;
  ensureOutputDir();
  const id = crypto.randomUUID().slice(0, 8);
  const filePath = path.join(OUTPUT_DIR, id + '.txt');
  fs.writeFileSync(filePath, output);
  const preview = lines.slice(0, 50).join('\n');
  return preview + '\n\n[Output truncated: ' + lines.length + ' lines total. Full output saved to ' + filePath + '. Use read_file with offset/limit to read more.]';
}

export default {
  name: 'bash',
  description: 'Execute a shell command. Short commands return inline. Commands taking longer than 5 seconds run in background with output streamed to a file — you can read_file on the output path at any time to see latest output, and use bash_kill to cancel. Set async=true to immediately run in background (useful for long-lived processes like servers).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 60000). Only applies to synchronous commands; background/async commands have no timeout.' },
      async: { type: 'boolean', description: 'If true, immediately run in background without waiting for the 5s threshold' },
    },
    required: ['command'],
  },
  async execute(args) {
    const { command, timeout = 60000 } = args;
    const forceAsync = args.async || false;
    const jobId = crypto.randomUUID().slice(0, 8);

    return new Promise((resolve) => {
      let resolved = false;
      let inlineStdout = '', inlineStderr = '';

      // Prepare output file for streaming (created immediately, written to in real-time)
      ensureOutputDir();
      const outputPath = path.join(OUTPUT_DIR, jobId + '.txt');
      const fd = fs.openSync(outputPath, 'w');

      // Don't use exec's built-in timeout — we manage it ourselves so we can
      // cancel it when a command transitions to background mode.
      const child = exec(command, {
        timeout: 0,
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'utf-8',
      });

      // Our own timeout timer — only for sync commands, cleared when going async
      let killTimer = null;
      if (!forceAsync && timeout > 0) {
        killTimer = setTimeout(() => {
          if (!resolved) {
            child.kill('SIGTERM');
          }
        }, timeout);
      }

      // Stream output to file in real-time AND accumulate for inline return
      child.stdout?.on('data', (d) => {
        inlineStdout += d;
        fs.writeSync(fd, d);
      });
      child.stderr?.on('data', (d) => {
        inlineStderr += d;
        fs.writeSync(fd, '[stderr] ' + d);
      });

      // After threshold (or immediately if forceAsync), go async
      const thresholdMs = forceAsync ? 0 : ASYNC_THRESHOLD_MS;
      const asyncTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // Cancel the kill timer — background commands run indefinitely
        if (killTimer) clearTimeout(killTimer);
        // Register in global jobs map so bash_kill can find it
        jobs.set(jobId, { child, outputPath, command });
        const preview = inlineStdout.slice(-500);
        resolve({
          result: 'Command running in background (job: ' + jobId + ', output: ' + outputPath + '). You can read_file(' + outputPath + ') at any time to see latest output, or bash_kill(' + jobId + ') to cancel. You will receive a [system:bash] message when it completes.' + (preview ? '\nLatest output:\n' + preview : ''),
        });
      }, thresholdMs);

      function cleanup(exitCode) {
        clearTimeout(asyncTimer);
        if (killTimer) clearTimeout(killTimer);
        // Write exit status to output file
        fs.writeSync(fd, '\n[exit code: ' + (exitCode ?? 'unknown') + ']\n');
        fs.closeSync(fd);
        jobs.delete(jobId);
      }

      child.on('close', (code) => {
        if (!resolved) {
          // Completed within threshold — return inline, clean up file
          resolved = true;
          clearTimeout(asyncTimer);
          if (killTimer) clearTimeout(killTimer);
          fs.closeSync(fd);
          const output = code === 0
            ? inlineStdout
            : 'Exit code: ' + code + '\nStderr: ' + (inlineStderr || '') + '\nStdout: ' + (inlineStdout || '');
          // Remove streaming file since we return inline
          try { fs.unlinkSync(outputPath); } catch {}
          resolve({ result: formatResult(output) });
        } else {
          // Was async — output already in file, notify agent
          cleanup(code);
          fetch('http://localhost:' + AGENT_PORT + '/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: 'Background job ' + jobId + ' finished (exit ' + (code ?? 'unknown') + '). Full output: ' + outputPath,
              source: 'system:bash',
            }),
          }).catch(() => {});
        }
      });

      child.on('error', (err) => {
        clearTimeout(asyncTimer);
        if (killTimer) clearTimeout(killTimer);
        if (!resolved) {
          resolved = true;
          fs.closeSync(fd);
          try { fs.unlinkSync(outputPath); } catch {}
          resolve({ result: 'ERROR: ' + err.message });
        } else {
          fs.writeSync(fd, '\n[error] ' + err.message + '\n');
          cleanup(null);
        }
      });
    });
  },
};
