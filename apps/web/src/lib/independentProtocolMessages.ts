import type { UiLocale } from './i18n/locale';

const ru = {
  link: 'Как работает протокол SEJIRE',
  title: 'Ваш архив — под вашим управлением',
  lead: 'SEJIRE шифрует семейный архив в вашем браузере и сохраняет его прямой транзакцией в Arweave. Для работы с архивом не нужен сервер SEJIRE или аккаунт проекта.',
  ownershipTitle: 'Доступ к семейному архиву',
  ownership: '12 слов SEJIRE открывают все деревья и историю вашего архива. Они остаются у вас. У администратора сайта нет запасного ключа и возможности восстановить забытые слова. Слова платёжного кошелька в SEJIRE не вводятся.',
  paymentTitle: 'Оплата хранения в Arweave',
  payment: 'Новую запись подписывает ваш Arweave-кошелёк и оплачивает сетевую комиссию в AR. Цена показывается перед подписью. Сервисной платы в SOL и сохранения за счёт общего промокода в этой версии нет.',
  recoveryTitle: 'Восстановление без сайта',
  recovery: 'Скачайте зашифрованный комплект и автономный расшифровщик. Вместе с вашими словами они позволяют открыть архив без сайта, имени sejire.ar.io и подключения к сети. Сетевые шлюзы можно менять; доступ к конкретному шлюзу не гарантируется.',
  administrationTitle: 'Управление сайтом и прежние операции',
  administration: 'У этой версии нет серверной админки, пароля администратора или общей казны. Обновление опубликованного сайта выполняет владелец его имени. Это не даёт ему доступа к вашим зашифрованным деревьям.',
  previous: 'Заказы прежней версии сохраняются отдельно. Не оплачивайте тот же архив заново, пока неизвестен результат старой операции. Открытие этой страницы не отправляет и не изменяет прежние заказы.',
  home: 'На главную',
  restore: 'Открыть мой архив',
};
const en: typeof ru = {
  link: 'How the SEJIRE protocol works',
  title: 'Your archive is under your control',
  lead: 'SEJIRE encrypts your family archive in your browser and saves it with a direct Arweave transaction. Working with the archive requires no SEJIRE server or project account.',
  ownershipTitle: 'Access to your family archive',
  ownership: 'Your 12 SEJIRE words unlock all trees and history in your archive. You keep them. The site administrator has no spare key and cannot recover forgotten words. Never enter your payment wallet phrase into SEJIRE.',
  paymentTitle: 'Paying for Arweave storage',
  payment: 'Your Arweave wallet signs each new upload and pays the network fee in AR. The price is shown before signing. This version has no SOL service fee or saves funded by a shared promo code.',
  recoveryTitle: 'Recovering without the website',
  recovery: 'Download your encrypted recovery kit and the offline decoder. Together with your words, they let you open the archive without the website, the sejire.ar.io name or an internet connection. Network gateways can be replaced; access to a particular gateway is not guaranteed.',
  administrationTitle: 'Website management and earlier operations',
  administration: 'This version has no server admin panel, administrator password or shared treasury. The name owner manages updates to the published website. This does not give them access to your encrypted trees.',
  previous: 'Orders from the previous version are retained separately. Do not pay again for the same archive while the earlier result is unknown. Opening this page does not send or change earlier orders.',
  home: 'Home',
  restore: 'Open my archive',
};
const kk: typeof ru = {
  link: 'SEJIRE протоколы қалай жұмыс істейді',
  title: 'Мұрағатыңыз өз бақылауыңызда',
  lead: 'SEJIRE отбасы мұрағатын браузеріңізде шифрлап, Arweave желісіне тікелей транзакциямен сақтайды. Мұрағатпен жұмыс істеу үшін SEJIRE сервері немесе жоба аккаунты қажет емес.',
  ownershipTitle: 'Отбасы мұрағатына қол жеткізу',
  ownership: '12 SEJIRE сөзі мұрағатыңыздағы барлық шежіре мен тарихты ашады. Сөздер өзіңізде қалады. Сайт әкімшісінде қосалқы кілт жоқ және ол ұмытылған сөздерді қалпына келтіре алмайды. Төлем әмиянының сөздерін SEJIRE ішіне енгізбеңіз.',
  paymentTitle: 'Arweave сақтау ақысын төлеу',
  payment: 'Әр жаңа жазбаға Arweave әмияныңыз қол қойып, желі комиссиясын AR-мен төлейді. Баға қол қою алдында көрсетіледі. Бұл нұсқада SOL қызмет ақысы да, ортақ промокод есебінен сақтау да жоқ.',
  recoveryTitle: 'Сайтсыз қалпына келтіру',
  recovery: 'Шифрланған қалпына келтіру жиынтығы мен дербес шифр ашу құралын жүктеп алыңыз. Олар сөздеріңізбен бірге мұрағатты сайтсыз, sejire.ar.io атауынсыз және интернетсіз ашуға мүмкіндік береді. Желі шлюзін ауыстыруға болады; нақты шлюздің қолжетімділігіне кепілдік берілмейді.',
  administrationTitle: 'Сайтты басқару және бұрынғы операциялар',
  administration: 'Бұл нұсқада серверлік әкімші панелі, әкімші құпиясөзі немесе ортақ қор жоқ. Жарияланған сайтты оның атауының иесі жаңартады. Бұл оған шифрланған шежірелеріңізді ашуға мүмкіндік бермейді.',
  previous: 'Бұрынғы нұсқаның тапсырыстары бөлек сақталады. Алдыңғы операцияның нәтижесі белгісіз болса, сол мұрағат үшін қайта төлемеңіз. Бұл бетті ашу бұрынғы тапсырыстарды жібермейді және өзгертпейді.',
  home: 'Басты бетке',
  restore: 'Мұрағатымды ашу',
};

export const independentProtocolMessages: Record<UiLocale, typeof ru> = { ru, en, kk };
