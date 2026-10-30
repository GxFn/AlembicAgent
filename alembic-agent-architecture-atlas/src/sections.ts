import { stableSectionId } from '../scripts/relations.mjs';

/** 同名子标题使用父标题路径；插入无关标题不改变定位。完全同名同级内容需作者显式场景锚点。 */
export function sectionIdentities(headings: { level: number; title: string }[]) {
  const parents: { level: number; title: string }[] = [];
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    while (parents.length && (parents.at(-1)?.level ?? 0) >= heading.level) {
      parents.pop();
    }
    const key = [...parents.map((p) => p.title), heading.title].join(' › ');
    const base = stableSectionId(key);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    parents.push(heading);
    return occurrence === 1 ? base : `${base}--${occurrence}`;
  });
}
export function readerSections(body: string) {
  const sections: { level: number; title: string; text: string }[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
    }
    const heading = !fenced && line.match(/^(#{2,6})\s+(.+)$/u);
    if (heading) {
      sections.push({
        level: heading[1].length,
        title: heading[2].replace(/[`*_]/gu, '').trim(),
        text: '',
      });
    } else if (!fenced && sections.length) {
      sections[sections.length - 1].text += `${line}\n`;
    }
  }
  const ids = sectionIdentities(sections);
  return sections.map((s, i) => ({ ...s, id: ids[i] }));
}
