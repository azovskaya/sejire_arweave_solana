import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { createHiddenInputParser } from './admin-hidden-input.mjs';

function parsed(...chunks) {
  const parser = createHiddenInputParser();
  let status;
  for (const chunk of chunks) status = parser.feed(Buffer.from(chunk));
  return { value: parser.value, status };
}

test('typed ASCII password preserves ordinary punctuation', () => {
  assert.deepEqual(parsed('Abc[123]~!\r'), { value: 'Abc[123]~!', status: { done: true, cancelled: false } });
});

test('bracketed paste strips both wrappers, even when events split them', () => {
  assert.equal(parsed('\x1b[200~ExamplePassword123!\x1b[201~\r').value, 'ExamplePassword123!');
  assert.equal(parsed('\x1b[2', '00~Ex', 'amplePassword123!\x1b[201', '~\r').value, 'ExamplePassword123!');
});

test('regression: old parser hashes bracketed paste wrappers as password characters', () => {
  const input = '\x1b[200~Abc123!\x1b[201~';
  let oldValue = '';
  for (const char of input) if (char >= ' ' && !char.startsWith('\x1b')) oldValue += char;
  assert.equal(oldValue, '[200~Abc123![201~');
  assert.equal(parsed(input, '\r').value, 'Abc123!');
});

test('typed Unicode survives split UTF-8 and NFC/NFD derive identical verifier', () => {
  const decomposed = 'Cafe\u0301 🌳';
  const encoded = Buffer.from(decomposed);
  const parser = createHiddenInputParser();
  for (const byte of encoded) parser.feed(Buffer.from([byte]));
  parser.feed(Buffer.from('\r'));
  assert.equal(parser.value, decomposed);
  const salt = Buffer.alloc(32, 7);
  assert.deepEqual(
    pbkdf2Sync(parser.value.normalize('NFC'), salt, 100, 32, 'sha256'),
    pbkdf2Sync('Café 🌳'.normalize('NFC'), salt, 100, 32, 'sha256'),
  );
});

test('backspace removes one Unicode code point', () => {
  assert.equal(parsed('Ab🌳\x7fC\bD\r').value, 'AbD');
});

test('Ctrl+C cancels and never completes or accepts later bytes', () => {
  const parser = createHiddenInputParser();
  assert.deepEqual(parser.feed(Buffer.from('secret\x03rest\r')), { done: false, cancelled: true });
  assert.equal(parser.value, 'secret');
  assert.deepEqual(parser.feed(Buffer.from('more\r')), { done: false, cancelled: true });
});

test('CSI, OSC, DCS and bracketed paste controls never enter password', () => {
  assert.equal(parsed('\x1b]0;terminal title\x07\x1b[31m\x1b[200~P@ss[!]~\x1b[201~\x1bPignored\x1b\\\x1b[0m\r').value, 'P@ss[!]~');
});
