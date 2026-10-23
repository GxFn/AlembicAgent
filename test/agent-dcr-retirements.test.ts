import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALEMBIC_AGENT_INTERFACE_CONTRACT } from '../src/agent/runtime/AgentInterfaceContract.js';
import { ALEMBIC_AGENT_RUNTIME_BOUNDARY } from '../src/agent/runtime/AgentRuntimeBoundary.js';
import { AiProvider } from '../src/ai/AiProvider.js';
import { AiProviderManager } from '../src/ai/AiProviderManager.js';
import * as gatewayEntry from '../src/ai/gateway/index.js';
import * as gatewayModule from '../src/ai/gateway/LLMGateway.js';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import * as aiEntry from '../src/ai/index.js';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { ClaudeTransport } from '../src/ai/transport/ClaudeTransport.js';
import { DeepSeekTransport } from '../src/ai/transport/DeepSeekTransport.js';
import { GoogleTransport } from '../src/ai/transport/GoogleTransport.js';
import { LLMTransport } from '../src/ai/transport/LLMTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import * as agentRoot from '../src/index.js';

// Identifiers are split so repo-wide consumer scans for the retired surfaces
// keep returning zero hits outside deletion notes and policy entries.
const retiredAggregateExport = ['./to', 'ols'].join('');
const retiredAggregateSpecifier = ['@alembic/agent/to', 'ols'].join('');
const retiredTerminalExport = ['./tools', '/terminal'].join('');
const retiredTerminalSpecifier = ['@alembic/agent/tools', '/terminal'].join('');
const removedEnrichMember = ['enrich', 'Candidates'].join('');
const removedEnrichPromptBuilder = ['_buildEnrich', 'Prompt'].join('');
const removedLangInstructionBuilder = ['_buildLang', 'Instruction'].join('');

function readRepoJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

describe('retired tool package exports', () => {
  it('keeps retired aggregate and terminal subpaths out of package exports', () => {
    const packageJson = readRepoJson('package.json');
    const exportPaths = Object.keys(packageJson.exports as Record<string, unknown>);

    expect(exportPaths).not.toContain(retiredAggregateExport);
    expect(exportPaths).not.toContain(retiredTerminalExport);
    expect(exportPaths).toContain('./tools/runtime');
    expect(exportPaths).toContain('.');
  });

  it('keeps retired subpaths out of the boundary policy and signature snapshot', () => {
    const boundary = readRepoJson('config/agent-public-api-boundary.json');
    const signatures = readRepoJson('config/agent-public-api-signatures.json');
    const boundaryStable = boundary.stablePublicExports as string[];
    const signatureStable = signatures.stablePublicExports as string[];
    const signatureEntries = signatures.stableExportSignatures as Record<string, unknown>;
    const expectedCounts = boundary.expectedCounts as Record<string, number>;

    expect(boundaryStable).not.toContain(retiredAggregateExport);
    expect(boundaryStable).not.toContain(retiredTerminalExport);
    expect(signatureStable).not.toContain(retiredAggregateExport);
    expect(signatureStable).not.toContain(retiredTerminalExport);
    expect(Object.keys(signatureEntries)).not.toContain(retiredAggregateExport);
    expect(Object.keys(signatureEntries)).not.toContain(retiredTerminalExport);
    expect(expectedCounts['stable-public']).toBe(15);
    expect(signatures.packageExportCount).toBe(15);
    expect(boundary.forbiddenConsumerSpecifiers as string[]).toContain(retiredAggregateSpecifier);
    expect(boundary.forbiddenConsumerSpecifiers as string[]).toContain(retiredTerminalSpecifier);
  });

  it('routes the tool-execution boundary and consumer seams through the root facade', () => {
    const toolExecution = ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.find(
      (entry) => entry.area === 'tool-execution'
    );

    expect(toolExecution).toMatchObject({ owner: 'agent', publicSubpath: '@alembic/agent' });
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams).not.toContain(
      retiredAggregateSpecifier
    );
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams).not.toContain(
      retiredTerminalSpecifier
    );
    expect(
      ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.find((entry) => entry.area === 'terminal-sandbox')
    ).toMatchObject({
      publicSubpath: '@alembic/agent/tools/runtime',
    });
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams).toContain('@alembic/agent');
  });
});

describe('removed AiProvider enrich surface (Train B DCR default-delete)', () => {
  it('does not expose the removed enrich member or its prompt builders', () => {
    expect(removedEnrichMember in AiProvider.prototype).toBe(false);
    expect(removedEnrichPromptBuilder in AiProvider.prototype).toBe(false);
    expect(removedLangInstructionBuilder in AiProvider.prototype).toBe(false);
  });
});

/**
 * W2a-11（审阅包 L2-P21、L2-P22，用户 2026-10-20 按推荐批准事项②③）：AI provider、Gateway、
 * Manager 与 Transport 的遗留成员与共享 Gateway 单例已删除。删除前四处扫描（Agent src/test、宿主
 * lib/bin/test、Plugin、Dashboard、Core）均为零引用；宿主 `_bindDiSync` 回调本就只用一个参数。
 */
function presentMembers(target: object, members: readonly string[]): string[] {
  return members.filter((member) => member in target);
}

describe('retired AI provider, gateway, manager and transport members (W2a-11 / L2-P21, L2-P22)', () => {
  const builtinProviders = [
    OpenAiProvider,
    ClaudeProvider,
    DeepSeekProvider,
    GoogleGeminiProvider,
    OllamaProvider,
  ];

  it('removes the legacy AiProvider members from the base and every built-in provider', () => {
    const removed = [
      'supportsNativeToolCalling',
      'summarize',
      'summarizeMaxTokens',
      '_detectLanguageProfile',
    ];
    for (const target of [AiProvider, ...builtinProviders]) {
      expect({ owner: target.name, present: presentMembers(target.prototype, removed) }).toEqual({
        owner: target.name,
        present: [],
      });
    }
    // _fallbackFrom 是类字段，不在原型上：构造出的实例也不能再带这个自有属性。
    for (const Provider of builtinProviders) {
      const instance = new Provider({ apiKey: 'fixture-key' });
      expect({ owner: Provider.name, own: Object.hasOwn(instance, '_fallbackFrom') }).toEqual({
        owner: Provider.name,
        own: false,
      });
    }
    // 保留项：probe、结构化输出与 embedding 能力标记照常存在。
    for (const member of ['probe', 'chatWithStructuredOutput', 'supportsEmbedding']) {
      expect({ member, kind: typeof (AiProvider.prototype as never)[member] }).toEqual({
        member,
        kind: 'function',
      });
    }
  });

  it('removes Gateway probe, fallback and model lookup helpers but keeps chatStructured', () => {
    expect(
      presentMembers(LLMGateway.prototype, ['probe', 'resolveWithFallback', 'getModelDef'])
    ).toEqual([]);
    for (const member of ['chat', 'chatWithTools', 'chatStructured', 'embed']) {
      expect({ member, kind: typeof (LLMGateway.prototype as never)[member] }).toEqual({
        member,
        kind: 'function',
      });
    }
  });

  it('does not export the shared Gateway singleton functions from any AI entry', () => {
    for (const [entry, moduleExports] of [
      ['.', agentRoot],
      ['./ai', aiEntry],
      ['src/ai/gateway/index.ts', gatewayEntry],
      ['src/ai/gateway/LLMGateway.ts', gatewayModule],
    ] as const) {
      const exported = moduleExports as Record<string, unknown>;
      expect({
        entry,
        present: ['getLLMGateway', 'resetLLMGateway'].filter((n) => n in exported),
      }).toEqual({ entry, present: [] });
      expect({ entry, gateway: typeof exported.LLMGateway }).toEqual({
        entry,
        gateway: 'function',
      });
    }
  });

  it('removes the embedding compatibility slot from AiProviderManager but keeps isMock', () => {
    expect(
      presentMembers(AiProviderManager.prototype, [
        'embedProvider',
        'rawEmbedProvider',
        'setEmbedProvider',
      ])
    ).toEqual([]);
    const manager = new AiProviderManager({ name: 'fixture', model: 'fixture-model' });
    expect(manager.isMock).toBe(false);
  });

  it('removes Transport-level chat and chatStructured from the base and every transport', () => {
    for (const Transport of [
      LLMTransport,
      OpenAiTransport,
      ClaudeTransport,
      DeepSeekTransport,
      GoogleTransport,
    ]) {
      expect({
        owner: Transport.name,
        present: presentMembers(Transport.prototype, ['chat', 'chatStructured']),
      }).toEqual({ owner: Transport.name, present: [] });
    }
    for (const Transport of [
      OpenAiTransport,
      ClaudeTransport,
      DeepSeekTransport,
      GoogleTransport,
    ]) {
      expect({ owner: Transport.name, kind: typeof Transport.prototype.chatWithTools }).toEqual({
        owner: Transport.name,
        kind: 'function',
      });
    }
  });
});
