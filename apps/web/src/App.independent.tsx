import { useEffect, useState } from 'react';
import { Welcome } from './components/Welcome.independent';
import { Workspace } from './components/Workspace';
import { RestoreSeed } from './components/RestoreSeed.independent';
import { DirectSaveHistory } from './components/DirectSaveHistory';
import type { TreeStore } from './lib/types';
import { clearDraftTree, loadDraftTree, saveDraftTree } from './lib/draftStorage';
import { coerceTreeStore } from './lib/treeJson';
import { clearGuide, defaultGuide, loadGuide, saveGuide, startGuidedTree, type GuideState } from './lib/guide';
import { readLastScreen, rememberScreen, shouldResumeDraft } from './lib/lastScreen';

type Screen = 'welcome' | 'work' | 'restore' | 'saving';
function bootApp(): { screen: Screen; store: TreeStore | null; guide: GuideState } {
  if (location.hash.startsWith('#/restore')) return { screen: 'restore', store: null, guide: defaultGuide() };
  if (location.hash.startsWith('#/save')) return { screen: 'saving', store: loadDraftTree(), guide: loadGuide() ?? defaultGuide() };
  const draft = loadDraftTree();
  return shouldResumeDraft(readLastScreen(), Boolean(draft)) && draft
    ? { screen: 'work', store: draft, guide: loadGuide() ?? { ...defaultGuide(), step: 'done' } }
    : { screen: 'welcome', store: null, guide: defaultGuide() };
}

export default function App() {
  const [boot] = useState(bootApp);
  const [screen, setScreen] = useState<Screen>(boot.screen);
  const [store, setStore] = useState<TreeStore | null>(boot.store);
  const [guide, setGuide] = useState<GuideState>(boot.guide);

  function go(next: Screen) {
    history.replaceState(null, '', location.pathname + location.search + (next === 'restore' ? '#/restore' : next === 'saving' ? '#/save' : ''));
    rememberScreen(next === 'saving' ? 'welcome' : next);
    setScreen(next);
  }
  useEffect(() => {
    const changed = () => {
      if (location.hash.startsWith('#/restore')) setScreen('restore');
      else if (location.hash.startsWith('#/save')) setScreen('saving');
      else setScreen('welcome');
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  function startNew(title: string) {
    clearDraftTree(); clearGuide();
    const next = startGuidedTree(title);
    saveDraftTree(next.store); saveGuide(next.guide);
    setStore(next.store); setGuide(next.guide); go('work');
  }
  function continueDraft(opened?: TreeStore | null) {
    const draft = coerceTreeStore(opened) ?? loadDraftTree();
    if (!draft) return;
    saveDraftTree(draft); setStore(draft);
    setGuide(loadGuide() ?? { ...defaultGuide(), step: 'done' }); go('work');
  }
  return <div className={screen === 'work' ? 'app-shell is-work' : 'app-shell'}>
    {screen === 'welcome' && <Welcome onStartNew={startNew} onContinueDraft={continueDraft}
      onRestoreSeed={() => go('restore')} onHistory={() => go('saving')} />}
    {screen === 'saving' && <main className="landing"><DirectSaveHistory onBack={() => go(store ? 'work' : 'welcome')} /></main>}
    {screen === 'restore' && <RestoreSeed onBack={() => go('welcome')} onRestored={continueDraft} />}
    {screen === 'work' && store && <Workspace store={store} guide={guide}
      onStoreChange={next => setStore(previous => previous ? coerceTreeStore(typeof next === 'function' ? next(previous) : next) ?? previous : previous)}
      onGuideChange={setGuide} onHome={() => go('welcome')} />}
  </div>;
}
