/**
 * L6-P3r5：韩文否定标记识别（MemoryConsolidator 矛盾判定与 MemoryRetriever.append 去重共用）。
 *
 * 纯函数用例，不构造 better-sqlite3 Database；固化 / append 的端到端行为在 test/memory-store-script-dedup.test.ts。
 * 名词 안（“里面”，집 안에、폴더 안 파일）不得被当作否定，所以正反例成对钉住。
 */
import { describe, expect, it } from 'vitest';
import { hasKoreanNegation } from '../src/agent/memory/MemoryConsolidator.js';

describe('hasKoreanNegation', () => {
  it.each([
    ['standalone 안 before a verb', '테스트 실행 전에 Redis 캐시를 안 비운다'],
    ['standalone 안 before a polite verb', '토큰은 localStorage에 안 저장해요'],
    ['standalone 안 before a clause-final verbal noun', '토큰은 localStorage 에 안 저장'],
    ['sentence-final 안 함', '토큰을 localStorage에 저장 안 함'],
    ['sentence-final 안 함 followed by punctuation', '빌드할 때 pnpm 사용 안 함.'],
    ['sentence-final 안 해', 'CI 캐시를 새로 설치 안 해'],
    ['안 before a nominalised verb', 'pnpm 안 씀'],
    ['안 ending a clause before a comma', 'pnpm 안 씀, yarn 씀'],
    ['안 ending a line', '토큰은 localStorage 에 안 저장\n캐시는 매일 비운다'],
    ['standalone 못 before a nominalised verb', 'pnpm 못 씀'],
    ['standalone 못 before a verb', '사내 npm 레지스트리를 못 쓴다'],
    ['the long form -지 않-', '토큰은 브라우저에 저장하지 않는다'],
    ['the long form -지 않- without a space', '토큰은 브라우저에 저장하지않음'],
    ['the long form -지 못-', '오프라인에서는 레지스트리를 사용하지 못한다'],
    ['the prohibitive -지 마-', '토큰을 localStorage에 저장하지 마세요'],
    ['the prohibitive -지 말-', 'console.log는 커밋에 남기지 말 것'],
    ['the written-together 안함', '자동 업데이트는 사용 안함'],
    ['NFD input', '토큰은 localStorage 에 안 저장'.normalize('NFD')],
  ])('recognises %s', (_label, text) => {
    expect(hasKoreanNegation(text)).toBe(true);
  });

  it.each([
    ['the noun 안 with a particle', '집 안에 서버를 두고 운영한다'],
    ['the noun 안 with -에서', '폴더 안에서 스크립트를 실행한다'],
    ['the noun 안 before an object noun', '방 안 온도를 매일 기록한다'],
    [
      'the noun 안 before a noun that continues on the same line',
      '프로젝트 폴더 안 설정 파일 목록',
    ],
    ['the noun 안 inside a noun phrase', 'Docker 컨테이너 안 설정 파일을 수정한다'],
    ['the noun 안 ending the sentence', '설정 파일은 프로젝트 폴더 안'],
    ['words that start with 안', '안전 모드로 실행하고 안드로이드 빌드는 Gradle로 한다'],
    ['a word that ends with 안함', '편안함을 우선한다'],
    ['a noun ending in 지 before 마을', '관광지 마을 지도를 캐시한다'],
    ['the noun 못 (nail)', '벽에 못을 박는다'],
    ['an affirmative single-syllable statement', 'pnpm 꼭 씀'],
    ['English negation (handled by the English patterns)', 'do not store the token'],
    ['Chinese negation (handled by the Chinese patterns)', '不要使用 localStorage 存储令牌'],
  ])('does not treat %s as a negation', (_label, text) => {
    expect(hasKoreanNegation(text)).toBe(false);
  });
});
