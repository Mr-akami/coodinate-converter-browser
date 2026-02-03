export function ensureProjData({
  url,
  version,
  dirName = 'proj-data',
  onProgress,
} = {}) {
  if (!url) {
    return Promise.reject(new Error('url is required'));
  }
  if (!version) {
    return Promise.reject(new Error('version is required'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./proj-data-worker.js', import.meta.url),
      { type: 'module' }
    );

    const cleanup = () => {
      worker.terminate();
    };

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

    worker.postMessage({ type: 'install', url, version, dirName });
  });
}
