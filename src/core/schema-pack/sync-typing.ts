/**
 * The active pack a connector sync types its pages with, mirroring performSyncInner: its page types, or undefined
 * for the legacy prefix typing when no pack resolves. Ours (governedwork fork): an unreadable brain-resident pack store
 * is not "no pack" (db-store.ts isPackStoreFailure), so that failure is thrown instead of typing the pages without it.
 * One definition for the GitHub and Google syncs (runGitHubSyncInner, runGoogleSyncInner). Imports stay lazy, as the
 * syncs had them.
 */
export async function syncTypingPack(sourceId: string): Promise<{ page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined> {
  try {
    const { loadActivePack } = await import('./load-active.ts');
    const { loadConfig } = await import('../config.ts');
    const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
    return { page_types: resolved.manifest.page_types };
  } catch (err) {
    if ((await import('./db-store.ts')).isPackStoreFailure(err)) throw err;
    return undefined;
  }
}
