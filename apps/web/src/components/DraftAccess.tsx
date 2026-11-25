import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DRAFT_KEY, GUIDE_KEY, assertDraftWriteToken, getDraftOwnership, type DraftWriteToken } from '../lib/draftOwnership';
import { loadDraftTree, replaceDraftTree } from '../lib/draftStorage';
import { defaultGuide, loadGuide, type GuideState } from '../lib/guide';
import { coerceTreeStore, downloadTreeJson } from '../lib/treeJson';
import type { TreeStore } from '../lib/types';
import { downloadText } from '../lib/download';
import { useI18n } from '../lib/i18n/I18nProvider';

const copy = {
  ru: {
    checking: 'Проверяем доступ к черновику…', owned: 'Черновик открыт для редактирования в этой вкладке.',
    blocked: 'Черновик открыт в другой вкладке. Здесь можно скачать сохранённую копию. Для редактирования закройте другую вкладку или освободите черновик в ней, затем продолжите здесь.',
    released: 'Редактирование в этой вкладке остановлено. Сохранённый черновик можно открыть здесь, когда другая вкладка его освободит.',
    unavailable: 'Браузер не смог предоставить безопасный доступ к записи. Редактирование остановлено; сохранённую копию можно скачать. Используйте браузер с поддержкой Web Locks и разрешённым хранилищем сайта.',
    conflict: 'Черновик был изменён вне этой вкладки. Запись остановлена, чтобы не заменить другую копию. Скачайте нужные данные перед продолжением.',
    unsaved: 'Последние изменения пока не записаны в хранилище браузера. Они остаются в этой вкладке. Скачайте свою копию, освободите место и повторите сохранение до закрытия вкладки.',
    failed: 'Не удалось заменить черновик. Прежняя сохранённая копия не удалена.',
    release: 'Освободить черновик', retry: 'Продолжить здесь', download: 'Скачать сохранённую копию', mine: 'Скачать мои изменения',
    save: 'Повторить локальное сохранение', latest: 'Открыть сохранённый черновик', discard: 'Открыть сохранённый черновик вместо несохранённых изменений этой вкладки? Сначала скачайте свою копию.',
    home: 'На главную', empty: 'На этом устройстве пока нет сохранённого черновика.',
  },
  kk: {
    checking: 'Жобаға қолжетімділікті тексеріп жатырмыз…', owned: 'Жоба осы қойындыда өңдеуге ашық.',
    blocked: 'Жоба басқа қойындыда ашық. Мұнда сақталған көшірмені жүктеп алуға болады. Өңдеу үшін басқа қойындыны жабыңыз немесе онда жобаны босатып, осында жалғастырыңыз.',
    released: 'Бұл қойындыда өңдеу тоқтатылды. Басқа қойынды жобаны босатқанда осында жалғастыруға болады.',
    unavailable: 'Браузер қауіпсіз жазуға рұқсат бере алмады. Өңдеу тоқтатылды; сақталған көшірмені жүктеп алуға болады. Web Locks пен сайт қоймасын қолдайтын браузерді пайдаланыңыз.',
    conflict: 'Жоба басқа жерден өзгертілді. Басқа көшірмені алмастырмау үшін жазу тоқтатылды. Жалғастырмас бұрын қажетті деректерді жүктеп алыңыз.',
    unsaved: 'Соңғы өзгерістер браузер қоймасына әлі жазылған жоқ. Олар осы қойындыда қалды. Көшірмеңізді жүктеп алып, орын босатыңыз және қойындыны жаппас бұрын қайта сақтаңыз.',
    failed: 'Жобаны алмастыру мүмкін болмады. Бұрын сақталған көшірме жойылған жоқ.',
    release: 'Жобаны босату', retry: 'Осында жалғастыру', download: 'Сақталған көшірмені жүктеу', mine: 'Өз өзгерістерімді жүктеу',
    save: 'Қайта жергілікті сақтау', latest: 'Сақталған жобаны ашу', discard: 'Осы қойындының сақталмаған өзгерістерінің орнына сақталған жобаны ашу керек пе? Алдымен өз көшірмеңізді жүктеп алыңыз.',
    home: 'Басты бетке', empty: 'Бұл құрылғыда сақталған жоба әзірше жоқ.',
  },
  en: {
    checking: 'Checking access to the draft…', owned: 'This tab can edit the draft.',
    blocked: 'The draft is open in another tab. You can download its saved copy here. To edit here, close the other tab or release the draft there, then continue here.',
    released: 'Editing has stopped in this tab. You can continue here after the other tab releases the draft.',
    unavailable: 'The browser could not provide safe write access. Editing is stopped; you can download the saved copy. Use a browser with Web Locks and site storage enabled.',
    conflict: 'The draft changed outside this tab. Writing has stopped to protect the other copy. Download the data you need before continuing.',
    unsaved: 'The latest changes have not been written to browser storage. They remain in this tab. Download your copy, free some space and retry saving before closing the tab.',
    failed: 'The draft could not be replaced. The previous saved copy was not deleted.',
    release: 'Release draft', retry: 'Continue here', download: 'Download saved copy', mine: 'Download my changes',
    save: 'Retry local save', latest: 'Open saved draft', discard: 'Open the saved draft instead of this tab’s unsaved changes? Download your copy first.',
    home: 'Home', empty: 'No saved draft was found on this device.',
  },
};

export function useDraftAccess() {
  const [ownership] = useState(() => getDraftOwnership()!);
  const state = useSyncExternalStore(ownership.subscribe, ownership.getSnapshot, ownership.getSnapshot);
  const holder = useRef<object | null>(null);
  useEffect(() => {
    const owner = {}; holder.current = owner;
    // StrictMode's provisional mount never starts a lock acquisition.
    const timer = window.setTimeout(() => { void ownership.acquire(owner); }, 0);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === DRAFT_KEY || event.key === GUIDE_KEY) ownership.observeStorageChange();
    };
    const onHide = () => { window.clearTimeout(timer); ownership.release(owner); };
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) void ownership.acquire(owner); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      ownership.release(owner);
      if (holder.current === owner) holder.current = null;
    };
  }, [ownership]);
  const request = useCallback(() => holder.current ? ownership.acquire(holder.current) : Promise.resolve(false), [ownership]);
  const release = useCallback(() => { if (holder.current) ownership.release(holder.current); }, [ownership]);
  return { state, token: ownership.currentToken(), request, release };
}

type Access = ReturnType<typeof useDraftAccess>;
type DocumentState = { store: TreeStore | null; guide: GuideState; token: DraftWriteToken };
type Pending = { store: TreeStore; guide: GuideState; token: DraftWriteToken };

/** React displays the document; durable writes happen synchronously in explicit
 * input/action handlers, never in render, setState updaters or autosave effects. */
export function useDraftDocument(access: Access, initial: { store: TreeStore | null; guide: GuideState }) {
  const [value, setValue] = useState<DocumentState>({ ...initial, token: null });
  const current = useRef(value);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [failed, setFailed] = useState(false);
  const assign = useCallback((next: DocumentState) => { current.current = next; setValue(next); }, []);
  const keepPending = useCallback((next: Pending | null) => { pendingRef.current = next; setPending(next); }, []);
  const loadSaved = useCallback(() => {
    if (!access.token) return false;
    try {
      assertDraftWriteToken(access.token);
      const store = loadDraftTree();
      // A damaged/unknown older draft can still be downloaded verbatim. Never
      // treat unreadable nonempty bytes as permission to start an empty tree.
      if (!store && localStorage.getItem(DRAFT_KEY)) throw Error('invalid_draft');
      assign({ store, guide: loadGuide() ?? { ...defaultGuide(), ...(store ? { step: 'done' as const } : {}) }, token: access.token });
      keepPending(null); setFailed(false); return true;
    } catch { setFailed(true); return false; }
  }, [access.token, assign, keepPending]);
  useEffect(() => {
    if (!access.token || current.current.token === access.token || pendingRef.current) return;
    loadSaved();
  }, [access.token, loadSaved]);
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
  const token = value.token;
  function persist(store: TreeStore, guide: GuideState, preserveInput: boolean): boolean {
    // Reject callbacks from an older editor incarnation after a new lease was
    // loaded. Keeping a failed *current* edit in memory never writes it over a
    // different tab's saved draft.
    if (current.current.token !== token) return false;
    try {
      assertDraftWriteToken(token);
      if (!replaceDraftTree(store, guide)) throw Error('storage_unavailable');
      assign({ store, guide, token }); keepPending(null); setFailed(false); return true;
    } catch {
      if (preserveInput) {
        assign({ store, guide, token }); keepPending({ store, guide, token });
      }
      setFailed(true); return false;
    }
  }
  function updateStore(next: TreeStore | ((previous: TreeStore) => TreeStore), treeId: string) {
    const previous = current.current.store;
    if (!previous || previous.meta.id !== treeId || current.current.token !== token) return;
    const candidate = coerceTreeStore(typeof next === 'function' ? next(previous) : next);
    if (candidate) persist(candidate, current.current.guide, true);
  }
  function updateGuide(guide: GuideState, treeId: string) {
    if (current.current.store?.meta.id === treeId) persist(current.current.store, guide, true);
  }
  function replace(store: TreeStore, guide: GuideState) { return persist(store, guide, false); }
  function retrySave() {
    const copy = pendingRef.current;
    if (copy && copy.token === access.token) persist(copy.store, copy.guide, true);
  }
  return { ...value, ready: Boolean(access.token && token === access.token), pending, failed,
    updateStore, updateGuide, replace, loadSaved, retrySave };
}

export function DraftAccessNotice({ access, document: draft, onHome }: {
  access: Access; document: ReturnType<typeof useDraftDocument>; onHome: () => void;
}) {
  const { locale } = useI18n(), t = copy[locale];
  const [error, setError] = useState('');
  function downloadSaved() {
    try {
      const store = loadDraftTree();
      if (store) downloadTreeJson(store, loadGuide() ?? defaultGuide());
      else {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) downloadText(raw, 'sejire-draft-recovery.json');
        else setError(t.empty);
      }
    } catch { setError(t.unavailable); }
  }
  const owned = access.state.status === 'owned';
  const attention = Boolean(draft.pending || draft.failed || ['blocked', 'unavailable', 'conflict'].includes(access.state.status));
  return <aside className="independent-notice draft-access-notice" aria-label={locale === 'ru' ? 'Доступ к черновику' : locale === 'kk' ? 'Жобаға қолжетімділік' : 'Draft access'}>
    <p role={attention ? 'alert' : undefined} aria-live={attention ? undefined : 'polite'}>
      {draft.pending ? t.unsaved : draft.failed ? t.failed : t[access.state.status]}
    </p>
    <div className="actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
      {owned && <button type="button" className="btn ghost" disabled={Boolean(draft.pending)} onClick={access.release}>{t.release}</button>}
      {!owned && access.state.status !== 'checking' && <button type="button" className="btn" onClick={() => void access.request()}>{t.retry}</button>}
      {(!owned || draft.pending || draft.failed) && <button type="button" className="btn ghost" onClick={downloadSaved}>{t.download}</button>}
      {draft.pending && <>
        <button type="button" className="btn" onClick={() => {
          try { downloadTreeJson(draft.pending!.store, draft.pending!.guide); } catch { setError(t.unavailable); }
        }}>{t.mine}</button>
        {owned && draft.pending.token === access.token && <button type="button" className="btn ghost" onClick={draft.retrySave}>{t.save}</button>}
        {owned && draft.pending.token !== access.token && <button type="button" className="btn ghost" onClick={() => { if (window.confirm(t.discard)) draft.loadSaved(); }}>{t.latest}</button>}
      </>}
      {(!draft.ready || draft.pending) && <button type="button" className="btn ghost" onClick={onHome}>{t.home}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
