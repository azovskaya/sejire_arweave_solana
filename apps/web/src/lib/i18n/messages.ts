import { LOCALE_BCP47, type UiLocale } from "./locale";
import type { KinshipCode } from "../kinship";
import type { ShezhireTemplateId } from "../pdf/shezhireTemplates";

export type UiMessages = {
  docTitle: string;
  docDescription: string;
  language: string;
  localeName: Record<UiLocale, string>;
  localeShort: Record<UiLocale, string>;
  defaultTreeTitle: string;
  cancel: string;
  close: string;
  back: string;
  next: string;
  done: string;
  save: string;
  add: string;
  undo: string;
  more: string;
  welcome: {
    openMenu: string;
    start: string;
    continueDraft: string;
    restoreSeed: string;
    newTree: string;
    cashier: string;
    replaceDraftConfirm: string;
  };
  crash: {
    title: string;
    body: string;
    noDraft: string;
    jsonDownloaded: string;
    jsonFailed: string;
    openDraft: string;
    reload: string;
    exportJson: string;
  };
  workspace: {
    save: string;
    moreMenu: string;
    zhuzRu: string;
    zhuzRuTitle: string;
    pdfTree: string;
    pdfShezhire: string;
    exportJson: string;
    exportJsonTitle: string;
    importJson: string;
    importJsonTitle: string;
    versions: string;
    versionsTitle: string;
    home: string;
    closeProfile: string;
    addSelf: string;
    addMother: string;
    addFather: string;
    flashAddParents: string;
    flashMotherAdded: string;
    flashFatherAdded: string;
    flashNeedPerson: string;
    commitBeforeSave: string;
    flashFocus: (name: string) => string;
    flashReflow: string;
    flashPdfTree: (paper: string) => string;
    flashPdfShezhire: string;
    flashJson: string;
    flashNoTrees: string;
    flashVersionOpened: (count: number) => string;
    flashImported: (count: number) => string;
    flashRemoved: (name: string) => string;
    flashRestored: string;
    flashZhuzSaved: string;
    flashZhuzCleared: string;
    replaceDraft: (count: number, action: string) => string;
    replaceOpenVersion: string;
    replaceJson: string;
    publishedDemo: (id: string, ver: string) => string;
    publishedSponsorMock: (id: string, ver: string) => string;
    publishedForever: (id: string, ver: string) => string;
    publishedArweave: (id: string, ver: string) => string;
    publishedFile: (id: string, ver: string) => string;
    publishedNewVersion: string;
  };
  pedigree: {
    startWithSelf: string;
    addSelf: string;
    addFather: string;
    addMother: string;
    noFacts: string;
    from: string;
    toSelf: string;
    toSelfTitle: string;
    focusChipTitle: string;
    view: string;
    fit: string;
    fitTitle: string;
    resetView: string;
    bornAbbr: string;
    diedAbbr: string;
    years: string;
    birthAbbr: string;
    deathAbbr: string;
    burialAbbr: string;
    jobAbbr: string;
    clickProfile: string;
    dblclickAncestors: string;
    maiden: string;
    birth: string;
    birthPlace: string;
    death: string;
    deathPlace: string;
    burial: string;
    burialPlace: string;
    occupation: string;
  };
  person: {
    empty: string;
    unnamed: string;
    noDates: string;
    profile: (name: string) => string;
    close: string;
    showAncestors: string;
    name: string;
    sex: string;
    sexUnknown: string;
    sexF: string;
    sexM: string;
    birth: string;
    death: string;
    date: string;
    place: string;
    placePh: string;
    notes: string;
    notesPh: string;
    moreFacts: string;
    maiden: string;
    maidenPh: string;
    occupation: string;
    burialDate: string;
    burialPlace: string;
    burialPlacePh: string;
    birthDateAria: string;
    deathDateAria: string;
    burialDateAria: string;
    relatives: string;
    addFather: string;
    addMother: string;
    protocol: string;
    protocolHint: string;
    protocolLoading: string;
    jetiAta: string;
    ancestors: string;
    knee: (n: number) => string;
    relate: string;
    delete: string;
    deleteConfirm: (name: string) => string;
    thisPerson: string;
  };
  addModal: {
    hint: string;
    name: string;
    namePh: string;
    sex: string;
  };
  datePh: string;
  zhuz: {
    title: string;
    hint: string;
    zhuz: string;
    ru: string;
    ruPh: string;
    unspecified: string;
    clear: string;
  };
  shezhirePick: {
    title: string;
    hint: string;
    formatA4p: string;
    formatA4l: string;
    blurb: Record<ShezhireTemplateId, string>;
  };
  restore: {
    title: string;
    hint: string;
    open: string;
    searching: string;
    pickTitle: string;
    pickHint: (fp: string) => string;
    localCopy: string;
    inBrowser: string;
    demoVersion: string;
    browserVersion: string;
    latestNetwork: string;
    networkVersion: (n: number) => string;
    hideFile: string;
    openFile: string;
    fileLabel: string;
    needWords: string;
    looking: (fp: string) => string;
    fileReady: string;
    wordsLabel: string;
    archiveReady: (name: string) => string;
    removeFile: string;
    openingFile: string;
    openArchive: string;
    fileTooLarge: string;
    arweaveDown: string;
    arweaveFail: string;
    noneAnywhere: string;
    noneLocal: string;
    shownLocal: string;
    decryptFail: string;
    noTrees: string;
    replaceDraft: string;
    badFile: string;
    noLocal: string;
    unknownTime: string;
  };
  versions: {
    title: string;
    hint: string;
    vault: (fp: string) => string;
    opened: (id: string) => string;
    words: string;
    searching: string;
    latest: string;
    versionN: (n: number) => string;
    now: string;
    whereArweave: string;
    whereDemo: string;
    whereSponsor: string;
    whereBrowser: string;
    localCopy: string;
    needWords: string;
    decryptFail: string;
    noLocal: string;
    needOpen: string;
    wrongVault: string;
    none: string;
    noneLocalToo: string;
  };
  publish: {
    title: string;
    lead: string;
    leadDemo: string;
    leadSponsor: string;
    leadTreasury: string;
    newVersionHint: string;
    prevKept: (id: string) => string;
    oldKept: string;
    demoNew: string;
    payNew: (hint: string) => string;
    networkNew: string;
    treasuryNew: string;
    treasurySave: string;
    sendingTreasury: (addr: string, balance: string) => string;
    selfArNew: string;
    localCipher: string;
    otherWords: string;
    createWords: string;
    haveWords: string;
    writeNow: string;
    iWrote: string;
    repeat: string;
    matched: string;
    seedJson: string;
    seedJsonAgain: string;
    demoSave: string;
    foreverPay: (hint: string) => string;
    selfArFallback: string;
    selfArMain: string;
    localTree: string;
    payLine: (price: string, via: string, ver: string) => string;
    viaMock: string;
    viaKaspi: string;
    newVerShort: string;
    openKaspi: string;
    paidMock: string;
    paidLive: string;
    existingHint: string;
    demoSaveBtn: string;
    encryptPay: string;
    encryptSend: string;
    busy: string;
    addressFromWords: string;
    fundLead: string;
    copyTitle: string;
    copied: string;
    copyHint: string;
    fund1: string;
    fund2: string;
    fund3: string;
    fund4: string;
    fund5: string;
    send: string;
    payInstead: string;
    demoInstead: string;
    discardConfirm: string;
    vaultFp: (fp: string) => string;
    encrypting: string;
    demoSaving: string;
    makingAddress: string;
    sending: (addr: string, balance: string) => string;
    fundHint: string;
    checkout: string;
    noSession: string;
    mockConfirm: string;
    kaspiAsk: string;
    kaspiWait: string;
    uploading: string;
    mismatch: string;
    repeatFirst: string;
    repeatRecord: string;
    seedDownloaded: string;
    badMnemonic: string;
    copiedStatus: string;
    copyManual: string;
    kaspiPaid: string;
    addressLabel: string;
  };
  admin: {
    title: string;
    sub: string;
    pagesHint: string;
    setupHint: string;
    password: string;
    passwordAgain: string;
    create: string;
    enter: string;
    wrong: string;
    short: string;
    mismatch: string;
    failed: string;
    tabOverview: string;
    tabKeys: string;
    tabPassword: string;
    trees: string;
    saves: string;
    payments: string;
    sum: string;
    whenTrees: string;
    pays: string;
    when: string;
    vault: string;
    path: string;
    emptyTrees: string;
    emptyPays: string;
    treasury: string;
    none: string;
    has: string;
    keysHint: string;
    mockWarn: string;
    createTreasury: string;
    generating: string;
    generated: string;
    pasteJwk: string;
    siteJwk: string;
    kaspiToken: string;
    tradePoint: string;
    api: string;
    payPath: string;
    mock: string;
    kaspiPay: string;
    price: string;
    currency: string;
    saveKeys: string;
    savedKeys: string;
    clearTreasury: string;
    clearSite: string;
    clearKaspi: string;
    once: string;
    onceHint: string;
    copyJson: string;
    copyAddr: string;
    alreadyTreasury: string;
    replaceConfirm: string;
    invalidJwk: string;
    newPass: string;
    changePass: string;
    changed: string;
    logout: string;
    fundHint: string;
    arweaveLag: string;
    savedNet: string;
    paid: string;
  };
  kinship: Record<KinshipCode, string>;
  kinshipRelatedSteps: (da: number, db: number) => string;
  relation: {
    father: string;
    mother: string;
    child: string;
  };
  quota: string;
};

const ru: UiMessages = {
  docTitle: "SEJIRE — редактор родового древа",
  docDescription: "Децентрализованный версионный редактор генеалогии. Каждое дополнение — новый immutable commit.",
  language: "Язык",
  localeName: { kk: "Қазақша", ru: "Русский", en: "English" },
  localeShort: { kk: "ҚАЗ", ru: "РУС", en: "ENG" },
  defaultTreeTitle: "Мой род",
  cancel: "Отмена",
  close: "Закрыть",
  back: "Назад",
  next: "Далее",
  done: "Готово",
  save: "Сохранить",
  add: "Добавить",
  undo: "Вернуть",
  more: "Ещё",
  welcome: {
    openMenu: "SEJIRE — открыть меню",
    start: "Начать",
    continueDraft: "Продолжить",
    restoreSeed: "Открыть по 12 словам",
    newTree: "Новое древо",
    cashier: "Касса",
    replaceDraftConfirm:
      "Текущий черновик будет удалён. Сначала можно продолжить его и выгрузить JSON. Создать новое древо?",
  },
  crash: {
    title: "Приложение остановилось",
    body: "Черновик в браузере обычно цел. Откройте его — схема должна вернуться. Если ошибка повторяется, выгрузите JSON, пока вкладка ещё открыта.",
    noDraft: "Черновик в браузере не найден.",
    jsonDownloaded: "JSON скачан.",
    jsonFailed: "Не удалось выгрузить JSON",
    openDraft: "Открыть черновик",
    reload: "Обновить",
    exportJson: "Выгрузить JSON",
  },
  workspace: {
    save: "Сохранить",
    moreMenu: "Ещё",
    zhuzRu: "Жүз и ру",
    zhuzRuTitle: "Для казахского шежіре. Можно не заполнять",
    pdfTree: "Древо в PDF",
    pdfShezhire: "Шежіре PDF",
    exportJson: "Выгрузить JSON",
    exportJsonTitle: "Скачать все данные древа в JSON",
    importJson: "Загрузить JSON",
    importJsonTitle: "Загрузить древо из JSON-файла",
    versions: "Версии сейфа",
    versionsTitle: "Все сохранения под теми же 12 словами",
    home: "На главную",
    closeProfile: "Закрыть профиль",
    addSelf: "Добавить себя",
    addMother: "Добавить маму",
    addFather: "Добавить папу",
    flashAddParents: "Добавьте маму или папу карточками «+» на схеме",
    flashMotherAdded: "Мама добавлена",
    flashFatherAdded: "Папа добавлен",
    flashNeedPerson: "Сначала добавьте хотя бы одного человека",
    commitBeforeSave: "Снимок перед сохранением",
    flashFocus: (name) => `На схеме предки «${name}»`,
    flashReflow: "Схема перестроена",
    flashPdfTree: (paper) => `PDF древа скачан · ${paper}`,
    flashPdfShezhire: "Шежіре PDF скачан",
    flashJson: "JSON скачан — все данные древа",
    flashNoTrees: "В этой версии нет деревьев",
    flashVersionOpened: (count) =>
      `Открыта версия · ${count} чел. Можно править и снова сохранить (новая оплата).`,
    flashImported: (count) => `Загружено: ${count} чел.`,
    flashRemoved: (name) => `«${name}» убран(а) с древа`,
    flashRestored: "Человек возвращён на древо",
    flashZhuzSaved: "Жүз и ру сохранены для этого древа",
    flashZhuzCleared: "Жүз и ру очищены",
    replaceDraft: (count, action) =>
      `Текущий черновик (${count} чел.) будет заменён: ${action}. Сначала можно выгрузить JSON в меню «Ещё». Продолжить?`,
    replaceOpenVersion: "открытие другой версии сейфа",
    replaceJson: "загрузка JSON",
    publishedDemo: (id, ver) =>
      `Демо-версия сохранена в этом браузере (${id}…). Храните 12 слов.${ver}`,
    publishedSponsorMock: (id, ver) =>
      `Mock-кассир: сейф принят (${id}…). Когда будет Turbo — это станет реальным TX. Храните 12 слов.${ver}`,
    publishedForever: (id, ver) => `Навсегда в Arweave (${id}…). Храните 12 слов.${ver}`,
    publishedArweave: (id, ver) => `Сохранено в Arweave (${id}…). Храните 12 слов.${ver}`,
    publishedFile: (id, ver) => `Файл сейфа скачан${id ? ` · версия ${id}…` : ""}. Храните 12 слов.${ver}`,
    publishedNewVersion: " Новая версия; прошлые — в «Версии сейфа».",
  },
  pedigree: {
    startWithSelf: "Начните с себя",
    addSelf: "Добавить себя",
    addFather: "Добавить папу",
    addMother: "Добавить маму",
    noFacts: "нет сведений",
    from: "От",
    toSelf: "К себе",
    toSelfTitle: "Вернуть схему к вам",
    focusChipTitle: "Схема строится от этого человека к предкам",
    view: "Вид",
    fit: "Вместить",
    fitTitle: "Уменьшить, чтобы всё древо было видно. Карточки сами не сжимаются.",
    resetView: "Сброс вида",
    bornAbbr: "род.",
    diedAbbr: "ум.",
    years: "годы",
    birthAbbr: "род.",
    deathAbbr: "ум.",
    burialAbbr: "погр.",
    jobAbbr: "зан.",
    clickProfile: "Клик — открыть профиль",
    dblclickAncestors: "Двойной клик / кнопка в профиле — показать предков на схеме",
    maiden: "девичья",
    birth: "рождение",
    birthPlace: "место рождения",
    death: "смерть",
    deathPlace: "место смерти",
    burial: "захоронение",
    burialPlace: "место захоронения",
    occupation: "занятие",
  },
  person: {
    empty: "Нажмите карточку на схеме, чтобы открыть форму сведений.",
    unnamed: "Без имени",
    noDates: "даты не указаны",
    profile: (name) => `Профиль: ${name}`,
    close: "Закрыть",
    showAncestors: "Показать предков на схеме",
    name: "Имя",
    sex: "Пол",
    sexUnknown: "не указан",
    sexF: "женский",
    sexM: "мужской",
    birth: "Рождение",
    death: "Смерть",
    date: "Дата",
    place: "Место",
    placePh: "город, страна",
    notes: "Заметки",
    notesPh: "Кратко о человеке",
    moreFacts: "Ещё сведения",
    maiden: "Девичья фамилия",
    maidenPh: "если применимо",
    occupation: "Род занятий",
    burialDate: "Дата захоронения",
    burialPlace: "Место захоронения",
    burialPlacePh: "кладбище, город",
    birthDateAria: "Дата рождения",
    deathDateAria: "Дата смерти",
    burialDateAria: "Дата захоронения",
    relatives: "Родственники",
    addFather: "+ Папа",
    addMother: "+ Мама",
    protocol: "Родство по протоколу",
    protocolHint: "Локальный снимок процесса · сеть AO не вызывается",
    protocolLoading: "Считаем жеті ата и связи…",
    jetiAta: "Жеті ата",
    ancestors: "Предки",
    knee: (n) => `колено ${n}`,
    relate: "Связи Relate",
    delete: "Удалить с древа",
    deleteConfirm: (name) =>
      `Убрать ${name} со схемы? Сразу после этого можно нажать «Вернуть».`,
    thisPerson: "этого человека",
  },
  addModal: {
    hint: "Достаточно имени — остальное можно дописать на карточке.",
    name: "Имя",
    namePh: "Как зовут",
    sex: "Пол",
  },
  datePh: "1990 или 15.03.1990",
  zhuz: {
    title: "Жүз и ру",
    hint: "Для казахского шежіре. Если вы не казахи — просто закройте: на древе ничего не появится.",
    zhuz: "Жүз",
    ru: "Ру",
    ruPh: "например, Арғын",
    unspecified: "не указан",
    clear: "Очистить",
  },
  shezhirePick: {
    title: "Шежіре",
    hint: "Выберите оформление",
    formatA4p: "A4 книжный",
    formatA4l: "A4 альбомный",
    blurb: {
      manuscript: "Пергамент, орнамент, вертикальный свиток",
      registry: "Древний киіз-өрнек: қосқар мүйіз по всей рамке",
      cascade: "Горизонтальная линия предков — для широкой рамы",
    },
  },
  restore: {
    title: "Открыть по словам",
    hint: "Введите 12 слов. Если сейф сохраняли несколько раз — увидите все версии и выберете нужную.",
    open: "Открыть",
    searching: "Ищем…",
    pickTitle: "Выберите версию",
    pickHint: (fp) => `Сейф ${fp}: найдено несколько сохранений. Можно открыть любое.`,
    localCopy: "Текущая локальная копия",
    inBrowser: "в этом браузере",
    demoVersion: "Демо-версия",
    browserVersion: "Версия в браузере",
    latestNetwork: "Последняя в сети",
    networkVersion: (n) => `Сеть · версия ${n}`,
    hideFile: "Скрыть файл",
    openFile: "Открыть из файла",
    fileLabel: "Архив, квитанция или файл с 12 словами SEJIRE (.json)",
    needWords: "Нужны 12 корректных английских слов.",
    looking: (fp) => `Ищем версии (${fp})…`,
    fileReady: "Слова из файла подставлены. Нажмите «Открыть».",
    wordsLabel: "12 слов восстановления SEJIRE",
    archiveReady: (name) => `Выбран архив «${name}». Введите его 12 слов и нажмите «Восстановить архив». Подключение к хранилищу не требуется.`,
    removeFile: "Убрать файл и искать сохранения в сети",
    openingFile: "Открываем архив…",
    openArchive: "Восстановить архив",
    fileTooLarge: "Файл слишком большой. Выберите архив до 10 МБ.",
    arweaveDown: "Сеть Arweave недоступна.",
    arweaveFail: "Не удалось связаться с Arweave. Проверьте сеть и попробуйте снова.",
    noneAnywhere: "Сейф не найден ни в сети, ни в этом браузере.",
    noneLocal: "Локальных копий этого сейфа в браузере тоже нет.",
    shownLocal: "Показаны копии из этого браузера.",
    decryptFail: "Не удалось открыть: проверьте 12 слов или файл.",
    noTrees: "В сейфе нет деревьев",
    replaceDraft: "Текущий черновик в браузере будет заменён восстановленным деревом. Продолжить?",
    badFile: "Нужен файл sejire/seed/v1 (12 слов) или sejire/envelope/v1 (сейф).",
    noLocal: "Локальной копии нет",
    unknownTime: "время неизвестно",
  },
  versions: {
    title: "Версии сейфа",
    hint: "Каждое сохранение — новая версия под теми же 12 словами. Старые остаются. На демо-сайте версии лежат в этом браузере; в проде — в Arweave.",
    vault: (fp) => `Сейф ${fp}`,
    opened: (id) => ` · открыта ${id}…`,
    words: "12 слов",
    searching: "Ищем версии…",
    latest: "Последняя",
    versionN: (n) => `Версия ${n}`,
    now: " · сейчас",
    whereArweave: "Arweave",
    whereDemo: "демо · браузер",
    whereSponsor: "кассир / архив",
    whereBrowser: "браузер",
    localCopy: "Текущая локальная копия",
    needWords: "Введите 12 слов.",
    decryptFail: "Не удалось открыть: проверьте 12 слов.",
    noLocal: "Локальной копии нет.",
    needOpen: "Сначала откройте или сохраните сейф по 12 словам.",
    wrongVault: "Эти 12 слов относятся к другому сейфу.",
    none: "Пока нет сохранённых версий этого сейфа (ни в сети, ни в браузере).",
    noneLocalToo: "Локальных копий тоже нет.",
  },
  publish: {
    title: "Сохранить",
    lead: "12 слов — ваш ключ. Каждое сохранение — новая версия под теми же словами; прошлые остаются.",
    leadDemo:
      " Сейчас на сайте включён демо-режим: версии хранятся в этом браузере (без оплаты и без Arweave), чтобы проверить сценарий.",
    leadSponsor: " Вечность — через кассир",
    leadTreasury: " Сеть оплачивает казна проекта из кассы. 12 слов только шифруют сейф.",
    newVersionHint: "Сохранить текущее древо как новую версию теми же 12 словами",
    prevKept: (id) => ` Предыдущая версия останется (${id}…).`,
    oldKept: " Если сейф уже сохраняли — старые версии останутся.",
    demoNew: "Демо · новая версия в браузере",
    payNew: (hint) => `Новая версия · оплата${hint}`,
    networkNew: "Новая версия в сеть",
    treasuryNew: "Новая версия · казна проекта",
    treasurySave: "Сохранить казной проекта",
    sendingTreasury: (addr, balance) => `Казна ${addr}… · ${balance} AR`,
    selfArNew: "Новая версия за свой AR",
    localCipher: "Только локальный шифр / файл",
    otherWords: "Другие 12 слов",
    createWords: "Создать 12 слов",
    haveWords: "У меня уже есть слова (новая версия)",
    writeNow: "Запишите эти слова на бумаге сейчас.",
    iWrote: "Я записал(а)",
    repeat: "Повторите 12 слов.",
    matched:
      "Слова совпали. Ключ — на бумагу или JSON. Дальше сохраните версию; позже можно снова сохранить под этими словами — это будет новая версия.",
    seedJson: "12 слов · JSON",
    seedJsonAgain: "12 слов · JSON ещё раз",
    demoSave: "Демо · сохранить версию в браузере",
    foreverPay: (hint) => `Навсегда · оплата${hint}`,
    selfArFallback: "В сеть за свой AR (fallback)",
    selfArMain: "Древо в децентрализованную сеть",
    localTree: "Зашифрованное древо · локально",
    payLine: (price, via, ver) =>
      `Оплата ${price}${via}${ver}. На кассир уходит только зашифрованный сейф — не 12 слов.`,
    viaMock: " (mock-кассир, без банка)",
    viaKaspi: " через Kaspi",
    newVerShort: " · новая версия",
    openKaspi: "Открыть оплату Kaspi ↗",
    paidMock: "Оплачено (mock) · сохранить навсегда",
    paidLive: "Я оплатил(а) · сохранить",
    existingHint:
      "Те же 12 слов → тот же сейф. Сохранение создаст новую версию; старые версии останутся.",
    demoSaveBtn: "Сохранить демо-версию",
    encryptPay: "Зашифровать и оплатить",
    encryptSend: "Зашифровать и отправить",
    busy: "Работаем… Не закрывайте окно.",
    addressFromWords: "Адрес из 12 слов:",
    fundLead:
      "На адресе из ваших 12 слов нет AR, поэтому сеть не принимает сейф. Новые слова создавать не нужно.",
    copyTitle: "Нажмите, чтобы скопировать",
    copied: "Скопировано",
    copyHint: "Нажмите, чтобы скопировать адрес",
    fund1: "Скопируйте адрес выше.",
    fund2: "Binance → Вывод → монета AR → сеть только Arweave (не ERC-20, не BNB).",
    fund3: "Вставьте этот адрес. Хватит 0.05–0.1 AR.",
    fund4: "Не импортируйте 12 слов в ArConnect — получится другой адрес, деньги не дойдут сюда.",
    fund5: "Когда перевод пройдёт (обычно несколько минут), нажмите «Отправить».",
    send: "Отправить",
    payInstead: "Оплатить через кассир вместо AR",
    demoInstead: "Сохранить демо-версию в браузере",
    discardConfirm: "Сгенерированные 12 слов будут потеряны с экрана. Вы уже записали их на бумагу?",
    vaultFp: (fp) => `Сейф ${fp}…`,
    encrypting: "Шифруем сейф ключом из 12 слов…",
    demoSaving: "Сохраняем демо-версию в этом браузере…",
    makingAddress: "Из 12 слов создаём адрес Arweave (без стороннего кошелька, 10–40 сек)…",
    sending: (addr, balance) => `Адрес из фразы ${addr}… · баланс ${balance} AR. Отправляем…`,
    fundHint: " Переведите AR на адрес ниже, затем нажмите «Отправить».",
    checkout: "Создаём сессию оплаты…",
    noSession: "Нет сессии оплаты или шифра.",
    mockConfirm: "Подтверждаем mock-оплату…",
    kaspiAsk: "Спрашиваем Kaspi, прошла ли оплата…",
    kaspiWait:
      "Kaspi ещё не подтвердил оплату. Откройте ссылку Kaspi, оплатите, затем нажмите кнопку снова.",
    uploading: "Отправляем только шифр в сеть…",
    mismatch: "Фраза не совпадает.",
    repeatFirst: "Сначала повторите 12 слов.",
    repeatRecord: "Сначала повторите 12 слов — так мы убедимся, что вы их записали.",
    seedDownloaded: "Файл sejire-12-words….json (схема sejire/seed/v1) скачан",
    badMnemonic: "Нужна корректная BIP-39 фраза из 12 слов.",
    copiedStatus: "Адрес скопирован",
    copyManual: "Скопируйте адрес вручную",
    kaspiPaid: "Kaspi подтвердил оплату. Можно сохранить.",
    addressLabel: "Адрес из ваших 12 слов:",
  },
  admin: {
    title: "Касса",
    sub: "Ключи, казна и движения по сети. Имена и 12 слов сюда не попадают.",
    pagesHint:
      "Сейчас касса на GitHub Pages, в этом браузере. Потом тот же экран переедет на sejire.ar.io.",
    setupHint: "Первый вход: пароль только у вас. В git и в чат его не класть.",
    password: "Пароль (от 12 символов)",
    passwordAgain: "Ещё раз",
    create: "Создать кассу",
    enter: "Войти",
    wrong: "Неверный пароль.",
    short: "Пароль — минимум 12 символов.",
    mismatch: "Пароли не совпали.",
    failed: "Не вышло.",
    tabOverview: "Обзор",
    tabKeys: "Ключи",
    tabPassword: "Пароль",
    trees: "Деревьев",
    saves: "Сохранений",
    payments: "Оплат",
    sum: "Сумма",
    whenTrees: "Сохранения в Arweave",
    pays: "Оплаты в этой кассе",
    when: "Время",
    vault: "Сейф",
    path: "Путь",
    emptyTrees: "В сети пока нет сейфов SEJIRE",
    emptyPays: "Оплат пока нет",
    treasury: "Казна",
    none: "ещё нет",
    has: "есть",
    keysHint:
      "Пустое поле = не менять. JSON казны покажется один раз — сразу в 1Password. На бумагу только адрес.",
    mockWarn:
      "Казна есть, Kaspi ещё нет: сохранения в сеть идут из казны этого браузера, без живой оплаты.",
    createTreasury: "Создать казну здесь",
    generating: "Создаём казну…",
    generated: "Казна создана. Скопируйте JSON сейчас.",
    pasteJwk: "Вставить JWK казны",
    siteJwk: "JWK сайта / permaweb",
    kaspiToken: "Токен Kaspi",
    tradePoint: "Trade Point Id",
    api: "Kaspi API",
    payPath: "Путь оплаты",
    mock: "mock — пока нет ИП",
    kaspiPay: "kaspi",
    price: "Цена (тиын)",
    currency: "Валюта",
    saveKeys: "Сохранить",
    savedKeys: "Сохранено в этом браузере.",
    clearTreasury: "Удалить казну из браузера",
    clearSite: "Удалить ключ сайта",
    clearKaspi: "Удалить токен Kaspi",
    once: "Покажите один раз. Адрес:",
    onceHint: "Весь JSON — в 1Password и на флешку. В чат агенту не слать.",
    copyJson: "Скопировать JSON",
    copyAddr: "Скопировать адрес",
    alreadyTreasury: "Казна уже сохранена в этом браузере.",
    replaceConfirm: "Казна уже есть. Создать новую и заменить?",
    invalidJwk: "Это не JWK.",
    newPass: "Новый пароль",
    changePass: "Сменить пароль",
    changed: "Пароль сменён.",
    logout: "Выйти",
    fundHint: "Пополните казну AR на этот адрес (Binance → сеть Arweave).",
    arweaveLag: "Новые TX появляются в обзоре после индексации сети — обычно минуты.",
    savedNet: "сейф в сети",
    paid: "оплачено",
  },
  kinship: {
    self: "тот же человек",
    child: "ребёнок",
    parent: "родитель",
    grandchild: "внук/внучка",
    grandparent: "дед/бабушка",
    sibling: "брат/сестра (или единокровные)",
    nibling: "племянник/племянница",
    pibling: "дядя/тётя",
    cousin: "двоюродные",
    related: "общие предки",
    unrelated: "нет общей линии в этом снимке",
  },
  kinshipRelatedSteps: (da, db) => `общие предки (шаги ${da}+${db})`,
  relation: { father: "Папа", mother: "Мама", child: "Ребёнок" },
  quota:
    "Черновик не влез в память браузера. Выгрузите JSON — иначе правки могут пропасть после закрытия вкладки.",
};

const kk: UiMessages = {
  docTitle: "SEJIRE — шежіре редакторы",
  docDescription: "Шежірені нұсқалап сақтайтын редактор. Әр толықтыру — жаңа өзгермейтін жазба.",
  language: "Тіл",
  localeName: { kk: "Қазақша", ru: "Русский", en: "English" },
  localeShort: { kk: "ҚАЗ", ru: "РУС", en: "ENG" },
  defaultTreeTitle: "Менің тегім",
  cancel: "Бас тарту",
  close: "Жабу",
  back: "Артқа",
  next: "Келесі",
  done: "Дайын",
  save: "Сақтау",
  add: "Қосу",
  undo: "Қайтару",
  more: "Тағы",
  welcome: {
    openMenu: "SEJIRE — мәзірді ашу",
    start: "Бастау",
    continueDraft: "Жалғастыру",
    restoreSeed: "12 сөзбен ашу",
    newTree: "Жаңа шежіре",
    cashier: "Касса",
    replaceDraftConfirm:
      "Қазіргі жоба өшеді. Алдымен жалғастырып, JSON түсіруге болады. Жаңа шежіре бастайық па?",
  },
  crash: {
    title: "Қосымша тоқтады",
    body: "Браузердегі жоба әдетте сақтаулы. Оны ашыңыз — схема қайтуы керек. Қайталанса, қойынды жабылмай тұрып JSON түсіріңіз.",
    noDraft: "Браузерде жоба жоқ.",
    jsonDownloaded: "JSON жүктелді.",
    jsonFailed: "JSON түсіру мүмкін болмады",
    openDraft: "Жобаны ашу",
    reload: "Жаңарту",
    exportJson: "JSON түсіру",
  },
  workspace: {
    save: "Сақтау",
    moreMenu: "Тағы",
    zhuzRu: "Жүз және ру",
    zhuzRuTitle: "Қазақ шежіресі үшін. Толтырмасаңыз да болады",
    pdfTree: "Шежіре PDF",
    pdfShezhire: "Жеті ата PDF",
    exportJson: "JSON түсіру",
    exportJsonTitle: "Шежіренің барлық деректерін JSON қылып жүктеу",
    importJson: "JSON жүктеу",
    importJsonTitle: "Шежірені JSON файлынан ашу",
    versions: "Сейф нұсқалары",
    versionsTitle: "Сол 12 сөзбен жасалған барлық сақтаулар",
    home: "Басты бет",
    closeProfile: "Профильді жабу",
    addSelf: "Өзіңізді қосу",
    addMother: "Ананы қосу",
    addFather: "Әкені қосу",
    flashAddParents: "Схемадағы «+» карточкаларымен ана немесе әкені қосыңыз",
    flashMotherAdded: "Ана қосылды",
    flashFatherAdded: "Әке қосылды",
    flashNeedPerson: "Алдымен кемі бір адамды қосыңыз",
    commitBeforeSave: "Сақтау алдындағы түсірілім",
    flashFocus: (name) => `Схемада «${name}» ата-бабалары`,
    flashReflow: "Схема қайта құрылды",
    flashPdfTree: (paper) => `Шежіре PDF жүктелді · ${paper}`,
    flashPdfShezhire: "Жеті ата PDF жүктелді",
    flashJson: "JSON жүктелді — шежіренің барлық деректері",
    flashNoTrees: "Бұл нұсқада шежіре жоқ",
    flashVersionOpened: (count) =>
      `Нұсқа ашылды · ${count} адам. Түзетіп, қайта сақтауға болады (жаңа төлем).`,
    flashImported: (count) => `Жүктелді: ${count} адам`,
    flashRemoved: (name) => `«${name}» шежіреден алынды`,
    flashRestored: "Адам шежіреге қайтарылды",
    flashZhuzSaved: "Жүз мен ру осы шежіреге сақталды",
    flashZhuzCleared: "Жүз мен ру тазартылды",
    replaceDraft: (count, action) =>
      `Қазіргі жоба (${count} адам) ауыстырылады: ${action}. Алдымен «Тағы» мәзірінен JSON түсіруге болады. Жалғастырамыз ба?`,
    replaceOpenVersion: "сейфтің басқа нұсқасын ашу",
    replaceJson: "JSON жүктеу",
    publishedDemo: (id, ver) =>
      `Демо-нұсқа осы браузерде сақталды (${id}…). 12 сөзді сақтаңыз.${ver}`,
    publishedSponsorMock: (id, ver) =>
      `Mock-кассир: сейф қабылданды (${id}…). Turbo қосылса, бұл нақты TX болады. 12 сөзді сақтаңыз.${ver}`,
    publishedForever: (id, ver) => `Arweave-те мәңгі (${id}…). 12 сөзді сақтаңыз.${ver}`,
    publishedArweave: (id, ver) => `Arweave-ке сақталды (${id}…). 12 сөзді сақтаңыз.${ver}`,
    publishedFile: (id, ver) => `Сейф файлы жүктелді${id ? ` · нұсқа ${id}…` : ""}. 12 сөзді сақтаңыз.${ver}`,
    publishedNewVersion: " Жаңа нұсқа; бұрынғылары — «Сейф нұсқаларында».",
  },
  pedigree: {
    startWithSelf: "Өзіңізден бастаңыз",
    addSelf: "Өзіңізді қосу",
    addFather: "Әкені қосу",
    addMother: "Ананы қосу",
    noFacts: "мәлімет жоқ",
    from: "Кімнен",
    toSelf: "Өзіме",
    toSelfTitle: "Схеманы өзіңізге қайтару",
    focusChipTitle: "Схема осы адамнан ата-бабаға қарай құрылады",
    view: "Көрініс",
    fit: "Сыйғызу",
    fitTitle: "Бүкіл шежіре көрінетіндей кішірейту. Карточкалар кішіреймейді.",
    resetView: "Көріністі тастау",
    bornAbbr: "туыл.",
    diedAbbr: "қайт.",
    years: "жылдары",
    birthAbbr: "туыл.",
    deathAbbr: "қайт.",
    burialAbbr: "жерл.",
    jobAbbr: "кәсіп",
    clickProfile: "Басу — профильді ашу",
    dblclickAncestors: "Қос басу / профильдегі батырма — ата-бабаны схемада көрсету",
    maiden: "қыз күніндегі тегі",
    birth: "тууы",
    birthPlace: "туған жері",
    death: "қайтыс болуы",
    deathPlace: "қайтыс болған жері",
    burial: "жерленуі",
    burialPlace: "жерленген жері",
    occupation: "кәсібі",
  },
  person: {
    empty: "Мәліметтерді ашу үшін схемадағы карточканы басыңыз.",
    unnamed: "Есімі жоқ",
    noDates: "күндері көрсетілмеген",
    profile: (name) => `Профиль: ${name}`,
    close: "Жабу",
    showAncestors: "Ата-бабаны схемада көрсету",
    name: "Есімі",
    sex: "Жынысы",
    sexUnknown: "көрсетілмеген",
    sexF: "әйел",
    sexM: "ер",
    birth: "Тууы",
    death: "Қайтыс болуы",
    date: "Күні",
    place: "Жері",
    placePh: "қала, ел",
    notes: "Жазба",
    notesPh: "Адам туралы қысқаша",
    moreFacts: "Тағы мәлімет",
    maiden: "Қыз күніндегі тегі",
    maidenPh: "бар болса",
    occupation: "Кәсібі",
    burialDate: "Жерленген күні",
    burialPlace: "Жерленген жері",
    burialPlacePh: "бейіт, қала",
    birthDateAria: "Туған күні",
    deathDateAria: "Қайтыс болған күні",
    burialDateAria: "Жерленген күні",
    relatives: "Туыстар",
    addFather: "+ Әке",
    addMother: "+ Ана",
    protocol: "Хаттама бойынша туыстық",
    protocolHint: "Процестің жергілікті түсірілімі · AO желісі шақырылмайды",
    protocolLoading: "Жеті ата мен байланыстарды есептеп жатырмыз…",
    jetiAta: "Жеті ата",
    ancestors: "Ата-баба",
    knee: (n) => `${n}-ата`,
    relate: "Relate байланыстары",
    delete: "Шежіреден алу",
    deleteConfirm: (name) =>
      `${name} схемадан алынсын ба? Бірден «Қайтару» батырмасын басуға болады.`,
    thisPerson: "осы адамды",
  },
  addModal: {
    hint: "Есімі жеткілікті — қалғанын карточкада жазуға болады.",
    name: "Есімі",
    namePh: "Аты-жөні",
    sex: "Жынысы",
  },
  datePh: "1990 немесе 15.03.1990",
  zhuz: {
    title: "Жүз және ру",
    hint: "Қазақ шежіресі үшін. Қазақ емес болсаңыз — жай жабыңыз: схемада ештеңе шықпайды.",
    zhuz: "Жүз",
    ru: "Ру",
    ruPh: "мысалы, Арғын",
    unspecified: "көрсетілмеген",
    clear: "Тазалау",
  },
  shezhirePick: {
    title: "Шежіре",
    hint: "Безендіруді таңдаңыз",
    formatA4p: "A4 кітапша",
    formatA4l: "A4 альбом",
    blurb: {
      manuscript: "Пергамент, ою, тік шиыршық",
      registry: "Ежелгі киіз-өрнек: қосқар мүйіз бүкіл жиекте",
      cascade: "Ата-бабаның көлденең жолы — кең жақтауға",
    },
  },
  restore: {
    title: "Сөзбен ашу",
    hint: "12 сөзді енгізіңіз. Сейф бірнеше рет сақталса — барлық нұсқаны көріп, керегін таңдайсыз.",
    open: "Ашу",
    searching: "Іздеп жатырмыз…",
    pickTitle: "Нұсқаны таңдаңыз",
    pickHint: (fp) => `Сейф ${fp}: бірнеше сақтау табылды. Кез келгенін ашуға болады.`,
    localCopy: "Қазіргі жергілікті көшірме",
    inBrowser: "осы браузерде",
    demoVersion: "Демо-нұсқа",
    browserVersion: "Браузердегі нұсқа",
    latestNetwork: "Желідегі соңғысы",
    networkVersion: (n) => `Желі · нұсқа ${n}`,
    hideFile: "Файлды жасыру",
    openFile: "Файлдан ашу",
    fileLabel: "Архив, түбіртек немесе SEJIRE-дің 12 сөзі бар файл (.json)",
    needWords: "12 дұрыс ағылшын сөзі керек.",
    looking: (fp) => `Нұсқаларды іздеу (${fp})…`,
    fileReady: "Файлдағы сөздер қойылды. «Ашу» басыңыз.",
    wordsLabel: "SEJIRE қалпына келтірудің 12 сөзі",
    archiveReady: (name) => `«${name}» архиві таңдалды. Оның 12 сөзін енгізіп, «Архивті қалпына келтіру» басыңыз. Қоймаға қосылу қажет емес.`,
    removeFile: "Файлды алып тастап, желіден іздеу",
    openingFile: "Архив ашылуда…",
    openArchive: "Архивті қалпына келтіру",
    fileTooLarge: "Файл тым үлкен. 10 МБ-тан аспайтын архивті таңдаңыз.",
    arweaveDown: "Arweave желісі қолжетімсіз.",
    arweaveFail: "Arweave-пен байланыс болмады. Желіні тексеріп, қайта көріңіз.",
    noneAnywhere: "Сейф желіде де, осы браузерде де табылмады.",
    noneLocal: "Бұл сейфтің браузерде жергілікті көшірмесі де жоқ.",
    shownLocal: "Осы браузердегі көшірмелер көрсетілді.",
    decryptFail: "Ашылмады: 12 сөзді немесе файлды тексеріңіз.",
    noTrees: "Сейфте шежіре жоқ",
    replaceDraft: "Браузердегі қазіргі жоба қалпына келтірілген шежіремен ауыстырылады. Жалғастырамыз ба?",
    badFile: "sejire/seed/v1 (12 сөз) немесе sejire/envelope/v1 (сейф) файлы керек.",
    noLocal: "Жергілікті көшірме жоқ",
    unknownTime: "уақыты белгісіз",
  },
  versions: {
    title: "Сейф нұсқалары",
    hint: "Әр сақтау — сол 12 сөзбен жаңа нұсқа. Ескілері қалады. Демо-сайтта нұсқалар осы браузерде; өндірісте — Arweave-те.",
    vault: (fp) => `Сейф ${fp}`,
    opened: (id) => ` · ашылғаны ${id}…`,
    words: "12 сөз",
    searching: "Нұсқаларды іздеу…",
    latest: "Соңғысы",
    versionN: (n) => `Нұсқа ${n}`,
    now: " · қазір",
    whereArweave: "Arweave",
    whereDemo: "демо · браузер",
    whereSponsor: "кассир / мұрағат",
    whereBrowser: "браузер",
    localCopy: "Қазіргі жергілікті көшірме",
    needWords: "12 сөзді енгізіңіз.",
    decryptFail: "Ашылмады: 12 сөзді тексеріңіз.",
    noLocal: "Жергілікті көшірме жоқ.",
    needOpen: "Алдымен сейфті 12 сөзбен ашыңыз немесе сақтаңыз.",
    wrongVault: "Бұл 12 сөз басқа сейфке қатысты.",
    none: "Бұл сейфтің сақталған нұсқасы әзірге жоқ (желіде де, браузерде де).",
    noneLocalToo: "Жергілікті көшірме де жоқ.",
  },
  publish: {
    title: "Сақтау",
    lead: "12 сөз — сіздің кілтіңіз. Әр сақтау — сол сөздермен жаңа нұсқа; бұрынғылары қалады.",
    leadDemo:
      " Қазір сайтта демо-режим: нұсқалар осы браузерде сақталады (төлемсіз, Arweave-сіз) — сценарийді тексеру үшін.",
    leadSponsor: " Мәңгілік — кассир арқылы",
    leadTreasury: " Желіні жоба қазынасы төлейді. 12 сөз тек сейфті шифрлайды.",
    newVersionHint: "Қазіргі шежірені сол 12 сөзбен жаңа нұсқа ретінде сақтау",
    prevKept: (id) => ` Алдыңғы нұсқа қалады (${id}…).`,
    oldKept: " Егер сейф бұрын сақталса — ескі нұсқалар қалады.",
    demoNew: "Демо · браузердегі жаңа нұсқа",
    payNew: (hint) => `Жаңа нұсқа · төлем${hint}`,
    networkNew: "Жаңа нұсқа желіге",
    treasuryNew: "Жаңа нұсқа · жоба қазынасы",
    treasurySave: "Қазынамен сақтау",
    sendingTreasury: (addr, balance) => `Қазына ${addr}… · ${balance} AR`,
    selfArNew: "Жаңа нұсқа өз AR-ыңызбен",
    localCipher: "Тек жергілікті шифр / файл",
    otherWords: "Басқа 12 сөз",
    createWords: "12 сөз жасау",
    haveWords: "Сөздерім бар (жаңа нұсқа)",
    writeNow: "Осы сөздерді қазір қағазға жазыңыз.",
    iWrote: "Жаздым",
    repeat: "12 сөзді қайталаңыз.",
    matched:
      "Сөздер сәйкес. Кілт — қағазға немесе JSON. Әрі қарай нұсқаны сақтаңыз; кейін сол сөздермен қайта сақтау — жаңа нұсқа болады.",
    seedJson: "12 сөз · JSON",
    seedJsonAgain: "12 сөз · JSON тағы",
    demoSave: "Демо · нұсқаны браузерге сақтау",
    foreverPay: (hint) => `Мәңгі · төлем${hint}`,
    selfArFallback: "Желіге өз AR-ыңызбен (запас)",
    selfArMain: "Шежірені орталықсызданған желіге",
    localTree: "Шифрланған шежіре · жергілікті",
    payLine: (price, via, ver) =>
      `Төлем ${price}${via}${ver}. Кассирге тек шифрланған сейф кетеді — 12 сөз емес.`,
    viaMock: " (mock-кассир, банксіз)",
    viaKaspi: " Kaspi арқылы",
    newVerShort: " · жаңа нұсқа",
    openKaspi: "Kaspi төлемін ашу ↗",
    paidMock: "Төленді (mock) · мәңгі сақтау",
    paidLive: "Төледім · сақтау",
    existingHint:
      "Сол 12 сөз → сол сейф. Сақтау жаңа нұсқа жасайды; ескілері қалады.",
    demoSaveBtn: "Демо-нұсқаны сақтау",
    encryptPay: "Шифрлап төлеу",
    encryptSend: "Шифрлап жіберу",
    busy: "Жұмыс істеп жатырмыз… Терезені жаппаңыз.",
    addressFromWords: "12 сөзден адрес:",
    fundLead:
      "12 сөзіңізден шыққан адресте AR жоқ, сондықтан желі сейфті қабылдамайды. Жаңа сөз жасаудың керегі жоқ.",
    copyTitle: "Көшіру үшін басыңыз",
    copied: "Көшірілді",
    copyHint: "Адрессті көшіру үшін басыңыз",
    fund1: "Жоғарыдағы адрессті көшіріңіз.",
    fund2: "Binance → Шығару → монета AR → желі тек Arweave (ERC-20 емес, BNB емес).",
    fund3: "Осы адрессті қойыңыз. 0.05–0.1 AR жетеді.",
    fund4: "12 сөзді ArConnect-ке кіргізбеңіз — басқа адрес шығады, ақша мұнда жетпейді.",
    fund5: "Аударма өткен соң (әдетте бірнеше минут) «Жіберу» басыңыз.",
    send: "Жіберу",
    payInstead: "AR орнына кассир арқылы төлеу",
    demoInstead: "Демо-нұсқаны браузерге сақтау",
    discardConfirm: "Жасалған 12 сөз экраннан жоғалады. Қағазға жазып қойдыңыз ба?",
    vaultFp: (fp) => `Сейф ${fp}…`,
    encrypting: "Сейфті 12 сөздің кілтімен шифрлап жатырмыз…",
    demoSaving: "Демо-нұсқаны осы браузерге сақтап жатырмыз…",
    makingAddress: "12 сөзден Arweave адресі жасалуда (бөгде әмиянсыз, 10–40 сек)…",
    sending: (addr, balance) => `Сөзден адрес ${addr}… · баланс ${balance} AR. Жіберіп жатырмыз…`,
    fundHint: " Төмендегі адреске AR аударып, «Жіберу» басыңыз.",
    checkout: "Төлем сессиясын жасап жатырмыз…",
    noSession: "Төлем сессиясы немесе шифр жоқ.",
    mockConfirm: "Mock-төлемді растап жатырмыз…",
    kaspiAsk: "Kaspi төлемді растады ма деп сұрап жатырмыз…",
    kaspiWait:
      "Kaspi әлі растаған жоқ. Kaspi сілтемесін ашып төлеңіз, сосын батырманы қайта басыңыз.",
    uploading: "Желіге тек шифр жіберілуде…",
    mismatch: "Сөз тіркесі сәйкес емес.",
    repeatFirst: "Алдымен 12 сөзді қайталаңыз.",
    repeatRecord: "Алдымен 12 сөзді қайталаңыз — жазып алғаныңызды осылай тексереміз.",
    seedDownloaded: "sejire-12-words….json файлы (sejire/seed/v1) жүктелді",
    badMnemonic: "12 сөзден тұратын дұрыс BIP-39 тіркесі керек.",
    copiedStatus: "Адрес көшірілді",
    copyManual: "Адрессті қолмен көшіріңіз",
    kaspiPaid: "Kaspi төлемді растады. Сақтауға болады.",
    addressLabel: "12 сөзіңізден адрес:",
  },
  admin: {
    title: "Касса",
    sub: "Кілттер, қазына және желі қозғалысы. Аттары мен 12 сөз мұнда жоқ.",
    pagesHint:
      "Қазір касса GitHub Pages-те, осы браузерде. Кейін сол экран sejire.ar.io-ға көшеді.",
    setupHint: "Алғашқы кіру: құпия сөз тек сізде. git пен чатқа салмаңыз.",
    password: "Құпия сөз (кемі 12 таңба)",
    passwordAgain: "Тағы бір рет",
    create: "Кассаны құру",
    enter: "Кіру",
    wrong: "Құпия сөз қате.",
    short: "Құпия сөз — кемі 12 таңба.",
    mismatch: "Құпия сөздер сәйкес емес.",
    failed: "Болмады.",
    tabOverview: "Шолу",
    tabKeys: "Кілттер",
    tabPassword: "Құпия сөз",
    trees: "Шежіре",
    saves: "Сақтау",
    payments: "Төлем",
    sum: "Сома",
    whenTrees: "Arweave-тегі сақтаулар",
    pays: "Осы кассадағы төлемдер",
    when: "Уақыт",
    vault: "Сейф",
    path: "Жол",
    emptyTrees: "Желіде SEJIRE сейфі әлі жоқ",
    emptyPays: "Төлем әлі жоқ",
    treasury: "Қазына",
    none: "әлі жоқ",
    has: "бар",
    keysHint:
      "Бос өріс = өзгертпеу. Қазына JSON бір рет көрінеді — бірден 1Password-қа. Қағазға тек адрес.",
    mockWarn:
      "Қазына бар, Kaspi жоқ: желіге сақтау осы браузер қазынасынан, тірі төлемсіз.",
    createTreasury: "Қазынаны осында құру",
    generating: "Қазына жасалуда…",
    generated: "Қазына құрылды. JSON-ды қазір көшіріңіз.",
    pasteJwk: "Қазына JWK қою",
    siteJwk: "Сайт / permaweb JWK",
    kaspiToken: "Kaspi токені",
    tradePoint: "Trade Point Id",
    api: "Kaspi API",
    payPath: "Төлем жолы",
    mock: "mock — ЖК әлі жоқ",
    kaspiPay: "kaspi",
    price: "Баға (тиын)",
    currency: "Валюта",
    saveKeys: "Сақтау",
    savedKeys: "Осы браузерге сақталды.",
    clearTreasury: "Қазынаны браузерден өшіру",
    clearSite: "Сайт кілтін өшіру",
    clearKaspi: "Kaspi токенін өшіру",
    once: "Бір рет көрсетіледі. Адрес:",
    onceHint: "Бүкіл JSON — 1Password пен флешкаға. Агентке чатқа жібермеңіз.",
    copyJson: "JSON көшіру",
    copyAddr: "Адрессті көшіру",
    alreadyTreasury: "Қазына осы браузерде сақталған.",
    replaceConfirm: "Қазына бар. Жаңасын жасап алмастырамыз ба?",
    invalidJwk: "Бұл JWK емес.",
    newPass: "Жаңа құпия сөз",
    changePass: "Құпия сөзді ауыстыру",
    changed: "Құпия сөз ауысты.",
    logout: "Шығу",
    fundHint: "Осы адреске AR құйыңыз (Binance → Arweave желісі).",
    arweaveLag: "Жаңа TX шолуда желі индекстеген соң пайда болады — әдетте минуттар.",
    savedNet: "сейф желіде",
    paid: "төленді",
  },
  kinship: {
    self: "сол адам",
    child: "бала",
    parent: "ата-ана",
    grandchild: "немере",
    grandparent: "ата/әже",
    sibling: "аға-іні / апа-сіңлі",
    nibling: "жиен",
    pibling: "нағашы / ағай / тәте",
    cousin: "немере ағайын",
    related: "ортақ ата-баба",
    unrelated: "осы түсірілімде ортақ жолы жоқ",
  },
  kinshipRelatedSteps: (da, db) => `ортақ ата-баба (қадам ${da}+${db})`,
  relation: { father: "Әке", mother: "Ана", child: "Бала" },
  quota:
    "Жоба браузер жадына сыймады. JSON түсіріңіз — әйтпесе қойынды жабылса түзетулер жоғалуы мүмкін.",
};

const en: UiMessages = {
  docTitle: "SEJIRE — family tree editor",
  docDescription: "A versioned genealogy vault. Each save is a new immutable commit.",
  language: "Language",
  localeName: { kk: "Қазақша", ru: "Русский", en: "English" },
  localeShort: { kk: "ҚАЗ", ru: "РУС", en: "ENG" },
  defaultTreeTitle: "My family",
  cancel: "Cancel",
  close: "Close",
  back: "Back",
  next: "Next",
  done: "Done",
  save: "Save",
  add: "Add",
  undo: "Undo",
  more: "More",
  welcome: {
    openMenu: "SEJIRE — open menu",
    start: "Start",
    continueDraft: "Continue",
    restoreSeed: "Open with 12 words",
    newTree: "New tree",
    cashier: "Cashier",
    replaceDraftConfirm:
      "The current draft will be deleted. You can continue it first and export JSON. Create a new tree?",
  },
  crash: {
    title: "The app stopped",
    body: "The draft in this browser is usually intact. Open it — the chart should come back. If it keeps failing, export JSON while this tab is still open.",
    noDraft: "No draft found in this browser.",
    jsonDownloaded: "JSON downloaded.",
    jsonFailed: "Could not export JSON",
    openDraft: "Open draft",
    reload: "Reload",
    exportJson: "Export JSON",
  },
  workspace: {
    save: "Save",
    moreMenu: "More",
    zhuzRu: "Zhuz & ru",
    zhuzRuTitle: "For a Kazakh shezhire. Optional",
    pdfTree: "Tree PDF",
    pdfShezhire: "Shezhire PDF",
    exportJson: "Export JSON",
    exportJsonTitle: "Download all tree data as JSON",
    importJson: "Import JSON",
    importJsonTitle: "Load a tree from a JSON file",
    versions: "Vault versions",
    versionsTitle: "Every save under the same 12 words",
    home: "Home",
    closeProfile: "Close profile",
    addSelf: "Add yourself",
    addMother: "Add mother",
    addFather: "Add father",
    flashAddParents: "Add mother or father with the “+” cards on the chart",
    flashMotherAdded: "Mother added",
    flashFatherAdded: "Father added",
    flashNeedPerson: "Add at least one person first",
    commitBeforeSave: "Snapshot before save",
    flashFocus: (name) => `Chart shows ancestors of “${name}”`,
    flashReflow: "Chart rebuilt",
    flashPdfTree: (paper) => `Tree PDF downloaded · ${paper}`,
    flashPdfShezhire: "Shezhire PDF downloaded",
    flashJson: "JSON downloaded — all tree data",
    flashNoTrees: "This version has no trees",
    flashVersionOpened: (count) =>
      `Opened version · ${count} people. You can edit and save again (new payment).`,
    flashImported: (count) => `Loaded: ${count} people`,
    flashRemoved: (name) => `“${name}” removed from the tree`,
    flashRestored: "Person restored to the tree",
    flashZhuzSaved: "Zhuz and ru saved for this tree",
    flashZhuzCleared: "Zhuz and ru cleared",
    replaceDraft: (count, action) =>
      `The current draft (${count} people) will be replaced: ${action}. You can export JSON from More first. Continue?`,
    replaceOpenVersion: "opening another vault version",
    replaceJson: "loading JSON",
    publishedDemo: (id, ver) =>
      `Demo version saved in this browser (${id}…). Keep the 12 words.${ver}`,
    publishedSponsorMock: (id, ver) =>
      `Mock cashier accepted the vault (${id}…). With Turbo this becomes a real TX. Keep the 12 words.${ver}`,
    publishedForever: (id, ver) => `Forever on Arweave (${id}…). Keep the 12 words.${ver}`,
    publishedArweave: (id, ver) => `Saved to Arweave (${id}…). Keep the 12 words.${ver}`,
    publishedFile: (id, ver) =>
      `Vault file downloaded${id ? ` · version ${id}…` : ""}. Keep the 12 words.${ver}`,
    publishedNewVersion: " New version; earlier ones are in Vault versions.",
  },
  pedigree: {
    startWithSelf: "Start with yourself",
    addSelf: "Add yourself",
    addFather: "Add father",
    addMother: "Add mother",
    noFacts: "no details",
    from: "From",
    toSelf: "To me",
    toSelfTitle: "Return the chart to you",
    focusChipTitle: "The chart is built from this person toward ancestors",
    view: "View",
    fit: "Fit",
    fitTitle: "Shrink so the whole tree is visible. Cards themselves do not shrink.",
    resetView: "Reset view",
    bornAbbr: "b.",
    diedAbbr: "d.",
    years: "years",
    birthAbbr: "b.",
    deathAbbr: "d.",
    burialAbbr: "bur.",
    jobAbbr: "job",
    clickProfile: "Click — open profile",
    dblclickAncestors: "Double-click / profile button — show ancestors on the chart",
    maiden: "maiden",
    birth: "birth",
    birthPlace: "birthplace",
    death: "death",
    deathPlace: "place of death",
    burial: "burial",
    burialPlace: "burial place",
    occupation: "occupation",
  },
  person: {
    empty: "Tap a card on the chart to open the details form.",
    unnamed: "Unnamed",
    noDates: "no dates",
    profile: (name) => `Profile: ${name}`,
    close: "Close",
    showAncestors: "Show ancestors on the chart",
    name: "Name",
    sex: "Sex",
    sexUnknown: "unspecified",
    sexF: "female",
    sexM: "male",
    birth: "Birth",
    death: "Death",
    date: "Date",
    place: "Place",
    placePh: "city, country",
    notes: "Notes",
    notesPh: "A few words about the person",
    moreFacts: "More details",
    maiden: "Maiden name",
    maidenPh: "if applicable",
    occupation: "Occupation",
    burialDate: "Burial date",
    burialPlace: "Burial place",
    burialPlacePh: "cemetery, city",
    birthDateAria: "Date of birth",
    deathDateAria: "Date of death",
    burialDateAria: "Burial date",
    relatives: "Relatives",
    addFather: "+ Father",
    addMother: "+ Mother",
    protocol: "Kinship from protocol",
    protocolHint: "Local process snapshot · AO network is not called",
    protocolLoading: "Computing zheti ata and relations…",
    jetiAta: "Zheti ata",
    ancestors: "Ancestors",
    knee: (n) => `gen. ${n}`,
    relate: "Relate links",
    delete: "Remove from tree",
    deleteConfirm: (name) =>
      `Remove ${name} from the chart? You can press Undo right after.`,
    thisPerson: "this person",
  },
  addModal: {
    hint: "A name is enough — you can fill the rest on the card.",
    name: "Name",
    namePh: "Full name",
    sex: "Sex",
  },
  datePh: "1990 or 15.03.1990",
  zhuz: {
    title: "Zhuz & ru",
    hint: "For a Kazakh shezhire. If you are not Kazakh, just close — nothing will appear on the tree.",
    zhuz: "Zhuz",
    ru: "Ru",
    ruPh: "e.g. Argyn",
    unspecified: "unspecified",
    clear: "Clear",
  },
  shezhirePick: {
    title: "Shezhire",
    hint: "Choose a layout",
    formatA4p: "A4 portrait",
    formatA4l: "A4 landscape",
    blurb: {
      manuscript: "Parchment, ornament, vertical scroll",
      registry: "Old felt pattern: qosqar müyiz around the frame",
      cascade: "Horizontal ancestor line — for a wide frame",
    },
  },
  restore: {
    title: "Open with words",
    hint: "Enter the 12 words. If the vault was saved more than once, you will see every version and pick one.",
    open: "Open",
    searching: "Searching…",
    pickTitle: "Choose a version",
    pickHint: (fp) => `Vault ${fp}: several saves found. You can open any of them.`,
    localCopy: "Current local copy",
    inBrowser: "in this browser",
    demoVersion: "Demo version",
    browserVersion: "Browser version",
    latestNetwork: "Latest on network",
    networkVersion: (n) => `Network · version ${n}`,
    hideFile: "Hide file",
    openFile: "Open from file",
    fileLabel: "Archive, receipt or SEJIRE recovery-words file (.json)",
    needWords: "Need 12 valid English words.",
    looking: (fp) => `Looking for versions (${fp})…`,
    fileReady: "Words from the file are filled in. Tap Open.",
    wordsLabel: "12 SEJIRE recovery words",
    archiveReady: (name) => `Archive “${name}” selected. Enter its 12 words and choose Restore archive. No connection to the storage service is needed.`,
    removeFile: "Remove file and search online",
    openingFile: "Opening archive…",
    openArchive: "Restore archive",
    fileTooLarge: "This file is too large. Choose an archive up to 10 MB.",
    arweaveDown: "Arweave network unavailable.",
    arweaveFail: "Could not reach Arweave. Check the network and try again.",
    noneAnywhere: "Vault not found on the network or in this browser.",
    noneLocal: "No local copies of this vault in the browser either.",
    shownLocal: "Showing copies from this browser.",
    decryptFail: "Could not open: check the 12 words or the file.",
    noTrees: "No trees in this vault",
    replaceDraft: "The current browser draft will be replaced by the restored tree. Continue?",
    badFile: "Need a sejire/seed/v1 (12 words) or sejire/envelope/v1 (vault) file.",
    noLocal: "No local copy",
    unknownTime: "time unknown",
  },
  versions: {
    title: "Vault versions",
    hint: "Each save is a new version under the same 12 words. Older ones stay. On the demo site they live in this browser; in production — on Arweave.",
    vault: (fp) => `Vault ${fp}`,
    opened: (id) => ` · open ${id}…`,
    words: "12 words",
    searching: "Looking for versions…",
    latest: "Latest",
    versionN: (n) => `Version ${n}`,
    now: " · current",
    whereArweave: "Arweave",
    whereDemo: "demo · browser",
    whereSponsor: "cashier / archive",
    whereBrowser: "browser",
    localCopy: "Current local copy",
    needWords: "Enter the 12 words.",
    decryptFail: "Could not open: check the 12 words.",
    noLocal: "No local copy.",
    needOpen: "Open or save the vault with the 12 words first.",
    wrongVault: "These 12 words belong to a different vault.",
    none: "No saved versions of this vault yet (on the network or in the browser).",
    noneLocalToo: "No local copies either.",
  },
  publish: {
    title: "Save",
    lead: "The 12 words are your key. Each save is a new version under the same words; earlier ones remain.",
    leadDemo:
      " Demo mode is on: versions stay in this browser (no payment, no Arweave) so you can try the flow.",
    leadSponsor: " Forever — through the cashier",
    leadTreasury: " The project treasury pays the network. The 12 words only encrypt the vault.",
    newVersionHint: "Save the current tree as a new version with the same 12 words",
    prevKept: (id) => ` The previous version will remain (${id}…).`,
    oldKept: " If this vault was saved before, older versions stay.",
    demoNew: "Demo · new version in browser",
    payNew: (hint) => `New version · pay${hint}`,
    networkNew: "New version to the network",
    treasuryNew: "New version · project treasury",
    treasurySave: "Save with project treasury",
    sendingTreasury: (addr, balance) => `Treasury ${addr}… · ${balance} AR`,
    selfArNew: "New version with your own AR",
    localCipher: "Local ciphertext / file only",
    otherWords: "Different 12 words",
    createWords: "Create 12 words",
    haveWords: "I already have words (new version)",
    writeNow: "Write these words on paper now.",
    iWrote: "I wrote them down",
    repeat: "Repeat the 12 words.",
    matched:
      "The words match. Keep the key on paper or as JSON. Then save a version; saving again later under these words creates a new version.",
    seedJson: "12 words · JSON",
    seedJsonAgain: "12 words · JSON again",
    demoSave: "Demo · save version in browser",
    foreverPay: (hint) => `Forever · pay${hint}`,
    selfArFallback: "To the network with your AR (fallback)",
    selfArMain: "Tree to the decentralized network",
    localTree: "Encrypted tree · local",
    payLine: (price, via, ver) =>
      `Payment ${price}${via}${ver}. Only the encrypted vault goes to the cashier — not the 12 words.`,
    viaMock: " (mock cashier, no bank)",
    viaKaspi: " via Kaspi",
    newVerShort: " · new version",
    openKaspi: "Open Kaspi payment ↗",
    paidMock: "Paid (mock) · save forever",
    paidLive: "I paid · save",
    existingHint:
      "The same 12 words → the same vault. Saving creates a new version; older ones remain.",
    demoSaveBtn: "Save demo version",
    encryptPay: "Encrypt and pay",
    encryptSend: "Encrypt and send",
    busy: "Working… Do not close this window.",
    addressFromWords: "Address from 12 words:",
    fundLead:
      "The address from your 12 words has no AR, so the network will not take the vault. You do not need new words.",
    copyTitle: "Click to copy",
    copied: "Copied",
    copyHint: "Click to copy the address",
    fund1: "Copy the address above.",
    fund2: "Binance → Withdraw → coin AR → network Arweave only (not ERC-20, not BNB).",
    fund3: "Paste this address. 0.05–0.1 AR is enough.",
    fund4: "Do not import the 12 words into ArConnect — that makes a different address, and funds will not arrive here.",
    fund5: "When the transfer lands (usually a few minutes), tap Send.",
    send: "Send",
    payInstead: "Pay via cashier instead of AR",
    demoInstead: "Save a demo version in the browser",
    discardConfirm: "The generated 12 words will leave this screen. Have you already written them on paper?",
    vaultFp: (fp) => `Vault ${fp}…`,
    encrypting: "Encrypting the vault with the key from the 12 words…",
    demoSaving: "Saving a demo version in this browser…",
    makingAddress: "Creating an Arweave address from the 12 words (no third-party wallet, 10–40 sec)…",
    sending: (addr, balance) => `Address from phrase ${addr}… · balance ${balance} AR. Sending…`,
    fundHint: " Send AR to the address below, then tap Send.",
    checkout: "Creating a payment session…",
    noSession: "No payment session or ciphertext.",
    mockConfirm: "Confirming mock payment…",
    kaspiAsk: "Asking Kaspi whether payment went through…",
    kaspiWait:
      "Kaspi has not confirmed payment yet. Open the Kaspi link, pay, then tap the button again.",
    uploading: "Sending ciphertext only to the network…",
    mismatch: "The phrase does not match.",
    repeatFirst: "Repeat the 12 words first.",
    repeatRecord: "Repeat the 12 words first — that is how we know you wrote them down.",
    seedDownloaded: "File sejire-12-words….json (schema sejire/seed/v1) downloaded",
    badMnemonic: "Need a valid 12-word BIP-39 phrase.",
    copiedStatus: "Address copied",
    copyManual: "Copy the address manually",
    kaspiPaid: "Kaspi confirmed payment. You can save.",
    addressLabel: "Address from your 12 words:",
  },
  admin: {
    title: "Cashier",
    sub: "Keys, treasury, and network activity. Names and 12 words never appear here.",
    pagesHint:
      "The cashier is on GitHub Pages in this browser for now. The same screen will move to sejire.ar.io later.",
    setupHint: "First visit: the password stays with you. Do not put it in git or chat.",
    password: "Password (12+ characters)",
    passwordAgain: "Again",
    create: "Create cashier",
    enter: "Log in",
    wrong: "Wrong password.",
    short: "Password must be at least 12 characters.",
    mismatch: "Passwords do not match.",
    failed: "That did not work.",
    tabOverview: "Overview",
    tabKeys: "Keys",
    tabPassword: "Password",
    trees: "Trees",
    saves: "Saves",
    payments: "Payments",
    sum: "Total",
    whenTrees: "Saves on Arweave",
    pays: "Payments in this cashier",
    when: "Time",
    vault: "Vault",
    path: "Path",
    emptyTrees: "No SEJIRE vaults on the network yet",
    emptyPays: "No payments yet",
    treasury: "Treasury",
    none: "not yet",
    has: "ready",
    keysHint:
      "Empty field = leave unchanged. Treasury JSON is shown once — put it in 1Password immediately. Paper: address only.",
    mockWarn:
      "Treasury is set, Kaspi is not: network saves use this browser’s treasury, without live payment.",
    createTreasury: "Create treasury here",
    generating: "Creating treasury…",
    generated: "Treasury created. Copy the JSON now.",
    pasteJwk: "Paste treasury JWK",
    siteJwk: "Site / permaweb JWK",
    kaspiToken: "Kaspi token",
    tradePoint: "Trade Point Id",
    api: "Kaspi API",
    payPath: "Payment path",
    mock: "mock — no merchant yet",
    kaspiPay: "kaspi",
    price: "Price (tiyn)",
    currency: "Currency",
    saveKeys: "Save",
    savedKeys: "Saved in this browser.",
    clearTreasury: "Remove treasury from this browser",
    clearSite: "Remove site key",
    clearKaspi: "Remove Kaspi token",
    once: "Shown once. Address:",
    onceHint: "Put the full JSON in 1Password and on a drive. Do not send it in chat.",
    copyJson: "Copy JSON",
    copyAddr: "Copy address",
    alreadyTreasury: "Treasury is already stored in this browser.",
    replaceConfirm: "Treasury already exists. Create a new one and replace it?",
    invalidJwk: "That is not a JWK.",
    newPass: "New password",
    changePass: "Change password",
    changed: "Password changed.",
    logout: "Log out",
    fundHint: "Send AR to this address (Binance → Arweave network).",
    arweaveLag: "New TXs show up in the overview after the network indexes them — usually minutes.",
    savedNet: "vault on network",
    paid: "paid",
  },
  kinship: {
    self: "same person",
    child: "child",
    parent: "parent",
    grandchild: "grandchild",
    grandparent: "grandparent",
    sibling: "sibling (or half)",
    nibling: "nibling",
    pibling: "uncle/aunt",
    cousin: "cousin",
    related: "shared ancestors",
    unrelated: "no shared line in this snapshot",
  },
  kinshipRelatedSteps: (da, db) => `shared ancestors (steps ${da}+${db})`,
  relation: { father: "Father", mother: "Mother", child: "Child" },
  quota:
    "The draft does not fit in browser storage. Export JSON — otherwise edits may vanish when you close the tab.",
};

const catalogs: Record<UiLocale, UiMessages> = { ru, kk, en };

export function uiT(locale: UiLocale = "ru"): UiMessages {
  return catalogs[locale] ?? catalogs.ru;
}

export function formatUiDateTime(iso: string, locale: UiLocale, unknown: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return unknown;
  return new Date(d).toLocaleString(LOCALE_BCP47[locale], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
