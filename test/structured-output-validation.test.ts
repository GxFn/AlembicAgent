import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProvider, type StructuredOutputOptions } from '../src/ai/AiProvider.js';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import {
  parseSchemaOutput,
  prepareStructuredValidation,
} from '../src/ai/shared/schemaValidation.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { mockJsonFetch } from './helpers/mockFetch.js';

const config = { apiKey: 'test-key', model: 'gpt-4o', maxRetries: 0 };
const entries = [
  {
    name: 'provider',
    call: (opts: StructuredOutputOptions) =>
      new OpenAiProvider(config).chatWithStructuredOutput('json', opts),
  },
  {
    name: 'base provider',
    call: (opts: StructuredOutputOptions) =>
      AiProvider.prototype.chatWithStructuredOutput.call(new OpenAiProvider(config), 'json', opts),
  },
  {
    name: 'gateway',
    call: (opts: StructuredOutputOptions) =>
      new LLMGateway({ providers: { openai: config }, maxRetries: 0 }).chatStructured({
        modelRef: 'openai:gpt-4o',
        prompt: 'json',
        ...opts,
      }),
  },
  {
    name: 'transport',
    call: (opts: StructuredOutputOptions) =>
      new OpenAiTransport(config).chatStructured({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'json' }],
        ...opts,
      }),
  },
];

function response(value: unknown) {
  return mockJsonFetch(
    {},
    {
      id: 'chat-fixture',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(value) },
          finish_reason: 'stop',
        },
      ],
    }
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('structured validator diagnostic boundary', () => {
  it.each([
    { name: 'valid fenced JSON', text: '```json\n{"ok":true}\n```', expected: { ok: true } },
    { name: 'schema mismatch', text: '{"wrong":true}', expected: null },
    { name: 'invalid JSON', text: '{"ok":', expected: null },
  ])('preserves $name classification when its diagnostic callback throws', ({ text, expected }) => {
    const log = vi.fn(() => {
      throw new Error('fixture log failure');
    });
    const validate = prepareStructuredValidation(
      {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      log
    );
    if (!validate) {
      throw new Error('Fixture schema did not compile');
    }
    expect(parseSchemaOutput(text, validate, log)).toEqual(expected);
    expect(log).toHaveBeenCalled();
  });

  it('rejects an invalid schema even when diagnostic logging throws', () => {
    const log = vi.fn(() => {
      throw new Error('fixture log failure');
    });
    expect(prepareStructuredValidation({ type: 'object', unknownKeyword: true }, log)).toBeNull();
    expect(log).toHaveBeenCalled();
  });
});

describe.each(entries)('structured output at $name', ({ call }) => {
  it('rejects parseable JSON that violates the caller schema', async () => {
    response({ wrong: true });
    await expect(
      call({
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
      })
    ).resolves.toBeNull();
  });

  it('validates nested constraints and local references without altering data', async () => {
    const value = { values: [{ label: 'kept', kind: 'b' }] };
    response(value);
    await expect(
      call({
        schema: {
          type: 'object',
          required: ['values'],
          additionalProperties: false,
          properties: { values: { type: 'array', minItems: 1, items: { $ref: '#/$defs/item' } } },
          $defs: {
            item: {
              type: 'object',
              required: ['label', 'kind'],
              additionalProperties: false,
              properties: { label: { type: 'string', minLength: 1 }, kind: { enum: ['a', 'b'] } },
            },
          },
        },
      })
    ).resolves.toEqual(value);
  });

  it.each([
    {
      value: { count: '1' },
      schema: { type: 'object', properties: { count: { type: 'number' } } },
    },
    {
      value: {},
      schema: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'number', default: 1 } },
      },
    },
    {
      value: { extra: true },
      schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    { value: 'not-an-email', schema: { type: 'string', format: 'email' } },
    { value: { result: 'both' }, schema: { oneOf: [{ type: 'object' }, { type: 'object' }] } },
  ])('rejects invalid data without coercion, defaults or property removal %#', async ({
    value,
    schema,
  }) => {
    response(value);
    await expect(call({ schema })).resolves.toBeNull();
  });

  it.each([
    { type: 'object', unknownKeyword: true },
    { $schema: 'https://example.invalid/unsupported-schema', type: 'object' },
    { $ref: 'https://example.invalid/remote-schema' },
    { $async: true, type: 'object' },
  ])('rejects an unsupported schema before network dispatch %#', async (schema) => {
    const fetchMock = response({});
    await expect(call({ schema })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports an explicit 2020-12 schema', async () => {
    response({ tuple: ['ok', 2] });
    await expect(
      call({
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            tuple: {
              type: 'array',
              prefixItems: [{ type: 'string' }, { type: 'number' }],
              items: false,
            },
          },
        },
      })
    ).resolves.toEqual({ tuple: ['ok', 2] });
  });

  it('does not share schema ids or stale mutable schemas between calls', async () => {
    const schema = { $id: 'https://example.invalid/result', type: 'string', minLength: 1 };
    response('ok');
    await expect(call({ schema })).resolves.toBe('ok');
    schema.minLength = 5;
    await expect(call({ schema })).resolves.toBeNull();
  });
});
