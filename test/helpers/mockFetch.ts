import { vi } from 'vitest';

interface JsonFetchCapture {
  url?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** 使用真实 Response，同时覆盖 fetch headers/body 消费协议。 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Responses HTTP 返回原生 output 数组；output_text 是部分客户端的派生便利字段。 */
export function responsesText(text: string) {
  return {
    type: 'message',
    id: 'message-fixture',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

/** 只共用 HTTP 捕获装配；厂商响应和协议断言仍由各测试明确提供。清理由原 describe hook 负责。 */
export function mockJsonFetch(capture: JsonFetchCapture, response: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    capture.headers = (init?.headers || {}) as Record<string, string>;
    return jsonResponse(response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
