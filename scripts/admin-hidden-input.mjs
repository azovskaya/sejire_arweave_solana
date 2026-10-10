import { StringDecoder } from 'node:string_decoder';

// A streaming parser is needed because terminals may split escape sequences and UTF-8
// characters across data events. Only printable input becomes part of the password.
export function createHiddenInputParser() {
  const decoder = new StringDecoder('utf8');
  let value = '';
  let state = 'text';
  let done = false;
  let cancelled = false;

  function feed(chunk) {
    if (done || cancelled) return { done, cancelled };
    for (const char of decoder.write(chunk)) {
      if (state === 'escape') {
        state = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text';
        if (char === 'P' || char === '^' || char === '_') state = 'string';
        continue;
      }
      if (state === 'csi') {
        if (char >= '@' && char <= '~') state = 'text';
        continue;
      }
      if (state === 'osc' || state === 'string') {
        if (char === '\u001b') state = state === 'osc' ? 'oscEscape' : 'stringEscape';
        else if (char === '\u0007' && state === 'osc') state = 'text';
        continue;
      }
      if (state === 'oscEscape' || state === 'stringEscape') {
        state = char === '\\' ? 'text' : state === 'oscEscape' ? 'osc' : 'string';
        continue;
      }
      if (char === '\u001b') { state = 'escape'; continue; }
      if (char === '\u009b') { state = 'csi'; continue; }
      if (char === '\u0003') { cancelled = true; break; }
      if (char === '\r' || char === '\n') { done = true; break; }
      if (char === '\u007f' || char === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
      if (char >= ' ' && char !== '\u007f' && !(char >= '\u0080' && char <= '\u009f')) value += char;
    }
    return { done, cancelled };
  }

  return { feed, get value() { return value; } };
}

export function readHidden(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Требуется интерактивный терминал.');
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const parser = createHiddenInputParser();
    function finish(error) {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(parser.value);
    }
    function onData(chunk) {
      const status = parser.feed(chunk);
      if (status.cancelled) finish(new Error('Отменено.'));
      else if (status.done) finish();
    }
    function onEnd() { finish(new Error('Ввод прерван.')); }
    input.on('data', onData);
    input.on('end', onEnd);
  });
}
