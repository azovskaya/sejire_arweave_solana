import { LocalTreeProcess } from "./treeProcess";
import { isErrorReply } from "./types";
import type { TreeStore } from "../types";

const AUTHOR = "local:draft-author";

type Mirror = {
  process: LocalTreeProcess;
  processId: string;
  mirroredVersions: Set<number>;
};

const mirrors = new Map<string, Mirror>();

export function resetProtocolMirrors(): void {
  mirrors.clear();
}

export function getMirroredProcessId(treeId: string): string | undefined {
  return mirrors.get(treeId)?.processId;
}

/**
 * Локальное вычисление истории редактора, без сетевого клиента или endpoint.
 * Долговременный архив записывается отдельно прямой транзакцией Arweave.
 * Id коммитов процесса ≠ id коммитов редактора — parent_commit_id не передаём.
 */
export async function mirrorStoreToProtocol(
  store: TreeStore
): Promise<{ process: LocalTreeProcess; processId: string }> {
  let m = mirrors.get(store.meta.id);
  if (!m) {
    const processId = `tree_mirror_${store.meta.id}`;
    const process = new LocalTreeProcess(processId);
    const init = process.handle({ From: AUTHOR, Tags: { Action: "Init", Title: store.meta.title } });
    if (isErrorReply(init)) throw new Error(init.Data || "Init failed");
    m = { process, processId, mirroredVersions: new Set() };
    mirrors.set(store.meta.id, m);
  }

  const versions = Object.keys(store.versions)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  for (const version of versions) {
    if (m.mirroredVersions.has(version)) continue;
    const editorCommitId = store.versions[version];
    const commit = store.commits[editorCommitId];
    if (!commit) continue;
    const res = m.process.handle({
      From: AUTHOR,
      Tags: { Action: "Commit" },
      Data: JSON.stringify({ message: commit.message, snapshot: commit.snapshot }),
    });
    if (isErrorReply(res)) throw new Error(res.Data || "Commit failed");
    m.mirroredVersions.add(version);
  }

  return { process: m.process, processId: m.processId };
}
