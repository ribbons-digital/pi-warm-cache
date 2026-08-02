#!/usr/bin/env node
/**
 * Unit-test runner for pi-warm-cache.
 *
 * Prints a content checksum after the test file mtime/size is stable, then runs
 * the suite. Use this instead of launching tests in the same parallel batch as
 * an edit, which can read a half-updated file.
 *
 * Usage: node scripts/run-unit-tests.mjs
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testFile = resolve(root, "src/provider.test.ts");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileKey(path) {
  const st = statSync(path);
  const mtimeNs = typeof st.mtimeNs === "bigint" ? st.mtimeNs.toString() : String(st.mtimeMs);
  return `${mtimeNs}:${st.size}`;
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Wait until consecutive stat samples match (avoids mid-write reads). */
function waitForStableFile(path, { samples = 3, gapMs = 25, maxMs = 1000 } = {}) {
  const started = Date.now();
  let last = fileKey(path);
  let stable = 1;
  while (Date.now() - started < maxMs) {
    sleepMs(gapMs);
    const next = fileKey(path);
    if (next === last) {
      stable += 1;
      if (stable >= samples) return;
    } else {
      last = next;
      stable = 1;
    }
  }
  throw new Error(`file did not stabilize within ${maxMs}ms: ${path}`);
}

waitForStableFile(testFile);
const digest = sha256File(testFile);
const bytes = statSync(testFile).size;

console.log(`[run-unit-tests] file=${testFile}`);
console.log(`[run-unit-tests] sha256=${digest}`);
console.log(`[run-unit-tests] bytes=${bytes}`);

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", testFile],
  {
    cwd: root,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
