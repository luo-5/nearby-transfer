'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const {
  assertValidTaskId,
  normalizeTransferManifest
} = require('./transfer-manifest');

const STAGING_PREFIX = '.nearby-transfer-staging-';
const STAGING_SUFFIX = '.partial';
const RESERVATION_ROOT_NAME = '.nearby-transfer-reservations';
const MAX_COMPONENT_BYTES = 255;
const PLAN_INPUT_KEYS = ['fsPromises', 'manifest', 'receiveRoot'];
const CLEANUP_INPUT_KEYS = ['fsPromises', 'receiveRoot', 'taskId'];

async function planReceiveTargets(input) {
  assertPlainObject(input, 'Receive target planner input');
  assertOnlyKeys(input, PLAN_INPUT_KEYS, 'Receive target planner input');
  requireOwn(input, 'manifest', 'Receive target planner input');
  requireOwn(input, 'receiveRoot', 'Receive target planner input');

  const fsPromises = normalizeFsPromises(input.fsPromises);
  const receiveRoot = normalizeAbsoluteRoot(input.receiveRoot);
  const manifest = normalizeTransferManifest(input.manifest);
  if (!util.isDeepStrictEqual(input.manifest, manifest)) {
    throw new TypeError('Transfer manifest must already be normalized');
  }

  await assertSafeDirectoryChain(receiveRoot, fsPromises, 'Receive root');

  const stagingDirectory = path.join(
    receiveRoot,
    `${STAGING_PREFIX}${manifest.taskId}${STAGING_SUFFIX}`
  );
  assertContained(receiveRoot, stagingDirectory, 'Task staging directory');

  let ownsStaging = false;
  const reservations = [];
  try {
    await fsPromises.mkdir(stagingDirectory);
    ownsStaging = true;
    await assertSafeDirectory(stagingDirectory, fsPromises, 'Task staging directory');

    const reservationRoot = path.join(receiveRoot, RESERVATION_ROOT_NAME);
    await ensureSafeDirectory(reservationRoot, fsPromises, 'Receive reservation directory');

    const roots = collectTopLevelRoots(manifest);
    const originalRootKeys = new Set(roots.map((root) => windowsKey(root.name)));
    const selectedKeys = new Set();
    const rootMappings = new Map();

    for (const root of roots) {
      const otherOriginalKeys = new Set(originalRootKeys);
      otherOriginalKeys.delete(windowsKey(root.name));
      let suffix = 0;
      let reserved;
      while (!reserved) {
        const candidate = suffix === 0
          ? root.name
          : createRenamedComponent(root.name, root.kind, suffix);
        const candidateKey = windowsKey(candidate);
        suffix += 1;

        if (selectedKeys.has(candidateKey) || otherOriginalKeys.has(candidateKey)) {
          continue;
        }

        reserved = await tryReserveTopLevel({
          candidate,
          fsPromises,
          receiveRoot,
          reservationRoot,
          taskId: manifest.taskId
        });
      }

      reservations.push(reserved.reservationDirectory);
      selectedKeys.add(windowsKey(reserved.candidate));
      rootMappings.set(root.name, reserved.candidate);
    }

    const targets = manifest.entries.map((entry) => {
      const components = entry.path.split('/');
      const finalComponents = [rootMappings.get(components[0]), ...components.slice(1)];
      const stagingPath = path.join(stagingDirectory, ...components);
      const finalPath = path.join(receiveRoot, ...finalComponents);
      assertContained(stagingDirectory, stagingPath, 'Staging target path');
      assertContained(receiveRoot, finalPath, 'Final target path');
      return Object.freeze({
        path: entry.path,
        kind: entry.kind,
        stagingPath,
        finalPath
      });
    });

    await createStagingDirectories(targets, stagingDirectory, fsPromises);

    return Object.freeze({
      taskId: manifest.taskId,
      receiveRoot,
      stagingDirectory,
      targets: Object.freeze(targets)
    });
  } catch (error) {
    for (const reservationDirectory of reservations.reverse()) {
      await removeOwnedReservation(reservationDirectory, manifest.taskId, fsPromises).catch(() => {});
    }
    if (ownsStaging) {
      await fsPromises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function cleanupReceiveStaging(input) {
  assertPlainObject(input, 'Receive staging cleanup input');
  assertOnlyKeys(input, CLEANUP_INPUT_KEYS, 'Receive staging cleanup input');
  requireOwn(input, 'receiveRoot', 'Receive staging cleanup input');
  requireOwn(input, 'taskId', 'Receive staging cleanup input');

  const fsPromises = normalizeFsPromises(input.fsPromises);
  const receiveRoot = normalizeAbsoluteRoot(input.receiveRoot);
  assertValidTaskId(input.taskId);
  await assertSafeDirectoryChain(receiveRoot, fsPromises, 'Receive root');

  const stagingDirectory = path.join(
    receiveRoot,
    `${STAGING_PREFIX}${input.taskId}${STAGING_SUFFIX}`
  );
  assertContained(receiveRoot, stagingDirectory, 'Task staging directory');

  let stagingRemoved = false;
  const stagingStat = await lstatIfExists(stagingDirectory, fsPromises);
  if (stagingStat) {
    await assertSafeTree(stagingDirectory, fsPromises);
    await fsPromises.rm(stagingDirectory, { recursive: true, force: false });
    stagingRemoved = true;
  }

  const reservationsReleased = await releaseTaskReservations(
    receiveRoot,
    input.taskId,
    fsPromises
  );
  return Object.freeze({ stagingRemoved, reservationsReleased });
}

function collectTopLevelRoots(manifest) {
  const roots = new Map();
  for (const entry of manifest.entries) {
    const name = entry.path.split('/')[0];
    if (roots.has(name)) continue;
    const declaredRoot = manifest.entries.find((candidate) => candidate.path === name);
    if (!declaredRoot) {
      throw new TypeError(`Transfer manifest top-level root is not declared: ${name}`);
    }
    roots.set(name, Object.freeze({ name, kind: declaredRoot.kind }));
  }
  return [...roots.values()].sort((left, right) => compareCodeUnits(left.name, right.name));
}

async function tryReserveTopLevel({ candidate, fsPromises, receiveRoot, reservationRoot, taskId }) {
  if (await hasWindowsEntry(receiveRoot, candidate, fsPromises)) return null;

  const reservationName = crypto
    .createHash('sha256')
    .update(windowsKey(candidate), 'utf8')
    .digest('hex');
  const reservationDirectory = path.join(reservationRoot, reservationName);
  assertContained(reservationRoot, reservationDirectory, 'Target reservation directory');

  const temporaryDirectory = path.join(
    reservationRoot,
    `.tmp-${taskId}-${crypto.randomBytes(8).toString('hex')}`
  );
  await fsPromises.mkdir(temporaryDirectory);
  let ownsReservation = false;
  try {
    await fsPromises.mkdir(path.join(temporaryDirectory, taskId));
    try {
      await fsPromises.rename(temporaryDirectory, reservationDirectory);
      ownsReservation = true;
    } catch (error) {
      if (!await pathExists(reservationDirectory, fsPromises)) throw error;
      await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
      return null;
    }

    if (await hasWindowsEntry(receiveRoot, candidate, fsPromises)) {
      await removeOwnedReservation(reservationDirectory, taskId, fsPromises);
      ownsReservation = false;
      return null;
    }
    return Object.freeze({ candidate, reservationDirectory });
  } catch (error) {
    if (ownsReservation) {
      await removeOwnedReservation(reservationDirectory, taskId, fsPromises).catch(() => {});
    } else {
      await fsPromises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function createStagingDirectories(targets, stagingDirectory, fsPromises) {
  const directories = new Set([stagingDirectory]);
  for (const target of targets) {
    if (target.kind === 'directory') directories.add(target.stagingPath);
    else directories.add(path.dirname(target.stagingPath));
  }

  const ordered = [...directories]
    .filter((directory) => directory !== stagingDirectory)
    .sort((left, right) => {
      const depthDifference = pathDepth(left) - pathDepth(right);
      return depthDifference || compareCodeUnits(left, right);
    });

  for (const directory of ordered) {
    assertContained(stagingDirectory, directory, 'Staging directory');
    await ensureSafeDirectory(directory, fsPromises, 'Staging directory');
  }
}

async function ensureSafeDirectory(directory, fsPromises, subject) {
  try {
    await fsPromises.mkdir(directory);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  await assertSafeDirectory(directory, fsPromises, subject);
}

async function assertSafeDirectoryChain(directory, fsPromises, subject) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  await assertSafeDirectory(current, fsPromises, subject);
  const relative = path.relative(parsed.root, directory);
  if (!relative) return;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    await assertSafeDirectory(current, fsPromises, subject);
  }
}

async function assertSafeDirectory(directory, fsPromises, subject) {
  const stat = await fsPromises.lstat(directory);
  if (stat.isSymbolicLink()) {
    throw new TypeError(`${subject} must not be a symbolic link or junction: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new TypeError(`${subject} must be a directory: ${directory}`);
  }
}

async function assertSafeTree(target, fsPromises) {
  const stat = await fsPromises.lstat(target);
  if (stat.isSymbolicLink()) {
    throw new TypeError(`Staging cleanup refuses symbolic links or junctions: ${target}`);
  }
  if (stat.isDirectory()) {
    const names = await fsPromises.readdir(target);
    for (const name of names) {
      await assertSafeTree(path.join(target, name), fsPromises);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new TypeError(`Staging cleanup refuses special filesystem entries: ${target}`);
  }
}

async function releaseTaskReservations(receiveRoot, taskId, fsPromises) {
  const reservationRoot = path.join(receiveRoot, RESERVATION_ROOT_NAME);
  const rootStat = await lstatIfExists(reservationRoot, fsPromises);
  if (!rootStat) return 0;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TypeError('Receive reservation directory must be a real directory');
  }

  let released = 0;
  const names = await fsPromises.readdir(reservationRoot);
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const reservationDirectory = path.join(reservationRoot, name);
    if (await removeOwnedReservation(reservationDirectory, taskId, fsPromises)) released += 1;
  }

  try {
    await fsPromises.rmdir(reservationRoot);
  } catch (error) {
    if (!error || !['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  return released;
}

async function removeOwnedReservation(reservationDirectory, taskId, fsPromises) {
  const stat = await lstatIfExists(reservationDirectory, fsPromises);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const names = await readdirIfExists(reservationDirectory, fsPromises);
  if (!names || names.length !== 1 || names[0] !== taskId) return false;
  const owner = path.join(reservationDirectory, taskId);
  const ownerStat = await lstatIfExists(owner, fsPromises);
  if (!ownerStat || ownerStat.isSymbolicLink() || !ownerStat.isDirectory()) return false;
  const ownerEntries = await readdirIfExists(owner, fsPromises);
  if (!ownerEntries || ownerEntries.length !== 0) return false;
  try {
    await fsPromises.rm(reservationDirectory, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readdirIfExists(directory, fsPromises) {
  try {
    return await fsPromises.readdir(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function hasWindowsEntry(directory, candidate, fsPromises) {
  const candidateKey = windowsKey(candidate);
  const names = await fsPromises.readdir(directory);
  return names.some((name) => windowsKey(name) === candidateKey);
}

function createRenamedComponent(component, kind, suffixNumber) {
  const suffix = ` (${suffixNumber})`;
  let stem = component;
  let extension = '';
  if (kind === 'file') {
    const parsed = path.parse(component);
    stem = parsed.name;
    extension = parsed.ext;
  }

  let budget = MAX_COMPONENT_BYTES - Buffer.byteLength(suffix + extension, 'utf8');
  if (budget < 1) {
    extension = '';
    budget = MAX_COMPONENT_BYTES - Buffer.byteLength(suffix, 'utf8');
    stem = component;
  }
  const truncatedStem = truncateUtf8(stem, budget).replace(/[. ]+$/u, '');
  if (!truncatedStem) throw new RangeError('Unable to create a safe conflict-free target name');
  return `${truncatedStem}${suffix}${extension}`;
}

function truncateUtf8(value, maximumBytes) {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximumBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function normalizeAbsoluteRoot(receiveRoot) {
  if (typeof receiveRoot !== 'string' || receiveRoot.length === 0 || !path.isAbsolute(receiveRoot)) {
    throw new TypeError('Receive root must be an absolute path');
  }
  return path.resolve(receiveRoot);
}

function normalizeFsPromises(value) {
  const candidate = value === undefined ? fs.promises : value;
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('fsPromises must be an object');
  }
  for (const method of ['lstat', 'mkdir', 'readdir', 'rename', 'rm', 'rmdir']) {
    if (typeof candidate[method] !== 'function') {
      throw new TypeError(`fsPromises.${method} must be a function`);
    }
  }
  return candidate;
}

function assertContained(root, candidate, subject) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return;
  }
  throw new TypeError(`${subject} escapes the receive root`);
}

async function lstatIfExists(target, fsPromises) {
  try {
    return await fsPromises.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(target, fsPromises) {
  return Boolean(await lstatIfExists(target, fsPromises));
}

function windowsKey(value) {
  return value.toUpperCase();
}

function pathDepth(value) {
  return value.split(path.sep).length;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertPlainObject(value, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}

function assertOnlyKeys(value, allowed, subject) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${subject} contains an unsupported field: ${key}`);
  }
}

function requireOwn(value, key, subject) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new TypeError(`${subject} is missing ${key}`);
  }
}

module.exports = {
  RESERVATION_ROOT_NAME,
  STAGING_PREFIX,
  STAGING_SUFFIX,
  cleanupReceiveStaging,
  planReceiveTargets
};


