import type { Config } from './config';
import { envelopeDigest } from '../solana/policy';
import { parseEnvelope, serializeEnvelope } from '../crypto/envelope';
/** Owner-approved single manual pilot. Not an on-chain/global spending lock. */
export const PILOT = Object.freeze({
 address:'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI',
 manager:'F8XB2iSMf8mB6fPhtwGRDjuT8wTypfARN5pscu3fjqKN',
 service:'ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd',
 fund:'Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN',
 bytes:28365,digest:'19133b897f69e1f0d43a55217a00adee6b6dfefb73f0f6228008f5c8a702e6c8',
 vaultId:'449d6c6e8cec7700807278bc765ba116',maximum:'4000000000',
 fileBytes:28394,fileDigest:'003dcc12544779dce94db4e2f2395059f43bc160fff76272658ae5b6702dbdb8'
});
export const pilotEnabled=()=>import.meta.env?.VITE_NATIVE_AR_PILOT==='1';
export function assertPilotBinding(address:string,digest:string,bytes:number,reward:string) {
 if(address!==PILOT.address||digest!==PILOT.digest||bytes!==PILOT.bytes)throw Error('archive_not_authorized_for_pilot');
 if(!/^[1-9]\d*$/.test(reward)||BigInt(reward)>BigInt(PILOT.maximum))throw Error('pilot_reward_limit');
}
export function assertPilotConfig(c:Config) {
 if(c.environment!=='devnet'||c.arweaveNetwork!=='arweave.N.1'||c.serviceLamports!=='30000000'||c.wallets.service!==PILOT.service||c.wallets.fund!==PILOT.fund||c.wallets.arReserve!==PILOT.address||!c.managers.includes(PILOT.manager))throw Error('pilot_configuration_mismatch');
 if(c.upload.maxRewardWinston!==PILOT.maximum)throw Error('pilot_budget_not_confirmed');
}
export async function assertPilotData(address:string,data:string,reward:string) {
 assertPilotBinding(address,await envelopeDigest(data),new TextEncoder().encode(data).length,reward);
 const envelope=parseEnvelope(JSON.parse(data));if(envelope.vault_id!==PILOT.vaultId)throw Error('archive_not_authorized_for_pilot');
}
export async function importPilotArchive(file:File) {
 if(file.size!==PILOT.fileBytes)throw Error('pilot_file_mismatch');
 const raw=await file.text();if(await envelopeDigest(raw)!==PILOT.fileDigest)throw Error('pilot_file_mismatch');
 const envelope=parseEnvelope(JSON.parse(raw));await assertPilotData(PILOT.address,serializeEnvelope(envelope),PILOT.maximum);return envelope;
}
/** Read-only failures cannot imply that a wallet operation or payment has started. */
export function nativeReadMessage(message:string) {
 const code=message.replaceAll('-', '_');
 const messages:Record<string,string>={
  rpc_timeout:'Сеть не ответила вовремя. Попробуйте ещё раз.',
  rpc_rate_limited:'Сеть временно ограничила число запросов. Попробуйте ещё раз позже.',
  rpc_unavailable:'Сеть временно недоступна. Попробуйте ещё раз.',
  wrong_network:'Узел отвечает из другой сети. Данные не приняты.'
 };
 return messages[code]??(/[А-Яа-яЁё]/.test(message)?message:'Не удалось получить данные. Ранее проверенные данные сохранены; попробуйте ещё раз.');
}
export function nativeMessage(message:string) {
 const messages:Record<string,string>={
  "unknown_order_configuration": "Настройки этой подготовки не найдены. История сохранена. Продолжите проверку прежнего сохранения; новая оплата не запускается автоматически.",
  "saving_replaced": "Эта подготовка осталась в истории. Продолжите связанное новое сохранение; оплатить прежнюю подготовку нельзя.",
  "conflicting_successors": "Найдено несколько связанных подготовок. История сохранена; нужна проверка владельца. Новая оплата не запускается.",
  "message_signature_not_supported": "Phantom не поддерживает подпись создания сохранения. Оплата не запускалась.",
  "invalid_message_signature": "Подпись создания сохранения не прошла проверку. Оплата не запускалась.",
  "archive_binding": "Архив не совпадает с выбранным сохранением. Исходные данные сохранены; нужна проверка владельца.",
  "archive_not_authorized_for_pilot": "Этот архив не входит в разрешение владельца. Оплата не запускалась.",
  "payer_changed": "В Phantom выбран другой кошелёк. Выберите кошелёк прежнего сохранения.",
  "missing_metadata": "Сеть вернула неполные данные. Прогресс сохранён; повторите проверку позже.",
  "invalid_native_job": "Запись сохранения не прошла проверку. Исходные данные сохранены; нужна проверка владельца.",
  "order_policy_binding": "Условия сохранения не совпадают с настройками проекта. Новая оплата не запускалась.",
  "rpc_unavailable": "Сеть временно недоступна. Прогресс сохранён; повторите проверку позже.",
  "rpc_timeout": "Сеть пока не отвечает. Оплата не повторяется.",
  "conflicting_payment_result": "Ответ сети противоречит ранее подтверждённой оплате. Прежний результат сохранён; новая оплата заблокирована до выяснения конфликта.",
  "transaction_failed": "Сеть окончательно подтвердила неуспешную транзакцию. Сохранение не оплачено; подпись и комиссия прежней попытки остаются в истории.",
  "invalid_amount": "Введите сумму SOL через точку, без знака и экспоненты.",
  "excess_precision": "В SOL допустимо не более девяти цифр после точки. Сумма не округлялась.",
  "technical_amount_overflow": "Сумма превышает технический числовой диапазон Solana. Это не ограничение программы поддержки.",
  "cache_unavailable": "Сохранённое состояние недоступно. Не начинайте новую оплату; сохраните резервную копию и восстановите прежнее задание.",
  "signed_payment_expired_not_broadcast": "Срок подписанного заказа истёк. Отправка остановлена; прежняя подпись сохранена для сверки.",
  "phantom_not_found": "Phantom не найден. Откройте приложение в браузере с расширением Phantom.",
  "wallet_not_connected": "Подключите Phantom, чтобы подтвердить заказ.",
  "wallet_changed": "Подключённый аккаунт изменился. Подпись не принята; проверьте выбранный кошелёк.",
  "wallet_changed_transaction": "Кошелёк вернул изменённую транзакцию или другой аккаунт. Результат требует сверки; повторная оплата заблокирована.",
  "signed_message_expired_requires_reconciliation": "Срок подписанного подтверждения истёк. Отправка не повторена; требуется окончательная сверка прежней подписи.",
  "management_threshold": "Для применения настроек пока не хватает подписей управляющих.",
  "signature_cancelled": "Подпись явно отклонена. Перевод не отправлялся; повтор возможен только с новым подтверждением.",
  "requires_reconciliation": "Подтверждение сети пока не получено. Подписанная попытка сохранена; новый платёж не создаётся.",
  "cache_commit_failed": "Не удалось сохранить журнал на устройстве. Отправка остановлена; сохраните резервный файл.",
  "wallet_transaction_signing_unavailable": "Подключённый кошелёк не поддерживает нужную подпись транзакции. Окно оплаты не вызвано.",
  "trusted_genesis_required": "Настройки проекта ещё не восстановлены. Используйте сохранённый файл доверия.",
  "untrusted_genesis": "Корень доверия не совпадает. Настройки не применены.",
  "invalid_or_unauthorized_signature": "Подпись создания сохранения не прошла проверку. Оплата не запускалась.",
  "prepared_message_expired": "Срок подготовленного подтверждения истёк до вызова кошелька. Нажмите «Продолжить сохранение», чтобы обновить подготовку.",
  "previous_payment_requires_reconciliation": "Предыдущая попытка требует проверки. Повторная оплата заблокирована.",
  "fee_or_balance_not_ready": "Не удалось подготовить оплату: проверьте доступный баланс тестового SOL и повторите подготовку. Средства на этом шаге не переводились.",
  "order_expired": "Срок подписанного заказа истёк. Его условия не изменены; сначала требуется завершить проверку прежней попытки.",
  "manual_executor_not_accepting_orders": "Сохранение временно недоступно. Ваше дерево не потеряно; попробуйте позже.",
  "manual_executor_window_expired": "Сохранение временно недоступно. Ваше дерево не потеряно; попробуйте позже.",
  "signed_configuration_required": "Настройки проекта ещё не подтверждены. Сохранение временно недоступно; дерево осталось на устройстве.",
  "pilot_budget_not_confirmed": "Расход хранения ещё не подтверждён владельцем. Оплата не запускалась.",
  "ar_budget_unavailable": "Недостаточно AR на резерве или стоимость превышает подписанный бюджет.",
  "mainnet_broadcast_disabled_pending_owner_approval": "Отправка этого архива выключена владельцем.",
  "pilot_file_mismatch": "Выберите исходный файл sejire-vault-449d6c6e.json. Его размер или SHA-256 не совпадает.",
  "pilot_configuration_mismatch": "Настройки проекта не соответствуют разрешению владельца. Оплата не запускалась.",
  "pilot_reward_limit": "Стоимость превышает разрешённые 0.004 AR. Отправка остановлена.",
  "existing_snapshot_upload": "Этот архив уже передан на сохранение. Продолжите прежнюю загрузку из списка сохранений; второй расход заблокирован.",
  "wallet_response_timeout": "Кошелёк не ответил за минуту. Это не отменяет подтверждение. Прежняя попытка сохранена; новая оплата не запускается. Закройте экран и позже проверьте прежнюю операцию.",
  "exact_consent_required": "Подтвердите показанную сумму и сеть перед оплатой.",
  "manager_not_authorized": "Этот кошелёк не может управлять проектом. Настройки и прежняя попытка не изменены.",
  "devnet_risk_test_not_allowed": "Новый тест с неизвестной прежней оплатой разрешён только в тестовой сети и с согласия владельца.",
  "existing_attempt_resume_only": "Подпись загрузки уже начиналась. Продолжите сохранённую операцию; при неизвестном результате новая подпись запрещена.",
  "message": "Не удалось завершить действие. Прогресс сохранён; не повторяйте оплату. Подробности доступны в диагностике владельца."
};
 return messages[message]??(/[А-Яа-яЁё]/.test(message)?message:"Не удалось закончить этот шаг. Прогресс сохранён; нужна проверка владельца. Новая оплата не запускается автоматически.");
}
