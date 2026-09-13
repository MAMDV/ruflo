#!/usr/bin/env node
/** Content verification for frozen fresh-task source and parent-only evaluator capsules. */
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, validateFreshTaskFreeze } from './fresh-task-admission.mjs';

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_TAR_BYTES = 16 * 1024 * 1024;
const REQUIRED_PATHS = ['LICENSE', 'package.json', 'detector/patterns.js', 'detector/patterns.test.js'];
const assert = (condition, reason) => { if (!condition) throw Error(reason); };
const digest = value => createHash('sha256').update(value).digest('hex');
const cString = value => value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)).toString('utf8');

function tarInventory(tar) {
  assert(tar.length > 1024 && tar.length <= MAX_TAR_BYTES && tar.length % 512 === 0, 'bounded tar size');
  const paths = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = cString(header.subarray(0, 100));
    const prefix = cString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    assert(path && !path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\\'), 'unsafe tar path');
    const sizeText = cString(header.subarray(124, 136)).trim();
    assert(/^[0-7]+$/.test(sizeText), 'tar size encoding');
    const size = Number.parseInt(sizeText, 8);
    assert(Number.isSafeInteger(size) && size >= 0 && size <= MAX_TAR_BYTES, 'tar entry size');
    const type = String.fromCharCode(header[156] || 48);
    assert(type === '0' || type === '5' || (type === 'g' && path === 'pax_global_header'), 'tar entry type');
    if (type !== 'g') paths.push(path.replace(/\/$/, ''));
    offset += 512 + Math.ceil(size / 512) * 512;
    assert(offset <= tar.length, 'truncated tar entry');
  }
  assert(offset < tar.length && tar.subarray(offset).every(byte => byte === 0), 'tar terminator');
  assert(new Set(paths).size === paths.length, 'duplicate tar path');
  for (const required of REQUIRED_PATHS) assert(paths.includes(required), `source archive missing ${required}`);
  return paths;
}

export function validateCapsuleBytes(task, { sourceArchive, evaluator, testPlan }) {
  assert(Buffer.isBuffer(sourceArchive) && sourceArchive.length === task.source.archiveBytes, 'source archive byte count');
  assert(sourceArchive.length <= MAX_ARCHIVE_BYTES && digest(sourceArchive) === task.source.archiveSha256, 'source archive digest');
  const paths = tarInventory(gunzipSync(sourceArchive, { maxOutputLength: MAX_TAR_BYTES }));

  assert(Buffer.isBuffer(evaluator) && evaluator.length === task.evaluator.capsuleBytes, 'evaluator capsule byte count');
  assert(digest(evaluator) === task.evaluator.capsuleSha256, 'evaluator capsule digest');
  assert(Buffer.isBuffer(testPlan) && digest(testPlan) === task.evaluator.testPlanSha256, 'test plan digest');
  const plan = JSON.parse(testPlan.toString('utf8'));
  assert(plan.schema === 'ruflo.parent-only-test-plan/v1' && plan.taskId === task.id, 'test plan identity');
  assert(plan.authoredBeforeProposal === true && plan.proposerAccess === false, 'parent-only evaluator boundary');
  assert(plan.admissionOnly === true && plan.candidateExecutionEnabled === false && plan.boundedRsiEvidenceAccepted === false, 'test plan cannot enable execution');
  assert(Array.isArray(plan.cases) && plan.cases.length === 4, 'bounded test plan');
  return { taskId: task.id, archiveEntries: paths.length, evaluatorCases: plan.cases.length };
}

export function inspectFreshTaskCapsules(manifestPath, artifactRoot) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const admission = validateFreshTaskFreeze(manifest);
  const capsules = manifest.tasks.map(task => {
    const root = resolve(artifactRoot, task.id);
    assert(root.startsWith(`${resolve(artifactRoot)}/`), 'artifact path escaped root');
    return validateCapsuleBytes(task, {
      sourceArchive: readFileSync(resolve(root, 'source.tar.gz')),
      evaluator: readFileSync(resolve(root, 'evaluator.mjs')),
      testPlan: readFileSync(resolve(root, 'test-plan.json')),
    });
  });
  return {
    schema: 'ruflo.fresh-development-capsule-inspection/v1',
    freezeHash: admission.freezeHash,
    freshTaskCount: capsules.length,
    capsules,
    candidateExecutionEnabled: false,
    boundedRsiEvidenceAccepted: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [manifestPath, artifactRoot, extra] = process.argv.slice(2);
    if (!manifestPath || !artifactRoot || extra) throw Error('usage: fresh-task-capsule.mjs MANIFEST ARTIFACT_ROOT');
    console.log(JSON.stringify(inspectFreshTaskCapsules(resolve(manifestPath), resolve(artifactRoot)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
