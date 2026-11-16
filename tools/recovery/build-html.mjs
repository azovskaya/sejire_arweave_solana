/** Reproducible self-contained HTML from the same decoder used by the CLI. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = await readFile(new URL('./recover.mjs', import.meta.url), 'utf8');
const cliStart = source.indexOf('export const USAGE =');
const wordsStart = source.indexOf('// BEGIN BIP39 WORDLIST');
const nodeStart = source.indexOf('\nif (typeof process');
if (cliStart < 0 || wordsStart < cliStart || nodeStart < wordsStart) throw Error('recovery_html_source_markers');
const core = (source.slice(0, cliStart) + source.slice(wordsStart, nodeStart))
  .replace(/^#![^\n]*\n/, '').replace(/^export /gm, '');
const ui = `
const fileInput = document.getElementById('archive');
const wordInput = document.getElementById('words');
const form = document.getElementById('recover-form');
const submit = document.getElementById('recover');
const clear = document.getElementById('clear');
const status = document.getElementById('status');
const errorBox = document.getElementById('error');
const download = document.getElementById('download');
let downloadUrl = null, busy = false;
function clearResult() {
  if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null; download.hidden = true; download.removeAttribute('href');
  status.textContent = ''; errorBox.textContent = '';
}
clear.addEventListener('click', () => {
  if (busy) return;
  clearResult(); wordInput.value = ''; fileInput.value = ''; wordInput.focus();
});
fileInput.addEventListener('change', clearResult);
wordInput.addEventListener('input', clearResult);
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  clearResult();
  const file = fileInput.files?.[0];
  if (!file) { errorBox.textContent = 'Выберите зашифрованный архив или recovery kit.'; return; }
  if (file.size > MAX_INPUT_FILE_BYTES) { errorBox.textContent = 'Файл превышает предел 64 MiB.'; return; }
  busy = true; submit.disabled = true; clear.disabled = true; fileInput.disabled = true; wordInput.disabled = true;
  status.textContent = 'Проверяем файл и расшифровываем на этом устройстве…';
  let result;
  try {
    result = await recoverText(await file.text(), wordInput.value);
    const blob = new Blob([result.plaintext], { type: 'application/json' });
    downloadUrl = URL.createObjectURL(blob); download.href = downloadUrl; download.hidden = false;
    wordInput.value = '';
    status.textContent = 'Архив расшифрован. Скачайте приватный JSON: он содержит семейные данные без шифрования.';
  } catch (error) {
    status.textContent = '';
    const messages = {
      invalid_words: 'Проверьте 12 слов SEJIRE и их порядок.',
      vault_id_mismatch: 'Эти слова не соответствуют выбранному архиву.',
      decrypt_failed: 'Не удалось проверить расшифровку. Проверьте слова и сохранность файла.',
      webcrypto_unavailable: 'Браузер не предоставляет WebCrypto. Используйте сохранённый recover.mjs с Node 22+.',
      archive_integrity_failed: 'Размер или digest recovery kit не совпадает с исходными байтами.',
      receipt_mismatch: 'Квитанция не соответствует архиву в этом kit.',
    };
    errorBox.textContent = messages[error instanceof RecoveryError ? error.code : ''] ?? 'Файл не прошёл проверку формата. Исходный архив не изменён.';
  } finally {
    result?.plaintext.fill(0); busy = false; submit.disabled = false; clear.disabled = false;
    fileInput.disabled = false; wordInput.disabled = false;
  }
});
window.addEventListener('pagehide', () => { if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl); });
`;
const script = '\n' + core + '\n' + ui + '\n';
const style = `
:root{font-family:system-ui,sans-serif;color:#25251f;background:#f5f3ec;line-height:1.55;color-scheme:light}
body{margin:0;padding:24px}main{max-width:680px;margin:24px auto;background:#fff;padding:32px;border:1px solid #d7d6cc;border-radius:12px}
h1{font-size:1.65rem;line-height:1.2;margin:0 0 18px}p{margin:12px 0}label{display:block;font-weight:600;margin-top:20px}
input,textarea,button{font:inherit}input[type=file]{display:block;width:100%;margin-top:8px}textarea{box-sizing:border-box;width:100%;padding:12px;margin-top:8px;border:1px solid #777;border-radius:6px;resize:vertical}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}button,.download{padding:10px 16px;border-radius:6px;border:1px solid #335b43;background:#335b43;color:white;font-weight:600;cursor:pointer}
button.secondary{color:#335b43;background:white}button:disabled{opacity:.6;cursor:wait}.download{display:inline-block;text-decoration:none;margin:12px 0}[hidden]{display:none!important}
:focus-visible{outline:3px solid #ba6d20;outline-offset:3px}#error{color:#8f2020}small{display:block;color:#555;margin-top:24px}
@media(max-width:520px){body{padding:12px}main{padding:20px;margin:8px auto}}
`;
const hash = value => createHash('sha256').update(value).digest('base64');
const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'">
<title>SEJIRE — независимое восстановление</title><style>${style}</style></head>
<body><main><h1>Открыть архив без сервера</h1>
<p>Выберите сохранённый зашифрованный JSON или recovery kit. Эта страница расшифровывает файл на вашем устройстве; доступ к сети не нужен.</p>
<p>Нужны <strong>12 слов архива SEJIRE</strong>. Не вводите фразу платёжного кошелька. Квитанция без ciphertext не заменяет файл архива.</p>
<form id="recover-form">
<label for="archive">Зашифрованный архив или recovery kit</label><input id="archive" type="file" accept=".json,application/json" required>
<label for="words">12 слов SEJIRE</label><textarea id="words" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" required></textarea>
<div class="actions"><button id="recover" type="submit">Восстановить файл</button><button id="clear" type="button" class="secondary">Очистить</button></div></form>
<p id="status" role="status" aria-live="polite"></p><p id="error" role="alert"></p>
<a id="download" class="download" download="sejire-restored-private.json" hidden>Скачать приватный JSON</a>
<small>Результат содержит все данные и историю из выбранного архива без преобразований. Он не зашифрован. Проверка файла не подтверждает публикацию в блокчейне или полноту всех сетевых версий. Слова не сохраняются в браузерном хранилище; после работы закройте страницу. Формат и способ чтения независимой программой описаны в FORMAT.md из того же набора.</small>
</main><script type="module">${script}</script></body></html>
`;
const target = new URL('./recovery.html', import.meta.url);
if (process.argv[2] === '--check') {
  if (await readFile(target, 'utf8') !== html) throw Error('recovery_html_needs_rebuild');
  console.log('PASS: offline HTML exactly matches the decoder and its CSP hashes.');
} else {
  if (process.argv.length > 2) throw Error('usage');
  await writeFile(target, html);
  console.log('Built ' + fileURLToPath(target));
}
