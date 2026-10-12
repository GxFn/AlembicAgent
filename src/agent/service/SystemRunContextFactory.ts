import type { AiProvider } from '#ai/AiProvider.js';
import { ContextWindow } from '../context/ContextWindow.js';
import { ExplorationTracker } from '../context/ExplorationTracker.js';
import { MemoryCoordinator } from '../memory/MemoryCoordinator.js';
import {
  createSystemRunContext,
  projectSystemRunContext,
  type SystemRunContext,
} from '../runtime/SystemRunContext.js';

export interface BuildSystemContextOptions {
  budget?: Record<string, unknown>;
  trackerStrategy?: string;
  label?: string;
  lang?: string;
}

export interface SystemRunContextFactoryOptions {
  aiProvider?: Pick<AiProvider, 'model'> | null;
}

export class SystemRunContextFactory {
  #aiProvider: Pick<AiProvider, 'model'> | null;

  constructor({ aiProvider = null }: SystemRunContextFactoryOptions = {}) {
    this.#aiProvider = aiProvider;
  }

  createContextWindow(opts: { isSystem?: boolean } = {}) {
    const modelName = this.#aiProvider?.model || '';
    const tokenBudget = ContextWindow.resolveTokenBudget(modelName, {
      ...opts,
      provider: this.#providerHint(),
    });
    return new ContextWindow(tokenBudget);
  }

  /**
   * 运行时 provider 身份（AiProvider.name，如 'google'）作为预算查询的 provider 提示，
   * 优先于 ALEMBIC_AI_PROVIDER：部署常用 'auto'，或与实际创建的 provider 不一致。
   * 公开选项类型只声明 model（宿主按 { model } 注入），这里按运行时形状读取 name，
   * 不扩大公开类型；缺失或非字符串时返回 undefined，由 ContextWindow 退回环境变量或 apiModelId 查询。
   */
  #providerHint(): string | undefined {
    const provider = this.#aiProvider;
    if (provider && 'name' in provider && typeof provider.name === 'string' && provider.name) {
      return provider.name;
    }
    return undefined;
  }

  createSystemContext({
    budget,
    trackerStrategy = 'analyst',
    label = 'default',
    lang,
  }: BuildSystemContextOptions = {}) {
    const memoryCoordinator = new MemoryCoordinator({ mode: 'bootstrap' });
    const scopeId = `scan:${label}`;
    const activeContext = memoryCoordinator.createDimensionScope(scopeId);
    const systemRunContext = createSystemRunContext({
      memoryCoordinator,
      scopeId,
      activeContext,
      contextWindow: this.createContextWindow({ isSystem: true }),
      tracker: ExplorationTracker.resolve(
        { source: 'system', strategy: trackerStrategy },
        budget || {}
      ),
      source: 'system',
      outputType: 'candidate',
      dimId: label,
      projectLanguage: lang || null,
      sharedState: {
        submittedTitles: new Set(),
        submittedPatterns: new Set(),
      },
    });

    return projectSystemRunContext(systemRunContext);
  }

  project(systemRunContext: SystemRunContext) {
    return projectSystemRunContext(systemRunContext);
  }
}

export default SystemRunContextFactory;
