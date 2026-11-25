/** In-memory authority and request lifetime. Never persists or serializes credentials. */
export type AdminRequest = Readonly<{ credential: string; generation: number; signal: AbortSignal }>;

export class AdminScope {
  private credential = '';
  private generation = 0;
  private active: AbortController | null = null;

  replace(credential: string): void {
    this.clear();
    this.credential = credential;
  }
  clear(): void {
    this.generation++;
    this.active?.abort();
    this.active = null;
    this.credential = '';
  }
  begin(): AdminRequest {
    if (!this.credential) throw Error('admin_unauthorized');
    if (this.active) throw Error('admin_request_in_progress');
    this.active = new AbortController();
    return { credential: this.credential, generation: this.generation, signal: this.active.signal };
  }
  current(request: AdminRequest): boolean {
    return Boolean(this.credential) && request.generation === this.generation &&
      this.active?.signal === request.signal && !request.signal.aborted;
  }
  finish(request: AdminRequest): void {
    if (this.current(request)) this.active = null;
  }
}

export function parseAdminAr(value: string): string {
  if (!/^(0|[1-9][0-9]{0,5})(?:\.[0-9]{1,12})?$/.test(value)) throw Error('invalid_ar_amount');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'))).toString();
}

const messages: Record<string, string> = {
  admin_unauthorized: 'Неверный пароль или доступ администратора отозван.',
  admin_off: 'Серверный доступ администратора ещё не настроен.',
  admin_request_in_progress: 'Дождитесь завершения текущего запроса.',
  admin_readback_mismatch: 'Настройки изменились одновременно в другой сессии. Проверьте данные после обновления.',
  admin_response_invalid: 'Сервер вернул неполные данные. Изменение не подтверждено.',
  fund_api_not_configured: 'Адрес сервера управления не настроен в этом выпуске.',
  invalid_fund_endpoint: 'Адрес сервера управления настроен неверно.',
  origin_denied: 'Сервер пока не разрешает управление с этого адреса сайта.',
  limit_below_spent: 'Лимит не может быть меньше подтверждённых расходов.',
  limit_below_reserved: 'Лимит не может быть меньше расходов вместе с действующими резервами.',
  invalid_ar_amount: 'Введите сумму AR без пробелов: до 12 цифр после точки.',
  fund_provider_unavailable: 'Узел или кошелёк фонда временно недоступен.',
  invalid_promo_format: 'Промокод: 6–64 латинские буквы, цифры или дефисы.',
  promo_confirmation_mismatch: 'Два ввода промокода не совпадают.',
  promo_missing: 'Сначала задайте промокод.',
  fund_ledger_inconsistent: 'Журнал фонда требует проверки. Новые сохранения не включайте.',
  rate_limited: 'Слишком много запросов. Повторите позднее.',
  treasury_revision_conflict: 'Состояние фонда уже изменилось. Обновите пополнения и повторно проверьте сумму и транзакцию.',
  topup_idempotency_conflict: 'Эта заявка уже зарегистрирована с другими данными. Загрузите её из журнала пополнений.',
  topup_transaction_used: 'Этот перевод уже учтён в другом пополнении. Повторное зачисление невозможно.',
  topup_transaction_mismatch: 'Перевод не соответствует заявке: проверьте адрес получателя, точную сумму AR и источник перевода.',
  topup_not_confirmed: 'Перевод пока не получил нужное число подтверждений. Дождитесь подтверждений и проверьте его снова.',
  topup_precedes_intent: 'Перевод сделан до подготовки заявки. Его нельзя повторно учитывать как новое пополнение.',
  topup_proof_unavailable: 'Сейчас невозможно проверить перевод на двух узлах Arweave. Пополнение ещё не подтверждено; повторите проверку позднее.',
  invalid_topup_request: 'Проверьте адрес фонда, сумму пополнения и публичный идентификатор транзакции Arweave.',
  topup_not_found: 'Заявка пополнения не найдена. Обновите журнал и выберите нужную заявку.',
  treasury_not_configured: 'Кошелёк фонда ещё не настроен на сервере.',
  topup_intent_mismatch: 'В подписанном переводе нет точного тега этой заявки. Проверьте имя и значение тега; другой перевод повторно не отправляйте без проверки.',
  topup_legacy_intent_requires_review: 'Старая заявка не содержит обязательного тега. Требуется проверка прежнего пополнения перед новой заявкой.',
  topup_transfer_invalid: 'Подписанный перевод не соответствует реквизитам заявки. Отправка остановлена.',
  topup_transfer_conflict: 'Для этой заявки уже закреплена другая подготовка перевода. Обновите состояние; новую подпись не запрашивайте.',
  topup_transfer_storage: 'Браузер не смог надёжно сохранить перевод. Отправка остановлена; сохранённая подпись не заменяется новой.',
  topup_transfer_lock: 'Браузер не поддерживает защиту от одновременных переводов. Откройте админку в актуальном браузере с HTTPS.',
  topup_signature_pending: 'Результат подписи пока не подтверждён. Проверьте прежнее окно Wander и обновите сохранённую подпись. Новая подпись для этой заявки заблокирована.',
  topup_transfer_unresolved: 'Для этой заявки ещё не сохранена подпись перевода. Вернитесь к прежнему окну Wander и проверьте сохранённую подпись.',
  topup_submission_unknown: 'Результат отправки неизвестен. Сначала проверьте перевод; повторная отправка использует только ту же подписанную транзакцию.',
  wallet_unavailable: 'Откройте эту страницу в браузере с установленным кошельком Wander.',
  wallet_changed: 'В Wander выбран другой кошелёк. Обновите реквизиты перед подписью.',
  quote_expired: 'Оценка комиссии устарела. Рассчитайте её заново перед подписью.',
  quote_changed: 'Комиссия изменилась. Рассчитайте её заново и проверьте итог.',
  insufficient_ar: 'В выбранном кошельке недостаточно AR для суммы перевода вместе с комиссией.',
  wrong_network: 'Узел не подтвердил сеть Arweave Mainnet. Перевод не отправлен.',
  signature_invalid: 'Кошелёк вернул подпись с другими реквизитами. Перевод не отправлен.',
  network_unavailable: 'Узел Arweave недоступен. Сохранённая подпись не заменяется; повтор отправит тот же перевод.',
  network_rate_limited: 'Узел временно ограничил запросы. Подождите и продолжите тот же перевод.',
  operation_cancelled: 'Действие остановлено. Сохранённая подпись остаётся доступной для проверки и продолжения.',
};

export function adminError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return messages[code] ?? 'Не удалось подтвердить результат запроса. Обновите данные перед повторным действием.';
}
