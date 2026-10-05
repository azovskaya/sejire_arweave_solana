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
 return ({manual_executor_not_accepting_orders:'Приём сохранений пока выключен. Управляющему нужно подтвердить готовность исполнителя в настройках.',manual_executor_window_expired:'Окно исполнителя истекло. Управляющему нужно подписать новую версию готовности.',signed_configuration_required:'Подписанная конфигурация не подтверждена. Импортируйте и проверьте настройки.',pilot_budget_not_confirmed:'AR-бюджет пилота ещё не подтверждён подписанной конфигурацией (0.004 AR).',ar_budget_unavailable:'Недостаточно AR на резерве или стоимость превышает подписанный бюджет.',mainnet_broadcast_disabled_pending_owner_approval:'Отправка этого архива выключена владельцем.',archive_not_authorized_for_pilot:'Разрешён только согласованный архив: проверьте его размер и SHA-256.',pilot_file_mismatch:'Выберите исходный файл sejire-vault-449d6c6e.json. Его размер или SHA-256 не совпадает.',pilot_configuration_mismatch:'Настройки не соответствуют согласованному пилоту. Проверьте сеть, управляющего и три адреса.',pilot_reward_limit:'Стоимость превышает разрешённые 0.004 AR. Отправка остановлена.',existing_attempt_resume_only:'Подписанная попытка уже существует. Импортируйте её и продолжите с прежним transaction ID.'} as Record<string,string>)[message]??message;
}
