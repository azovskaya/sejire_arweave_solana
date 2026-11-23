import test from 'node:test';
import assert from 'node:assert/strict';
import { installRouteMock, drainRouteMocks } from './routeDrain.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function contextFixture() {
  const handlers = [];
  return { handlers, route: async (pattern, handler) => {
    assert.equal(pattern, '**/*'); handlers.push(handler);
  } };
}

test('draining waits for a running response and blocks later requests without changing interception', async () => {
  const context = contextFixture(), response = deferred();
  let calls = 0, fulfilled = 0, blocked = 0, drained = false;
  await installRouteMock(context, async route => { calls++; await response.promise; await route.fulfill(); });
  const running = context.handlers[0]({ fulfill: async () => { fulfilled++; } });
  const drain = drainRouteMocks(context).then(() => { drained = true; });
  await context.handlers[0]({ abort: async reason => { assert.equal(reason, 'blockedbyclient'); blocked++; } });
  assert.equal(drained, false); assert.equal(calls, 1); assert.equal(fulfilled, 0); assert.equal(blocked, 1);
  assert.equal(context.handlers.length, 1);
  response.resolve(); await Promise.all([running, drain]);
  assert.equal(fulfilled, 1); assert.equal(drained, true);
  await context.handlers[0]({ abort: async () => { blocked++; } });
  assert.equal(blocked, 2); assert.equal(calls, 1); assert.equal(context.handlers.length, 1);
});

test('one rejected handler cannot finish draining before another running handler', async () => {
  const context = contextFixture(), first = deferred(), second = deferred(), failure = Error('synthetic assertion');
  let drained = false;
  await installRouteMock(context, route => route.response.promise);
  const a = context.handlers[0]({ response: first }), b = context.handlers[0]({ response: second });
  const rejected = assert.rejects(a, error => error === failure);
  const drain = drainRouteMocks(context).finally(() => { drained = true; });
  const drainRejected = assert.rejects(drain, error => error instanceof AggregateError && error.errors[0] === failure);
  first.reject(failure); await rejected;
  assert.equal(drained, false);
  second.resolve(); await Promise.all([b, drainRejected]);
  assert.equal(drained, true);
});

test('a previously completed failure remains a failed drain', async () => {
  const context = contextFixture(), failure = Error('response rejected');
  await installRouteMock(context, () => { throw failure; });
  await assert.rejects(context.handlers[0]({}), error => error === failure);
  await assert.rejects(drainRouteMocks(context), error => error instanceof AggregateError && error.errors[0] === failure);
  await assert.rejects(installRouteMock(context, () => {}), /draining started/);
});

test('draining one context does not change another context', async () => {
  const first = contextFixture(), second = contextFixture();
  let calls = 0;
  await installRouteMock(first, () => { throw Error('closed handler must not run'); });
  await installRouteMock(second, () => { calls++; });
  await drainRouteMocks(first);
  await second.handlers[0]({}); await drainRouteMocks(second);
  assert.equal(calls, 1);
});
