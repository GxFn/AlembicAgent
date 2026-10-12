import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { buildAnalystPrompt } from '../src/agent/prompts/index.js';
import type { LlmContinuation, UnifiedMessage } from '../src/ai/contracts.js';
import {
  inspectDeepSeekTextToolCalls,
  parseDeepSeekTextToolCalls,
} from '../src/ai/deepseekToolCallCompat.js';
import { isTextCompatToolCallId } from '../src/ai/registry/ModelQuirks.js';
import { normalizeToolTranscriptForChatCompletions } from '../src/ai/toolTranscript.js';
import { DeepSeekTransport } from '../src/ai/transport/DeepSeekTransport.js';
import {
  DeltaCache,
  TOOL_REGISTRY,
  type ToolContext,
  ToolRouter,
} from '../src/tools/runtime/index.js';
import { mockJsonFetch } from './helpers/mockFetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deepSeekReply(content: string, finishReason = 'stop') {
  return {
    id: 'fixture',
    created: 1,
    model: 'deepseek-v4-pro',
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: 'assistant', content, reasoning_content: 'fixture' },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const codeInvoke =
  '<invoke name="code"><parameter name="action">read</parameter><parameter name="params">{"path":"declared.ts"}</parameter></invoke>';
const codeTool = {
  name: 'code',
  parameters: {
    type: 'object',
    required: ['action', 'params'],
    properties: {
      action: { type: 'string', enum: ['read'] },
      params: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    },
  },
};

describe('DeepSeek text tool declaration boundary', () => {
  it('emits call ids that AgentRuntime recognises as text-compat (shared prefix constant)', () => {
    const calls = parseDeepSeekTextToolCalls(
      `<function_calls>${codeInvoke}${codeInvoke}</function_calls>`,
      ['code']
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(isTextCompatToolCallId(call.id), call.id).toBe(true);
    }
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });

  it.each([
    { name: 'invoke before declaration', text: `${codeInvoke}\n<function_calls></function_calls>` },
    { name: 'invoke after declaration', text: `<function_calls></function_calls>\n${codeInvoke}` },
    {
      name: 'fenced example',
      text: `\`\`\`xml\n<function_calls>${codeInvoke}</function_calls>\n\`\`\``,
    },
    {
      name: 'unclosed fenced example',
      text: `\`\`\`xml\n<function_calls>${codeInvoke}</function_calls>`,
    },
    { name: 'unclosed declaration', text: `<function_calls>${codeInvoke}` },
  ])('keeps $name as text through the real transport', async ({ text }) => {
    const fetch = mockJsonFetch({}, deepSeekReply(text));
    const result = await new DeepSeekTransport({ apiKey: 'fixture-key' }).chatWithTools({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'fixture' }],
      tools: [codeTool],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.functionCalls).toBeNull();
    expect(result.text).toBe(text);
  });

  it('keeps a real declared call while ignoring surrounding invoke examples', async () => {
    const outside = codeInvoke.replace('declared.ts', 'example.ts');
    const text = `Explanation: ${outside}\n<function_calls>${codeInvoke}</function_calls>\nMore explanation: ${outside}`;
    mockJsonFetch({}, deepSeekReply(text));
    const result = await new DeepSeekTransport({ apiKey: 'fixture-key' }).chatWithTools({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'fixture' }],
      tools: [codeTool],
    });
    expect(result.functionCalls).toEqual([
      {
        id: 'call_deepseek_compat_1',
        name: 'code',
        args: { action: 'read', params: { path: 'declared.ts' } },
      },
    ]);
    expect(result.text).toBeNull();
  });

  it('preserves fenced code and line endings inside declared arguments', async () => {
    const snippet = '```ts\r\nconst fixture = 1;\r\n```';
    const invoke = codeInvoke.replace(
      '</invoke>',
      `<parameter name="snippet">${snippet}</parameter></invoke>`
    );
    mockJsonFetch({}, deepSeekReply(`<function_calls>${invoke}</function_calls>`));
    const result = await new DeepSeekTransport({ apiKey: 'fixture-key' }).chatWithTools({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'fixture' }],
      tools: [codeTool],
    });
    expect(result.functionCalls?.[0].args.snippet).toBe(snippet);
  });
});

const readFileInvoke = codeInvoke.replace('name="code"', 'name="read_file"');

/** 经真实 DeepSeekTransport 走一遍兼容桥，收集丢弃诊断告警；fetch 由 mockJsonFetch 截获。 */
async function runCompatTranslation(text: string, finishReason = 'stop') {
  const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
  mockJsonFetch({}, deepSeekReply(text, finishReason));
  const result = await new DeepSeekTransport({ apiKey: 'fixture-key' }).chatWithTools({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'fixture' }],
    tools: [codeTool],
  });
  const dropWarnings = warn.mock.calls
    .map(([entry]) => String(entry))
    .filter((entry) => entry.includes('compatibility_text_tool_calls_dropped'));
  return { result, dropWarnings };
}

describe('DeepSeek text tool compat drop diagnostics', () => {
  it('reports unknown tool names from the parser without changing the dropped result', () => {
    const text = `<function_calls>${readFileInvoke}</function_calls>`;
    expect(parseDeepSeekTextToolCalls(text, ['code'])).toEqual([]);
    expect(inspectDeepSeekTextToolCalls(text, ['code'])).toEqual({
      calls: [],
      diagnostics: {
        declaredBlocks: 1,
        droppedUnknownNames: ['read_file'],
        unclosedBlock: false,
        nestedBlocksSkipped: 0,
      },
    });
  });

  it('warns with dropped names and finishReason but never the argument body', async () => {
    const text = `<function_calls>${readFileInvoke}</function_calls>`;
    const { result, dropWarnings } = await runCompatTranslation(text);
    // 有意行为不变：未知工具名不转译，文本原样作为模型输出返回。
    expect(result.functionCalls).toBeNull();
    expect(result.text).toBe(text);
    expect(dropWarnings).toHaveLength(1);
    const [warning] = dropWarnings;
    expect(warning).toContain('reasons=unknown_tool_name');
    expect(warning).toContain('path=text_kept');
    expect(warning).toContain('translated=0');
    expect(warning).toContain('droppedUnknownNames=["read_file"]');
    expect(warning).toContain('finishReason=stop');
    expect(warning).not.toContain('declared.ts');
    expect(warning).not.toContain('<parameter');
  });

  it('warns unclosedBlock when the declaration is cut off by the output budget', async () => {
    const text = `<function_calls>${codeInvoke}`;
    expect(inspectDeepSeekTextToolCalls(text, ['code']).diagnostics).toEqual({
      declaredBlocks: 0,
      droppedUnknownNames: [],
      unclosedBlock: true,
      nestedBlocksSkipped: 0,
    });
    const { result, dropWarnings } = await runCompatTranslation(text, 'length');
    expect(result.functionCalls).toBeNull();
    expect(result.text).toBe(text);
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]).toContain('reasons=unclosed_block');
    expect(dropWarnings[0]).toContain('unclosedBlock=true');
    expect(dropWarnings[0]).toContain('finishReason=length');
    expect(dropWarnings[0]).not.toContain('declared.ts');
  });

  it('warns nestedBlocksSkipped when a declaration contains another declaration', async () => {
    const text = `<function_calls><function_calls>${codeInvoke}</function_calls></function_calls>`;
    expect(inspectDeepSeekTextToolCalls(text, ['code']).diagnostics).toMatchObject({
      declaredBlocks: 0,
      unclosedBlock: false,
      nestedBlocksSkipped: 1,
    });
    const { result, dropWarnings } = await runCompatTranslation(text);
    expect(result.functionCalls).toBeNull();
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]).toContain('reasons=nested_block_skipped');
    expect(dropWarnings[0]).toContain('nestedBlocksSkipped=1');
  });

  it('warns partial translation when a known call is kept and an unknown one dropped', async () => {
    const text = `<function_calls>${codeInvoke}${readFileInvoke}</function_calls>`;
    const { result, dropWarnings } = await runCompatTranslation(text);
    expect(result.functionCalls).toEqual([
      {
        id: 'call_deepseek_compat_1',
        name: 'code',
        args: { action: 'read', params: { path: 'declared.ts' } },
      },
    ]);
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]).toContain('path=partial_translation');
    expect(dropWarnings[0]).toContain('translated=1');
    expect(dropWarnings[0]).toContain('droppedUnknownNames=["read_file"]');
  });

  it.each([
    {
      name: 'invoke before declaration',
      text: `${codeInvoke}\n<function_calls></function_calls>`,
      reason: 'no_parsable_invoke',
    },
    {
      name: 'invoke after declaration',
      text: `<function_calls></function_calls>\n${codeInvoke}`,
      reason: 'no_parsable_invoke',
    },
    {
      name: 'fenced example',
      text: `\`\`\`xml\n<function_calls>${codeInvoke}</function_calls>\n\`\`\``,
      reason: 'no_declared_block',
    },
    {
      name: 'unclosed fenced example',
      text: `\`\`\`xml\n<function_calls>${codeInvoke}</function_calls>`,
      reason: 'no_declared_block',
    },
  ])('keeps $name as text and records reason $reason', async ({ text, reason }) => {
    const { result, dropWarnings } = await runCompatTranslation(text);
    expect(result.functionCalls).toBeNull();
    expect(result.text).toBe(text);
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]).toContain(`reasons=${reason}`);
    expect(dropWarnings[0]).toContain('path=text_kept');
  });

  it('diagnoses an inline mention that swallows a later declaration (translation unchanged)', async () => {
    // 行内反引号提及打开了外层块，使后续合法声明被判为嵌套；是否把行内提及视为样例属于
    // 正确性变化，需单独评审，本包只保证这种丢弃可被诊断。
    const text = `I will use the \`<function_calls>\` syntax now.\n<function_calls>${codeInvoke}</function_calls>`;
    const { result, dropWarnings } = await runCompatTranslation(text);
    expect(result.functionCalls).toBeNull();
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]).toContain('unclosedBlock=true');
  });

  it.each([
    {
      name: 'a fully translated declaration',
      text: `<function_calls>${codeInvoke}</function_calls>`,
    },
    { name: 'plain text without declarations', text: 'done' },
  ])('does not warn about drops for $name', async ({ text }) => {
    const { dropWarnings } = await runCompatTranslation(text);
    expect(dropWarnings).toEqual([]);
  });
});

describe('tool transcript continuation cleanup', () => {
  const continuation: LlmContinuation = {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    connection: 'fixture-connection',
    projectionHash: 'fixture-hash',
    kind: 'content-replay-v1',
    parts: [
      { type: 'reasoning', text: 'retained thought' },
      { type: 'tool-call', id: 'first' },
      { type: 'tool-call', id: 'second' },
    ],
  };

  function roundWith(replies: string[]): UnifiedMessage[] {
    return [
      {
        role: 'assistant',
        content: null,
        reasoningContent: 'retained thought',
        continuation,
        toolCalls: ['first', 'second'].map((id) => ({
          id,
          name: 'code',
          args: { action: 'read', params: { path: 'fixture.ts' } },
        })),
      },
      ...replies.map(
        (id): UnifiedMessage => ({
          role: 'tool',
          name: 'code',
          toolCallId: id,
          content: 'observed result',
        })
      ),
      { role: 'user', content: 'continue' },
    ];
  }

  it('drops the native continuation when an incomplete round is converted to text', () => {
    const normalized = normalizeToolTranscriptForChatCompletions(
      roundWith(['first']).map((message) => ({ ...message }))
    );
    expect(normalized.normalizedCount).toBe(2);
    expect(normalized.droppedContinuationCount).toBe(1);
    expect(normalized.messages[0]?.content).toContain('tool calls converted to text');
    expect(normalized.messages[0]).not.toHaveProperty('continuation');
  });

  it('keeps the native continuation on complete rounds', () => {
    const normalized = normalizeToolTranscriptForChatCompletions(
      roundWith(['first', 'second']).map((message) => ({ ...message }))
    );
    expect(normalized.normalizedCount).toBe(0);
    expect(normalized.droppedContinuationCount).toBe(0);
    expect(normalized.messages[0]?.continuation).toEqual(continuation);
  });

  it('stops misattributed continuation_filtered warnings for converted rounds', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const capture: { body?: Record<string, unknown> } = {};
    mockJsonFetch(capture, deepSeekReply('done'));
    const result = await new DeepSeekTransport({ apiKey: 'fixture-key' }).chatWithTools({
      model: 'deepseek-v4-pro',
      messages: roundWith(['first']),
      tools: [codeTool],
    });
    expect(result.text).toBe('done');
    const warnings = warn.mock.calls.map(([entry]) => String(entry));
    expect(warnings.filter((entry) => entry.includes('continuation_filtered'))).toEqual([]);
    const transcriptWarning = warnings.find((entry) =>
      entry.includes('incomplete tool transcript messages')
    );
    expect(transcriptWarning).toContain('normalized 2');
    expect(transcriptWarning).toContain('droppedContinuations=1');
    const sent = capture.body?.messages as Array<Record<string, unknown>>;
    expect(sent.find((message) => message.role === 'assistant')?.tool_calls).toBeUndefined();
  });
});

describe('DeepSeek tool history completeness', () => {
  it.each([
    { name: 'duplicate call ids', ids: ['first', 'first'], replies: ['first'], converted: true },
    { name: 'empty call id', ids: ['first', ''], replies: ['first'], converted: true },
    {
      name: 'complete distinct calls',
      ids: ['first', 'second'],
      replies: ['first', 'second'],
      converted: false,
    },
  ])('handles $name without fabricating a missing receipt', async ({ ids, replies, converted }) => {
    const messages: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: null,
        reasoningContent: 'retained thought',
        toolCalls: ids.map((id) => ({
          id,
          name: 'code',
          args: { action: 'read', params: { path: 'fixture.ts' } },
        })),
      },
      ...replies.map(
        (id): UnifiedMessage => ({
          role: 'tool',
          name: 'code',
          toolCallId: id,
          content: 'observed result',
        })
      ),
      { role: 'user', content: 'continue' },
    ];
    const normalized = normalizeToolTranscriptForChatCompletions(
      messages.map((message) => ({ ...message }))
    );
    const capture: { body?: Record<string, unknown> } = {};
    const fetch = mockJsonFetch(capture, deepSeekReply('done'));
    const result = await new DeepSeekTransport({ apiKey: 'fixture-key' }).chatWithTools({
      model: 'deepseek-v4-pro',
      messages,
      tools: [codeTool],
    });
    expect(result.text).toBe('done');
    expect(fetch).toHaveBeenCalledOnce();
    const sent = capture.body?.messages as Array<Record<string, unknown>>;
    const assistant = sent.find((message) => message.role === 'assistant');
    expect(sent.filter((message) => message.role === 'tool')).toHaveLength(
      converted ? 0 : replies.length
    );
    if (converted) {
      expect(assistant?.tool_calls).toBeUndefined();
      expect(normalized.messages[0]).not.toHaveProperty('reasoningContent');
      // SDK 为普通 assistant 补空 reasoning_content 是合法 wire 默认；旧思维正文不能回放。
      expect(assistant?.reasoning_content ?? '').toBe('');
      expect(assistant?.content).toContain('tool calls converted to text');
      expect(
        sent.filter((message) => String(message.content).includes('tool result converted to text'))
      ).toHaveLength(replies.length);
    } else {
      expect(assistant?.tool_calls).toHaveLength(ids.length);
      expect(assistant?.reasoning_content).toBe('retained thought');
    }
    expect(normalized.normalizedCount).toBe(converted ? 1 + replies.length : 0);
  });
});

interface BatchReadFile {
  ok: boolean;
  path: string;
  content?: string;
  error?: string;
  truncated?: boolean;
  originalTokensEstimate?: number;
}

interface BatchReadData {
  mode: 'batch';
  files: BatchReadFile[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    partialFailure: boolean;
    maxFiles: number;
    maxOutputTokens: number;
    perFileTokenBudget: number;
  };
}

async function withCodeFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'alembic-agent-llm-input-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\nexport const aa = 2;\n');
    await writeFile(join(root, 'src/b.ts'), 'export function b() {\n  return "b";\n}\n');
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolContext(root: string, deltaCache?: DeltaCache, tokenBudget = 4000): ToolContext {
  return {
    projectRoot: root,
    tokenBudget,
    ...(deltaCache ? { deltaCache } : {}),
  };
}

describe('LLM input correctness fixture', () => {
  it('awaits async graph context before assembling analyst prompts', async () => {
    const prompt = await buildAnalystPrompt(
      { id: 'architecture', label: 'Architecture' },
      { name: 'FixtureProject', lang: 'typescript', fileCount: 2 },
      null,
      null,
      null,
      {
        generateContextForAgent: async () => '## Code Entity Graph\nAsync graph context',
      },
      null,
      null,
      null,
      null,
      null
    );

    expect(prompt).toContain('Async graph context');
    expect(prompt).not.toContain('[object Promise]');
  });

  it('publishes code.read filePaths in the registry without requiring path', () => {
    const readSpec = TOOL_REGISTRY.code?.actions.read;
    const params = readSpec?.params as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(params.required ?? []).not.toContain('path');
    expect(params.properties?.path).toBeTruthy();
    expect(params.properties?.filePaths).toBeTruthy();
    expect(readSpec?.description).toContain('partial failure');
  });

  it('keeps code.read path compatible while enabling batch filePaths partial failure', async () => {
    await withCodeFixture(async (root) => {
      const router = new ToolRouter();

      const single = await router.execute(
        { tool: 'code', action: 'read', params: { path: 'src/a.ts', maxLines: 1 } },
        toolContext(root)
      );
      expect(single.ok).toBe(true);
      expect(single.data).toContain('1|export const a = 1;');

      const batch = await router.execute(
        {
          tool: 'code',
          action: 'read',
          params: { filePaths: ['src/a.ts', 'src/missing.ts', '../outside.ts'], maxLines: 1 },
        },
        toolContext(root)
      );
      expect(batch.ok).toBe(true);
      expect(batch.error).toBeUndefined();
      expect(JSON.stringify(batch)).not.toContain('Missing required param "path"');

      const data = batch.data as BatchReadData;
      expect(data.mode).toBe('batch');
      expect(data.summary).toMatchObject({
        requested: 3,
        succeeded: 1,
        failed: 2,
        partialFailure: true,
        maxFiles: 5,
      });
      expect(data.files.find((file) => file.path === 'src/a.ts')?.content).toContain(
        '1|export const a = 1;'
      );
      expect(data.files.find((file) => file.path === '../outside.ts')?.error).toContain(
        'outside project root'
      );
    });
  });

  it('applies delta cache per file and caps batch output by token budget', async () => {
    await withCodeFixture(async (root) => {
      const router = new ToolRouter();
      const deltaCache = new DeltaCache(10);

      const first = await router.execute(
        { tool: 'code', action: 'read', params: { filePaths: ['src/a.ts', 'src/b.ts'] } },
        toolContext(root, deltaCache)
      );
      expect(first.ok).toBe(true);

      const second = await router.execute(
        { tool: 'code', action: 'read', params: { filePaths: ['src/a.ts', 'src/b.ts'] } },
        toolContext(root, deltaCache)
      );
      const secondData = second.data as BatchReadData;
      expect(secondData.files.every((file) => file.content === '[unchanged since last read]')).toBe(
        true
      );

      const longContent = Array.from(
        { length: 400 },
        (_, i) => `export const value${i} = "${'x'.repeat(80)}";`
      ).join('\n');
      await writeFile(join(root, 'src/long.ts'), longContent);

      const capped = await router.execute(
        { tool: 'code', action: 'read', params: { filePaths: ['src/long.ts'] } },
        toolContext(root, undefined, 1000)
      );
      const cappedData = capped.data as BatchReadData;
      const cappedFile = cappedData.files[0];
      expect(capped.ok).toBe(true);
      expect(cappedFile?.truncated).toBe(true);
      expect(cappedFile?.originalTokensEstimate).toBeGreaterThan(
        cappedData.summary.perFileTokenBudget
      );
      expect(cappedFile?.content).toContain('truncated for batch read budget');
    });
  });

  it('keeps SCAN planning consistent with toolChoice none', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );

    expect(tracker?.phase).toBe('SCAN');
    expect(tracker?.getToolChoice()).toBe('none');

    tracker?.tick();
    const nudge = tracker?.getNudge({ expectPlan: () => undefined } as never);

    expect(nudge?.type).toBe('planning');
    expect(nudge?.text).toContain('下一轮');
    expect(nudge?.text).not.toContain('同一轮');
    expect(nudge?.text).not.toContain('立即开始执行');
  });
});
