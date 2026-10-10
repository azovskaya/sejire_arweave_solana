import type { UiLocale } from './locale';
const en = {
  eyebrow: 'Your family. Your history.',
  title: 'Keep the stories that connect generations.',
  lead: 'Build your family tree, record what you know, and preserve an encrypted copy with your own recovery words.',
  start: 'Create my family tree',
  free: 'Start free. No account or wallet required to build your tree.',
  steps: [
    ['01', 'Begin with your family', 'Add yourself, your parents and the people who shaped your story.'],
    ['02', 'Make it yours', 'Keep names and memories together. Export a tree as PDF or JSON.'],
    ['03', 'Choose how to preserve it', 'Download a backup or open Save with Solana for an encrypted upload.'],
  ],
  privacy: 'Drafts stay in this browser without encryption. Published archives are encrypted before upload. Keep your recovery words and an encrypted backup separately.',
  heritage: 'Rooted in the Kazakh tradition of shezhire. Made for families everywhere.',
};
const ru: typeof en = {
  eyebrow: 'Ваша семья. Ваша история.',
  title: 'Сохраните истории, которые связывают поколения.',
  lead: 'Соберите родовое древо, запишите то, что знаете о близких, и сохраните зашифрованную копию со своими словами восстановления.',
  start: 'Создать моё древо',
  free: 'Начать можно бесплатно. Для создания древа не нужны аккаунт и кошелёк.',
  steps: [
    ['01', 'Начните с семьи', 'Добавьте себя, родителей и людей, которые стали частью вашей истории.'],
    ['02', 'Соберите воспоминания', 'Сохраните имена и заметки. Скачайте древо в PDF или JSON.'],
    ['03', 'Выберите способ хранения', 'Скачайте резервную копию или выберите сохранение через Solana для зашифрованной загрузки.'],
  ],
  privacy: 'Черновики хранятся в этом браузере без шифрования. Перед публикацией архив шифруется. Храните слова восстановления отдельно от зашифрованной копии.',
  heritage: 'В основе — казахская традиция шежіре. Для семей со всего мира.',
};
const kk: typeof en = {
  eyebrow: 'Сіздің отбасыңыз. Сіздің тарихыңыз.',
  title: 'Ұрпақтарды жалғайтын естеліктерді сақтаңыз.',
  lead: 'Шежіреңізді құрып, жақындарыңыз туралы білетініңізді жазыңыз. Өз қалпына келтіру сөздеріңізбен шифрланған көшірмені сақтаңыз.',
  start: 'Шежіремді құру',
  free: 'Тегін бастаңыз. Шежіре құру үшін аккаунт та, әмиян да қажет емес.',
  steps: [
    ['01', 'Отбасыңыздан бастаңыз', 'Өзіңізді, ата-анаңызды және тарихыңыздағы маңызды адамдарды қосыңыз.'],
    ['02', 'Естеліктерді жинаңыз', 'Есімдер мен жазбаларды сақтаңыз. Шежірені PDF не JSON ретінде жүктеңіз.'],
    ['03', 'Сақтау тәсілін таңдаңыз', 'Сақтық көшірмені жүктеңіз немесе шифрланған жүктеу үшін Solana арқылы сақтауды таңдаңыз.'],
  ],
  privacy: 'Нобайлар осы браузерде шифрланбай сақталады. Жариялау алдында мұрағат шифрланады. Қалпына келтіру сөздерін шифрланған көшірмеден бөлек сақтаңыз.',
  heritage: 'Қазақтың шежіре дәстүрінен бастау алады. Әлемнің барлық отбасыларына арналған.',
};
export const landingMessages: Record<UiLocale, typeof en> = { en, ru, kk };
