import type { DirectErrorCode } from './types';

export class DirectError extends Error {
  readonly code: DirectErrorCode;
  constructor(code: DirectErrorCode) { super(code); this.name = 'DirectError'; this.code = code; }
}
export function requireDirect(condition: unknown, code: DirectErrorCode): asserts condition {
  if (!condition) throw new DirectError(code);
}
export function directErrorCode(error: unknown, fallback: DirectErrorCode = 'network_unavailable'): DirectErrorCode {
  return error instanceof DirectError ? error.code : fallback;
}
const messages: Record<DirectErrorCode, string> = {
  invalid_archive: 'Архив не прошёл проверку. Исходные данные сохранены.',
  archive_too_large: 'Размер архива превышает поддерживаемый предел.',
  invalid_operation: 'Запись сохранения не прошла проверку. Новая подпись не запрашивается.',
  operation_missing: 'Эта попытка сохранения не найдена в браузере.',
  storage_unavailable: 'Браузер не смог надёжно сохранить прогресс. Отправка остановлена.',
  storage_conflict: 'Состояние изменилось в другом окне. Продолжите существующую попытку.',
  browser_locks_required: 'Этот браузер не поддерживает безопасное согласование сохранений между вкладками.',
  pending_direct_operation: 'У этого семейного архива есть незавершённое сохранение. Продолжите его.',
  invalid_node: 'Укажите публичный HTTPS-адрес узла без логина, пароля и пути.',
  network_unavailable: 'Узлы Arweave пока не ответили. Подписанная попытка сохранена.',
  network_rate_limited: 'Узел Arweave временно ограничил запросы. Проверьте результат позже.',
  wrong_network: 'Узел отвечает из другой сети. Данные не приняты.',
  operation_cancelled: 'Проверка остановлена. Сохранённый прогресс остаётся в браузере.',
  wallet_unavailable: 'Подключите совместимый Arweave-кошелёк в этом браузере.',
  wallet_changed: 'Адрес кошелька изменился. Проверьте выбранный аккаунт.',
  wallet_rejected: 'Подпись отклонена в кошельке. Данные не отправлены.',
  signature_pending: 'Результат прежнего запроса подписи ещё неизвестен. Новая подпись не запрашивается.',
  signature_invalid: 'Кошелёк вернул неподходящую подпись. Данные не отправлены.',
  quote_required: 'Сначала получите цену хранения для выбранного кошелька.',
  quote_changed: 'Цена изменилась. Получите новую цену перед подтверждением.',
  quote_expired: 'Срок показанной цены истёк. Получите новую цену.',
  insufficient_ar: 'На выбранном кошельке недостаточно AR для показанной цены хранения.',
  invalid_reward: 'Узел вернул некорректную цену Arweave.',
  upload_pending: 'Отправка ещё не закончена. Продолжится та же подписанная транзакция.',
  confirmation_pending: 'Транзакция отправлена; подтверждение сети ещё ожидается.',
  archive_unavailable: 'Подтверждение сети получено, но байты архива пока недоступны. Новая оплата не нужна.',
  archive_integrity_failed: 'Полученный архив не совпадает с сохранёнными байтами. Результат не принят.',
  receipt_invalid: 'Квитанция сохранения не прошла проверку.',
  not_complete: 'Подтверждение и публичные байты архива ещё не проверены.',
};
export function directErrorMessage(error: unknown): string {
  return messages[directErrorCode(error)];
}
