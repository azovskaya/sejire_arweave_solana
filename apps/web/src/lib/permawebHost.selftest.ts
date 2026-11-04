import assert from 'node:assert/strict';
import { isStaticPermawebHost } from './permawebHost';

assert.equal(isStaticPermawebHost('sejire.ar.io'), true);
assert.equal(isStaticPermawebHost('xyz.ar.io'), true);
assert.equal(isStaticPermawebHost('abcd.arweave.net'), true);
assert.equal(isStaticPermawebHost('abcd.arweave.dev'), true);
assert.equal(isStaticPermawebHost('azovskaya.github.io'), false);
assert.equal(isStaticPermawebHost('localhost'), false);
assert.equal(isStaticPermawebHost('127.0.0.1'), false);
assert.equal(isStaticPermawebHost(''), false);
assert.equal(isStaticPermawebHost(undefined), false);
assert.equal(isStaticPermawebHost(null), false);
console.log('permawebHost.selftest: OK');
