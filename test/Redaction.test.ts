/**
 * redactDeveloperText 迁出钉（Wave A E1）——自 AgentRuntime 私有函数迁至 utils/Redaction，
 * 行为必须字节不变：四类规则逐条钉住。样本均为显式假密钥（仅满足正则形态，非真实凭据）。
 */
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';

describe('redactDeveloperText（E1 迁出行为钉）', () => {
  test('OpenAI 形态 key 打码', () => {
    // sk- 规则先于键值对规则执行；'key' 不含 api 前缀故不触发第四条规则
    expect(redactDeveloperText('key=sk-xxxxxxxxxxxxxxxx end')).toBe('key=[redacted-api-key] end');
    expect(redactDeveloperText('sk-proj-xxxxxxxxxxxxxxxx')).toBe('[redacted-api-key]');
  });

  test('Google 形态 key 打码', () => {
    expect(redactDeveloperText('AIzaxxxxxxxxxxxxxxxxxxxx')).toBe('[redacted-google-api-key]');
  });

  test('Bearer token 打码保留前缀', () => {
    expect(redactDeveloperText('Authorization: Bearer abcdefghijkl')).toBe(
      'Authorization: Bearer [redacted-token]'
    );
  });

  test('键值对形态 secret 打码保留键名', () => {
    expect(redactDeveloperText('api_key: verysecretvalue')).toBe('api_key: [redacted]');
    expect(redactDeveloperText('password=hunter2hunter2')).toBe('password=[redacted]');
  });

  test('普通文本原样通过', () => {
    const text = '类型导入使用 import type 严格隔离：lib/types/graph-shared.ts:1-3';
    expect(redactDeveloperText(text)).toBe(text);
  });
});
