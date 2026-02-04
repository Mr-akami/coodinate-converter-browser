let _nextId = 0;

function rpc(worker, msg) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', handler);
      if (e.data.type === 'error') {
        reject(new Error(e.data.error));
      } else {
        resolve(e.data);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...msg, id });
  });
}

export function createProjApi(worker) {
  if (!worker) throw new Error('worker is required');

  async function transform(src, dst, x, y, z = 0) {
    if (!src || !dst) throw new Error('src and dst are required');
    const res = await rpc(worker, { type: 'transform', src, dst, x, y, z });
    return { x: res.x, y: res.y, z: res.z };
  }

  return { transform };
}
