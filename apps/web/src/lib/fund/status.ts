import type { FundOrderView, FundVerification } from './client';

// These server responses are emitted before reserving/signing this order.
// A network error, HTTP 404 while polling, or an unknown error is never here.
export const rejectedBeforeReservation = new Set([
  'promo_invalid', 'promo_disabled', 'fund_exhausted', 'wallet_low',
  'fund_provider_unavailable', 'balance_unavailable', 'price_unavailable',
  'fund_prepare_failed', 'rate_limited',
]);

export const terminalFundStatus = (status?: string) =>
  status === 'COMPLETED' || status === 'FAILED' || status === 'RELEASED';

export function fundStatus(order: FundOrderView | null, verification?: FundVerification, submitting = false) {
  if (order?.status === 'COMPLETED') return {
    title: 'Семейная история сохранена',
    description: 'Arweave подтвердила сохранение. Архив доступен, его целостность проверена.',
    tone: 'success',
  };
  if (order?.status === 'FAILED' || order?.status === 'RELEASED') return {
    title: 'Сохранение не завершено',
    description: 'Эта попытка остановлена. Сведения о ней сохранены; завершение записи в Arweave не подтверждено.',
    tone: 'attention',
  };
  if (submitting) return {
    title: 'Отправляем запрос на сохранение',
    description: 'Фонд SEJIRE готовит и отправляет ваш зашифрованный архив.',
    tone: 'pending',
  };
  if (order?.status === 'NEEDS_RECONCILIATION' || verification?.stage === 'attention') {
    const reason = verification?.reason;
    if (reason === 'network_unavailable') return {
      title: 'Не удалось проверить сохранение',
      description: 'Не удалось получить данные Arweave для проверки. Продолжаем автоматически проверять эту же попытку. Повторно сохранять не нужно.',
      tone: 'attention',
    };
    const description = reason === 'archive_verification_failed'
      ? 'Проверка архива пока не пройдена. Продолжаем проверять уже созданную транзакцию.'
      : reason === 'reward_mismatch' || reason === 'transaction_mismatch'
        ? 'Данные транзакции требуют дополнительной проверки. Эта попытка сохранена в истории.'
        : 'Не удалось получить все подтверждения. Продолжаем проверять уже созданную транзакцию.';
    return { title: 'Проверяем состояние сохранения', description, tone: 'attention' };
  }
  if (verification?.stage === 'checking_archive' && verification.transactionConfirmed) return {
    title: 'Проверяем сохранённый архив',
    description: 'Транзакция подтверждена в Arweave. Проверяем, что архив можно скачать и он не повреждён.',
    tone: 'pending',
  };
  if (order?.status === 'RESERVED') return {
    title: 'Готовим архив к отправке',
    description: 'Запрос принят. Фонд выделил средства на хранение вашего архива.',
    tone: 'pending',
  };
  if (order?.status === 'SIGNED') return {
    title: 'Проверяем отправку архива',
    description: 'Транзакция подготовлена. Проверяем, приняла ли её сеть Arweave.',
    tone: 'pending',
  };
  if (order?.status === 'SUBMITTED' || order?.status === 'VERIFYING') return {
    title: 'Ждём подтверждения Arweave',
    description: 'Проверяем подтверждение транзакции и доступность архива. Статус обновляется автоматически.',
    tone: 'pending',
  };
  return {
    title: 'Проверяем состояние сохранения',
    description: 'Уточняем результат уже отправленного запроса. Новый запрос на сохранение не создаётся.',
    tone: 'attention',
  };
}

export function fundError(error: unknown, preflight = false) {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    promo_invalid: 'Неверный промокод. Проверьте его и попробуйте ещё раз.',
    promo_disabled: 'Промокод временно недоступен.',
    fund_exhausted: 'Лимит бесплатных сохранений исчерпан.',
    wallet_low: 'Фонд временно не может оплатить хранение.',
    fund_provider_unavailable: 'Сервис фонда временно недоступен.',
    balance_unavailable: 'Не удалось проверить средства фонда. Попробуйте позже.',
    price_unavailable: 'Не удалось получить стоимость хранения. Попробуйте позже.',
    fund_prepare_failed: 'Подготовить сохранение пока не удалось. Попробуйте позже.',
    rate_limited: 'Слишком много запросов. Подождите немного и попробуйте снова.',
    fund_sign_failed: 'Подготовить транзакцию не удалось. Проверяем состояние запроса.',
    archive_changed: 'Архив отличается от исходного. Сначала нужно проверить прежнюю попытку.',
    order_not_found: 'Сервер пока не нашёл этот запрос. Продолжаем проверять его статус; новая попытка не создаётся.',
    storage_unavailable: 'Браузер не смог сохранить сведения о запросе. Разрешите хранение данных сайта или откройте SEJIRE в обычном окне современного браузера.',
    invalid_saved_order: 'Не удалось прочитать сведения о прежней попытке. Новый запрос не отправлен.',
    fund_attempt_in_progress: 'Для этого дерева уже начато сохранение. Закройте окно и нажмите «Продолжить сохранение», чтобы увидеть его результат.',
  };
  return messages[code] || (preflight
    ? 'Не удалось проверить промокод. Проверьте подключение и попробуйте снова.'
    : 'Не удалось обновить статус. Проверим снова автоматически. Можно проверить сейчас.');
}
