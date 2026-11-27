import { useEffect, useState } from 'react';
import { Welcome } from './components/Welcome.independent';
import { Workspace } from './components/Workspace';
import { RestoreSeed } from './components/RestoreSeed.independent';
import { DirectSaveHistory } from './components/DirectSaveHistory';
import { IndependentProtocol } from './components/Protocol.independent';
import { DraftAccessNotice, useDraftAccess, useDraftDocument } from './components/DraftAccess';
import type { TreeStore } from './lib/types';
import { loadDraftTree } from './lib/draftStorage';
import { defaultGuide, loadGuide, startGuidedTree, type GuideState } from './lib/guide';
import { readLastScreen, rememberScreen, shouldResumeDraft } from './lib/lastScreen';

type Screen = 'welcome' | 'work' | 'restore' | 'saving' | 'protocol';
function isProtocolRoute(hash: string) {
  return /^#\/(?:protocol|admin|fund-admin)(?:[/?]|$)/.test(hash);
}
function bootApp(): { screen: Screen; store: TreeStore | null; guide: GuideState } {
  if (isProtocolRoute(location.hash)) return { screen: 'protocol', store: loadDraftTree(), guide: loadGuide() ?? defaultGuide() };
  if (location.hash.startsWith('#/restore')) return { screen: 'restore', store: null, guide: defaultGuide() };
  if (location.hash.startsWith('#/save')) return { screen: 'saving', store: loadDraftTree(), guide: loadGuide() ?? defaultGuide() };
  const draft = loadDraftTree();
  return shouldResumeDraft(readLastScreen(), Boolean(draft)) && draft
    ? { screen: 'work', store: draft, guide: loadGuide() ?? { ...defaultGuide(), step: 'done' } }
    : { screen: 'welcome', store: null, guide: defaultGuide() };
}

export default function App() {
  const [boot] = useState(() => ({ ...bootApp(), hash: location.hash }));
  const [screen, setScreen] = useState<Screen>(boot.screen);
  const access = useDraftAccess();
  const draft = useDraftDocument(access, boot);
  const { store, guide } = draft;

  function go(next: Screen) {
    history.replaceState(null, '', location.pathname + location.search + (next === 'restore' ? '#/restore' : next === 'saving' ? '#/save' : next === 'protocol' ? '#/protocol' : ''));
    rememberScreen(next === 'saving' || next === 'protocol' ? 'welcome' : next);
    setScreen(next);
  }
  useEffect(() => {
    const changed = () => {
      if (isProtocolRoute(location.hash)) setScreen('protocol');
      else if (location.hash.startsWith('#/restore')) setScreen('restore');
      else if (location.hash.startsWith('#/save')) setScreen('saving');
      else setScreen('welcome');
    };
    window.addEventListener('hashchange', changed);
    // A fragment navigation can happen after the initial render but before
    // this passive effect subscribes. Reconcile only a changed fragment so an
    // unchanged empty URL still resumes the editor selected by bootApp().
    if (location.hash !== boot.hash) changed();
    return () => window.removeEventListener('hashchange', changed);
  }, [boot.hash]);
  function startNew(title: string) {
    const next = startGuidedTree(title);
    if (draft.replace(next.store, next.guide)) go('work');
  }
  function continueDraft() {
    if (!draft.pending && loadDraftTree() && draft.loadSaved()) go('work');
  }
  return <div className={screen === 'work' ? 'app-shell is-work' : 'app-shell'}>
    <DraftAccessNotice access={access} document={draft} onHome={() => go('welcome')} />
    {screen === 'welcome' && <Welcome onStartNew={startNew} onContinueDraft={continueDraft}
      onRestoreSeed={() => go('restore')} onHistory={() => go('saving')} onProtocol={() => go('protocol')} draftWritable={draft.ready && !draft.pending} />}
    {screen === 'protocol' && <IndependentProtocol onHome={() => go('welcome')} onRestore={() => go('restore')} canRestore={draft.ready && !draft.pending} />}
    {screen === 'saving' && <main className="landing"><DirectSaveHistory onBack={() => go(store ? 'work' : 'welcome')} /></main>}
    {screen === 'restore' && draft.ready && !draft.pending && <RestoreSeed key={access.token?.epoch} onBack={() => go('welcome')} onRestored={continueDraft} />}
    {screen === 'work' && store && draft.ready && <Workspace key={access.token?.epoch} store={store} guide={guide}
      onStoreChange={next => draft.updateStore(next, store.meta.id)} onGuideChange={next => draft.updateGuide(next, store.meta.id)}
      onDraftReplace={draft.replace} onDraftReload={draft.loadSaved} onHome={() => go('welcome')} />}
  </div>;
}
