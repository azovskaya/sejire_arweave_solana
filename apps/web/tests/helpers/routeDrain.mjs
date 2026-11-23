// Keep one interception chain installed until fixture disposal. Teardown must
// not add a competing page route or expose late requests to the real network.
const contexts = new WeakMap();

export async function installRouteMock(context, handler) {
  let state = contexts.get(context);
  if (!state) {
    state = { closing: false, pending: new Set(), failures: [] };
    contexts.set(context, state);
  }
  if (state.closing) throw Error('Cannot install a mock after route draining started');
  await context.route('**/*', route => {
    if (state.closing) return route.abort('blockedbyclient');
    const task = Promise.resolve().then(() => handler(route)).catch(error => {
      state.failures.push(error);
      throw error;
    }).finally(() => state.pending.delete(task));
    // Register synchronously before the handler can await its local response.
    state.pending.add(task);
    return task;
  });
}

export async function drainRouteMocks(context) {
  const state = contexts.get(context);
  if (!state) return;
  state.closing = true;
  await Promise.allSettled([...state.pending]);
  if (state.failures.length) throw new AggregateError(state.failures, 'Mock route handlers failed');
  // Leave the closing guard installed. The fixture closes the context next.
}
