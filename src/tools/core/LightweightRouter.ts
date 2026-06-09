/**
 * LightweightRouter — 非 Agent 表面的轻量工具路由器。
 *
 * 替代重型 V1 ToolRouter (含 GovernanceEngine / SchemaValidator / 5 Service 文件)。
 * 仅做: adapter 查找 → 分发执行 → 包装结果。
 * Dashboard / Terminal / Skill / Mac / Workflow / MCP-like 等宿主注入的 adapter
 * 可通过此路由执行；具体 Codex MCP/channel/marketplace 交付不在本仓库实现。
 */

import { randomUUID } from 'node:crypto';
import type { ToolCallContext, ToolServiceLocator } from '#tools/core/ToolCallContext.js';
import type {
  ToolCallRequest,
  ToolExecutionAdapter,
  ToolExecutionRequest,
  ToolRouterContract,
} from '#tools/core/ToolContracts.js';
import type { ToolDecision } from '#tools/core/ToolDecision.js';
import type { ToolResultEnvelope, ToolResultStatus } from '#tools/core/ToolResultEnvelope.js';
import type { CapabilityCatalog } from '../catalog/CapabilityCatalog.js';
import type {
  CapabilityKind,
  CapabilitySurface,
  ToolCapabilityManifest,
} from '../catalog/CapabilityManifest.js';

export interface LightweightRouterOptions {
  catalog: CapabilityCatalog;
  adapters?: ToolExecutionAdapter[];
  projectRoot?: string;
  dataRoot?: string;
  services?: ToolServiceLocator;
}

export class LightweightRouter implements ToolRouterContract {
  readonly #catalog: CapabilityCatalog;
  readonly #adapters = new Map<CapabilityKind, ToolExecutionAdapter>();
  readonly #projectRoot: string;
  readonly #dataRoot: string;
  readonly #services: ToolServiceLocator;

  constructor(options: LightweightRouterOptions) {
    this.#catalog = options.catalog;
    this.#projectRoot = options.projectRoot || process.cwd();
    this.#dataRoot = options.dataRoot || this.#projectRoot;
    this.#services = options.services || {
      get(name: string) {
        throw new Error(`Service '${name}' not available`);
      },
    };
    for (const adapter of options.adapters || []) {
      this.#adapters.set(adapter.kind, adapter);
    }
  }

  async execute(request: ToolCallRequest): Promise<ToolResultEnvelope> {
    const startMs = Date.now();
    const callId = randomUUID();
    const startedAt = new Date().toISOString();

    try {
      const manifest = this.#catalog.getManifest(request.toolId);
      if (!manifest) {
        return this.#finalizeEnvelope(
          request,
          null,
          this.#errorEnvelope(
            request.toolId,
            callId,
            startedAt,
            startMs,
            `Unknown tool: ${request.toolId}`
          )
        );
      }

      const decision = this.#explainWithManifest(request, manifest);
      if (!decision.allowed) {
        return this.#finalizeEnvelope(
          request,
          manifest,
          this.#decisionEnvelope(request.toolId, callId, startedAt, startMs, decision)
        );
      }

      if (request.abortSignal?.aborted) {
        return this.#finalizeEnvelope(
          request,
          manifest,
          this.#statusEnvelope(
            request.toolId,
            callId,
            startedAt,
            startMs,
            'aborted',
            'Tool call aborted before execution'
          )
        );
      }

      const adapter = this.#adapters.get(manifest.kind);
      if (!adapter) {
        return this.#finalizeEnvelope(
          request,
          manifest,
          this.#errorEnvelope(
            request.toolId,
            callId,
            startedAt,
            startMs,
            `No adapter for kind: ${manifest.kind}`
          )
        );
      }

      const context = this.#buildContext(request, callId);
      const execReq: ToolExecutionRequest = {
        manifest,
        args: request.args,
        context,
        decision,
      };

      const envelope = await this.#executeWithControls(adapter, execReq, {
        toolId: request.toolId,
        callId,
        startedAt,
        startMs,
        timeoutMs: manifest.execution.timeoutMs,
        abortSignal: request.abortSignal ?? null,
      });
      return this.#finalizeEnvelope(request, manifest, envelope);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.#finalizeEnvelope(
        request,
        null,
        this.#errorEnvelope(request.toolId, callId, startedAt, startMs, msg)
      );
    }
  }

  async executeChildCall(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope> {
    return this.execute(request);
  }

  async explain(request: ToolCallRequest): Promise<ToolDecision> {
    const manifest = this.#catalog.getManifest(request.toolId);
    if (!manifest) {
      return {
        allowed: false,
        stage: 'approve',
        reason: `Unknown tool: ${request.toolId}`,
        resultStatus: 'blocked',
      };
    }
    return this.#explainWithManifest(request, manifest);
  }

  #explainWithManifest(request: ToolCallRequest, manifest: ToolCapabilityManifest): ToolDecision {
    if (!this.#isSurfaceAllowed(request.surface, manifest.surfaces)) {
      return {
        allowed: false,
        stage: 'approve',
        reason: `Tool '${request.toolId}' is not allowed on surface '${request.surface}'`,
        resultStatus: 'blocked',
      };
    }

    const policyCheck = request.runtime?.policyValidator?.validateToolCall(
      request.toolId,
      request.args
    );
    if (policyCheck && !policyCheck.ok) {
      const resultStatus =
        policyCheck.resultStatus ??
        (policyCheck.requiresConfirmation ? 'needs-confirmation' : 'blocked');
      return {
        allowed: false,
        stage: 'approve',
        reason: policyCheck.reason || `Tool '${request.toolId}' was blocked by policy`,
        resultStatus,
        requiresConfirmation:
          policyCheck.requiresConfirmation || resultStatus === 'needs-confirmation',
        confirmationMessage: policyCheck.confirmationMessage,
        requestId: policyCheck.requestId,
      };
    }

    const preview = this.#adapters.get(manifest.kind)?.preview?.({
      manifest,
      args: request.args,
      projectRoot: this.#projectRoot,
    });

    return {
      allowed: true,
      stage: 'approve',
      policyProfile: manifest.governance.policyProfile,
      auditLevel: manifest.governance.auditLevel,
      ...(preview ? { preview } : {}),
    };
  }

  #isSurfaceAllowed(surface: ToolCallRequest['surface'], surfaces: CapabilitySurface[]): boolean {
    if (surface === 'composer') {
      return true;
    }
    if (surface === 'system') {
      return true;
    }
    return surfaces.includes(surface as CapabilitySurface);
  }

  async #executeWithControls(
    adapter: ToolExecutionAdapter,
    execReq: ToolExecutionRequest,
    meta: {
      toolId: string;
      callId: string;
      startedAt: string;
      startMs: number;
      timeoutMs: number;
      abortSignal: AbortSignal | null;
    }
  ): Promise<ToolResultEnvelope> {
    const timeoutMs = Math.max(0, Number(meta.timeoutMs) || 0);
    const execution = adapter.execute(execReq);
    const guards: Promise<ToolResultEnvelope>[] = [execution];
    let timeoutId: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;

    if (timeoutMs > 0) {
      guards.push(
        new Promise<ToolResultEnvelope>((resolve) => {
          timeoutId = setTimeout(() => {
            resolve(
              this.#statusEnvelope(
                meta.toolId,
                meta.callId,
                meta.startedAt,
                meta.startMs,
                'timeout',
                `Tool call timed out after ${timeoutMs}ms`
              )
            );
          }, timeoutMs);
        })
      );
    }

    if (meta.abortSignal) {
      guards.push(
        new Promise<ToolResultEnvelope>((resolve) => {
          abortListener = () => {
            resolve(
              this.#statusEnvelope(
                meta.toolId,
                meta.callId,
                meta.startedAt,
                meta.startMs,
                'aborted',
                'Tool call aborted during execution'
              )
            );
          };
          meta.abortSignal?.addEventListener('abort', abortListener, { once: true });
        })
      );
    }

    try {
      return await Promise.race(guards);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.#errorEnvelope(meta.toolId, meta.callId, meta.startedAt, meta.startMs, msg);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (meta.abortSignal && abortListener) {
        meta.abortSignal.removeEventListener('abort', abortListener);
      }
    }
  }

  #finalizeEnvelope(
    request: ToolCallRequest,
    manifest: ToolCapabilityManifest | null,
    envelope: ToolResultEnvelope
  ): ToolResultEnvelope {
    request.runtime?.diagnostics?.recordToolCallEnvelope(envelope, {
      kind: manifest?.kind,
      surface: request.surface,
      source: request.source.name,
    });
    return envelope;
  }

  #decisionEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    startMs: number,
    decision: ToolDecision
  ): ToolResultEnvelope {
    const nextActionHint =
      decision.requiresConfirmation || decision.resultStatus === 'needs-confirmation'
        ? decision.confirmationMessage || 'Await host confirmation before executing this tool call'
        : undefined;

    return this.#statusEnvelope(
      toolId,
      callId,
      startedAt,
      startMs,
      decision.resultStatus || 'blocked',
      decision.reason || `Tool '${toolId}' is not allowed`,
      nextActionHint
    );
  }

  #statusEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    startMs: number,
    status: ToolResultStatus,
    text: string,
    nextActionHint?: string
  ): ToolResultEnvelope {
    return {
      ok: false,
      toolId,
      callId,
      startedAt,
      status,
      text,
      durationMs: Date.now() - startMs,
      diagnostics: this.#defaultDiagnostics(
        status === 'timeout' ? ['execute'] : [],
        status === 'blocked' ? [{ tool: toolId, reason: text }] : [],
        status === 'needs-confirmation'
          ? [{ stage: 'approve', action: 'needs-confirmation', reason: text }]
          : []
      ),
      trust: {
        source: 'internal',
        sanitized: false,
        containsUntrustedText: false,
        containsSecrets: false,
      },
      ...(nextActionHint ? { nextActionHint } : {}),
    };
  }

  #buildContext(request: ToolCallRequest, callId: string): ToolCallContext {
    return {
      callId,
      toolId: request.toolId,
      surface: request.surface,
      actor: request.actor,
      source: request.source,
      projectRoot: this.#projectRoot,
      dataRoot: this.#dataRoot,
      services: this.#services,
      abortSignal: request.abortSignal ?? null,
      parentCallId: request.parentCallId,
      runtime: request.runtime,
    };
  }

  #errorEnvelope(
    toolId: string,
    callId: string,
    startedAt: string,
    startMs: number,
    error: string
  ): ToolResultEnvelope {
    return {
      ok: false,
      toolId,
      callId,
      startedAt,
      status: 'error',
      text: error,
      durationMs: Date.now() - startMs,
      diagnostics: this.#defaultDiagnostics(),
      trust: {
        source: 'internal',
        sanitized: false,
        containsUntrustedText: false,
        containsSecrets: false,
      },
    };
  }

  #defaultDiagnostics(
    timedOutStages: string[] = [],
    blockedTools: Array<{ tool: string; reason: string }> = [],
    gateFailures: Array<{ stage: string; action: string; reason?: string }> = []
  ) {
    return {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages,
      blockedTools,
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures,
    };
  }
}
