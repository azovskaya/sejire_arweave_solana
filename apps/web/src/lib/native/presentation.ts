import type { NativeJob } from './jobs';
/** Display state is derived from the durable attempt and separately verified events, never button clicks. */
export function savingState(job:NativeJob|undefined,verifiedPayment=false,verifiedStorage=false) {
 if(verifiedStorage)return {label:'Семейная история сохранена',action:'Открыть дерево'};
 if(job?.arPlan?.uploaded)return {label:'Данные отправлены. Проверяем сохранение',action:'Проверить результат'};
 if(job?.arPlan)return {label:'Загрузка подписана и сохранена',action:'Продолжить отправку'};
 if(verifiedPayment)return {label:job?.order.archive?'Оплата подтверждена. Ваше дерево ожидает сохранения':'Взнос подтверждён',action:job?.order.archive?'Сохранить в хранилище':'Посмотреть результат'};
 if(job?.signingStarted&&!job.paymentSignature&&!job.reconciledSignature)return {label:'Результат прежнего подтверждения неизвестен',action:'Проверить оплату'};
 if(job?.paymentSignature||job?.reconciledSignature)return {label:'Проверяем оплату. Прежняя попытка сохранена',action:'Проверить оплату'};
 return {label:job?'Заказ подтверждён — без списания':'Подготовка',action:job?'Подтвердить оплату':'Продолжить с Phantom'};
}
export const savingLabel=(job:NativeJob)=>`${job.order.archive?'Сохранение':'Поддержка'} от ${new Date(job.order.createdAt).toLocaleString('ru-RU')}`;
export function canStartDevnetRiskTest(job:NativeJob) {
 return job.order.network==='devnet'&&Boolean(job.signingStarted)&&!job.paymentSignature&&!job.reconciledSignature&&!job.signedPayment&&!job.arPlan&&!job.arSigningStarted;
}
