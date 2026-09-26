/*
 * Route-table fetch stand-in. Routes are functions so a route can fail, and so
 * each call produces a fresh Response (a body can only be consumed once).
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

interface FakeFetch {
  fetchImpl: FetchImpl;
  readonly calls: FetchCall[];
  urls(): string[];
}

export function createFakeFetch(routes: Record<string, () => Response | Promise<Response>>): FakeFetch {
  const calls: FetchCall[] = [];

  return {
    calls,

    fetchImpl: async (url, init) => {
      const key = String(url);
      calls.push({ url: key, init });
      const route = routes[key];
      if (!route) throw new TypeError(`fake fetch: no route for ${key}`);
      return await route();
    },

    urls() {
      return calls.map((call) => call.url);
    },
  };
}

export function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(new TextEncoder().encode(body).length),
    },
  });
}

export function bytesResponse(bytes: Uint8Array, chunkSize = 16): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Length': String(bytes.length) },
  });
}

export function statusResponse(status: number): Response {
  return new Response('unavailable', { status });
}

interface DeferredResponse {
  response: Response;
  push(chunk: Uint8Array): void;
  close(): void;
}

/** A response whose body is fed by the test, so a download can be held open. */
export function deferredBytesResponse(contentLength: number): DeferredResponse {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Length': String(contentLength) },
    }),
    push(chunk) {
      controller.enqueue(chunk);
    },
    close() {
      controller.close();
    },
  };
}
