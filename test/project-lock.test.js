const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ProjectLocks, ProjectBusy, identify, assertOwned} = require('../src-main/project-lock');

test('lock ownership is verified and a live or unreadable record stays in place', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-d3-lock-'));
  t.after(() => fs.rmSync(dir, {force: true, recursive: true}));
  const file = path.join(dir, 'Project.sb3');
  fs.writeFileSync(file, 'project fixture');
  const identity = identify(file);
  const locks = new ProjectLocks(path.join(dir, 'locks'));
  const lease = locks.acquire(identity, process.pid);
  assertOwned(lease);
  assert.throws(() => locks.acquire(identity, process.pid), ProjectBusy);
  assert.throws(() => assertOwned({...lease, token: 'incorrect'}), /no longer owns/);
  locks.release({...lease, token: 'incorrect'});
  assertOwned(lease);
  fs.writeFileSync(lease.file, '{unreadable');
  assert.throws(() => locks.check(identity), /cannot be read/);
  assert.equal(fs.readFileSync(lease.file, 'utf8'), '{unreadable');
});

test('a symlink resolves to the same SB3 and hard-linked projects are rejected', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-d3-alias-'));
  t.after(() => fs.rmSync(dir, {force: true, recursive: true}));
  const file = path.join(dir, 'Project.sb3');
  const alias = path.join(dir, 'Alias.sb3');
  const hardLink = path.join(dir, 'HardLink.sb3');
  fs.writeFileSync(file, 'project fixture');
  fs.symlinkSync(file, alias);
  assert.deepEqual(identify(alias), identify(file));
  fs.linkSync(file, hardLink);
  assert.throws(() => identify(file), /hard links/);
  assert.throws(() => identify(hardLink), /hard links/);
});
