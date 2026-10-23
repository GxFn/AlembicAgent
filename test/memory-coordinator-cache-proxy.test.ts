/**
 * 缓存层删除的结构守护（W1-04：审阅包 L6-P26，兼 L5-P47、L3-P08 cache 端口）。
 *
 * 背景（C64）：SessionStore 只读工具缓存在生产中没有写入者也没有读取者——observationRecord 已移出
 * 默认工具管道且有信封时总以 cacheHit=true 跳过写入，MemoryCoordinator 的缓存代理与 kernel
 * ToolResultCacheProvider 端口没有调用方。按决定①（2026-10-20 答复）整体删除：
 *   - SessionStore 的 getCachedResult/cacheToolResult/get/set/clearCache 与缓存 Map、TTL、清理定时器；
 *   - MemoryCoordinator 的 getCachedResult/cacheToolResult 代理与 recordObservation；
 *   - kernel 的 ToolResultCacheProvider 与 ToolRuntimeCallContext.cache；
 *   - SessionStoreConfig 的 ttlMs/cleanupIntervalMs。
 * vitest 不做类型检查，所以类型成员的删除用 TypeScript AST 断言锁定，运行时成员用原型断言锁定。
 *
 * 本文件只依赖 MemoryCoordinator、SessionStore 与 TypeScript compiler API，不依赖 better-sqlite3。
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { SessionStore } from '../src/agent/memory/SessionStore.js';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readSource(relativePath),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
}

/** 顶层 interface / class 的成员名；找不到容器时抛错，避免守护因改名静默空转。 */
function memberNames(sourceFile: ts.SourceFile, containerName: string): string[] {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === containerName
    ) {
      return statement.members
        .map((member) => {
          const name = (member as { name?: ts.PropertyName }).name;
          if (!name) {
            return undefined;
          }
          return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)
            ? name.text
            : undefined;
        })
        .filter((name): name is string => typeof name === 'string');
    }
  }
  throw new Error(`container ${containerName} not found in ${sourceFile.fileName}`);
}

function topLevelNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(declaration.name.getText(sourceFile));
      }
    } else if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

describe('cache layer removal structure guard (W1-04 / L6-P26)', () => {
  it('removes the read-only tool cache members from the SessionStore prototype', () => {
    for (const member of ['getCachedResult', 'cacheToolResult', 'get', 'set', 'clearCache']) {
      expect({ member, present: member in SessionStore.prototype }).toEqual({
        member,
        present: false,
      });
    }
    // dispose 与 Disposable 实现保留：宿主在会话结束时 dispose SessionStore（L6-P28）。
    expect(typeof SessionStore.prototype.dispose).toBe('function');
  });

  it('removes the cache proxies and recordObservation from the MemoryCoordinator prototype', () => {
    for (const member of ['getCachedResult', 'cacheToolResult', 'recordObservation']) {
      expect({ member, present: member in MemoryCoordinator.prototype }).toEqual({
        member,
        present: false,
      });
    }
  });

  it('leaves no cache maps, TTL sweeper or cleanup timer in the SessionStore source', () => {
    const source = parse('src/agent/memory/SessionStore.ts');
    const text = source.getFullText();
    const classMembers = memberNames(source, 'SessionStore');
    for (const retired of ['#searchCache', '#fileCache', '#cleanupTimer', 'getCachedResult']) {
      expect({ retired, present: classMembers.includes(retired) }).toEqual({
        retired,
        present: false,
      });
    }
    for (const retired of [
      '#searchCache',
      '#fileCache',
      '#cacheStats',
      '#ttlMs',
      '#cleanupTimer',
      '#registerCleanupTimer',
      '#evictExpired',
      'normalizeCacheArgs',
      'timerRegistry',
      'SessionStore/cleanup',
      'stableStringify',
    ]) {
      expect({ retired, present: text.includes(retired) }).toEqual({ retired, present: false });
    }
    expect(topLevelNames(source)).not.toEqual(
      expect.arrayContaining(['SearchCacheEntry', 'ToolArgs', 'SESSION_CACHE_DEFAULTS'])
    );
    // implements Disposable 保留。
    expect(text).toMatch(/export class SessionStore implements Disposable/);
  });

  it('drops ttlMs and cleanupIntervalMs from SessionStoreConfig (AST)', () => {
    const members = memberNames(parse('src/agent/memory/SessionStore.ts'), 'SessionStoreConfig');
    expect(members).not.toContain('ttlMs');
    expect(members).not.toContain('cleanupIntervalMs');
    expect(members).toEqual(
      expect.arrayContaining([
        'projectContext',
        'projectName',
        'primaryLang',
        'fileCount',
        'modules',
      ])
    );
  });

  it('drops ToolResultCacheProvider and ToolRuntimeCallContext.cache from the kernel contract (AST)', () => {
    const context = parse('src/tools/kernel/context.ts');
    expect(topLevelNames(context)).not.toContain('ToolResultCacheProvider');
    const runtimeMembers = memberNames(context, 'ToolRuntimeCallContext');
    expect(runtimeMembers).not.toContain('cache');
    // 仍在使用的端口保留：诊断收集器、memoryCoordinator 与证据台账。
    expect(runtimeMembers).toEqual(
      expect.arrayContaining(['diagnostics', 'memoryCoordinator', 'evidenceLedger'])
    );
  });
});
