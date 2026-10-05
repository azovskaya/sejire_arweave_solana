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
export function nativeMessage(message:string) {
 return ({signed_payment_expired_not_broadcast:'Срок подписанного заказа истёк. Отправка остановлена; прежняя подпись сохранена для сверки.',phantom_not_found:'Phantom не найден. Откройте приложение в браузере с расширением Phantom.',wallet_not_connected:'Подключите Phantom, чтобы подтвердить заказ.',wallet_changed:'Подключённый аккаунт изменился. Подпись не принята; проверьте выбранный кошелёк.',wallet_changed_transaction:'Кошелёк вернул изменённую транзакцию или другой аккаунт. Результат требует сверки; повторная оплата заблокирована.',signed_message_expired_requires_reconciliation:'Срок подписанного message истёк. Отправка не повторена; требуется окончательная сверка прежней подписи.',management_threshold:'Для применения настроек пока не хватает подписей управляющих.',signature_cancelled:'Подпись явно отклонена. Перевод не отправлялся; повтор возможен только с новым подтверждением.',requires_reconciliation:'Подтверждение сети пока не получено. Подписанная попытка сохранена; новый платёж не создаётся.','rpc-timeout':'Сеть не ответила вовремя. Прежняя попытка сохранена.','rpc-rate-limited':'Узел временно ограничил запросы. Прежняя попытка сохранена.','rpc-unavailable':'Узел сети недоступен. Проверьте соединение; оплата не повторяется.',cache_commit_failed:'Не удалось сохранить журнал на устройстве. Отправка остановлена; сохраните резервный файл.',wallet_transaction_signing_unavailable:'Подключённый кошелёк не поддерживает нужную подпись транзакции. Окно оплаты не вызвано.',trusted_genesis_required:'Настройки проекта ещё не восстановлены. Используйте сохранённый файл доверия.',untrusted_genesis:'Корень доверия не совпадает. Настройки не применены.',invalid_or_unauthorized_signature:'Подпись настроек не подтверждена. Изменения не применены.',prepared_message_expired:'Срок подготовленного подтверждения истёк до вызова кошелька. Нажмите «Продолжить сохранение», чтобы обновить подготовку.',previous_payment_requires_reconciliation:'Предыдущая попытка требует проверки. Повторная оплата заблокирована.',fee_or_balance_not_ready:'Недостаточно тестовых SOL либо комиссия пока недоступна. Средства не списывались.',order_expired:'Срок подписанного заказа истёк. Его условия не изменены; сначала требуется завершить проверку прежней попытки.',rpc_timeout:'Сеть пока не отвечает. Оплата не повторяется.',manual_executor_not_accepting_orders:'Приём сохранений пока выключен. Управляющему нужно подтвердить готовность исполнителя в настройках.',manual_executor_window_expired:'Окно исполнителя истекло. Управляющему нужно подписать новую версию готовности.',signed_configuration_required:'Подписанная конфигурация не подтверждена. Импортируйте и проверьте настройки.',pilot_budget_not_confirmed:'AR-бюджет пилота ещё не подтверждён подписанной конфигурацией (0.004 AR).',ar_budget_unavailable:'Недостаточно AR на резерве или стоимость превышает подписанный бюджет.',mainnet_broadcast_disabled_pending_owner_approval:'Отправка этого архива выключена владельцем.',archive_not_authorized_for_pilot:'Разрешён только согласованный архив: проверьте его размер и SHA-256.',pilot_file_mismatch:'Выберите исходный файл sejire-vault-449d6c6e.json. Его размер или SHA-256 не совпадает.',pilot_configuration_mismatch:'Настройки не соответствуют согласованному пилоту. Проверьте сеть, управляющего и три адреса.',pilot_reward_limit:'Стоимость превышает разрешённые 0.004 AR. Отправка остановлена.',existing_attempt_resume_only:'Попытка подписи уже начата. Импортируйте сохранённое подписанное задание и продолжите с прежним transaction ID; при неизвестном результате новая подпись запрещена.'} as Record<string,string>)[message]??message;
}
