/** Bound wallet and read-only RPC waits without treating a late response as a new operation. */
export function withTimeout<T>(pending: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error(code)), milliseconds);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
