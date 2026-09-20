import { vi } from 'vitest';

interface JsonFetchCapture {
  url?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** 只共用 HTTP 捕获装配；厂商响应和协议断言仍由各测试明确提供。清理由原 describe hook 负责。 */
export function mockJsonFetch(capture: JsonFetchCapture, response: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    capture.headers = (init?.headers || {}) as Record<string, string>;
    return {
      ok: true,
      json: async () => response,
      text: async () => '',
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
