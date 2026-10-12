import { describe, expect, it } from 'vitest';

// module-review L6 C63（不触公开面的本地部分）：PersistentMemory 的 ProjectSemanticMemory 别名
// 与 default 导出、scanPrompts 的 default 导出都不在公开签名基线内——memory 门面只按名字转出
// PersistentMemory，prompts 门面用 `export *`（不转出 default），仓内与宿主也没有默认导入。
// 这里锁住它们已被删除，命名导出保持不变。

describe('retired module-local default/alias exports', () => {
  it('PersistentMemory module exposes only the named class', async () => {
    const mod: Record<string, unknown> = await import('../src/agent/memory/PersistentMemory.js');
    expect(typeof mod.PersistentMemory).toBe('function');
    expect(Object.hasOwn(mod, 'default')).toBe(false);
    expect(Object.hasOwn(mod, 'ProjectSemanticMemory')).toBe(false);
  });

  it('scanPrompts module exposes SCAN_TASK_CONFIGS only as a named export', async () => {
    const mod: Record<string, unknown> = await import('../src/agent/prompts/scanPrompts.js');
    expect(mod.SCAN_TASK_CONFIGS).toBeTypeOf('object');
    expect(Object.hasOwn(mod, 'default')).toBe(false);
  });
});
