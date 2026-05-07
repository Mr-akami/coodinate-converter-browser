/*
 * Spawns a dedicated worker that downloads proj.db (manifest-driven) into
 * OPFS, verifies sha256, and reports progress. Resolves with the manifest
 * the server returned, so callers can use it for grid hash verification.
 */
export function ensureProjData({ manifestUrl, projDbUrlPattern, dirName = 'proj-data', onProgress } = {}) {
  if (!manifestUrl) return Promise.reject(new Error('manifestUrl is required'));
  if (!projDbUrlPattern) return Promise.reject(new Error('projDbUrlPattern is required'));

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./proj-data-worker.js', import.meta.url),
      { type: 'module' },
    );

    const cleanup = () => worker.terminate();

    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      if (msg.type === 'progress') {
        if (onProgress) onProgress(msg);
        return;
      }
      if (msg.type === 'ready') {
        cleanup();
        resolve(msg);
        return;
      }
      if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.error || 'install failed'));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(err);
    };

    worker.postMessage({ type: 'install', manifestUrl, projDbUrlPattern, dirName });
  });
}
