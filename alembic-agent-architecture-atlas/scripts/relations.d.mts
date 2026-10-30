export interface AssertionBinding {
  pilotScenario?: {
    id: string;
    status: string;
    fullName: string;
    checkedAt: string;
    assertion: string;
  };
  ref: string;
  state: string;
  line?: number;
  executions: {
    groupId: string;
    caseId: string;
    fileCaseIndex: number;
    title: string;
    status: string;
    runStatus: string;
    inputFreshness: string;
  }[];
}
export interface Scenario {
  id: string;
  title: string;
  docId: string;
  anchor: string;
  symptoms?: string[];
  diagnostics?: string[];
  edgeIds?: string[];
}
export interface Relations {
  schemaVersion: 1;
  pages?: { docId: string; assertions: AssertionBinding[] }[];
  claims: {
    id: string;
    docId: string;
    anchor: string;
    kind: string;
    sourceRefs: string[];
    assertions: AssertionBinding[];
  }[];
  scenarios: Scenario[];
}
export function stableSectionId(title: string): string;
export function documentSections(body: string): { id: string; title: string; text: string }[];
export function docRoute(id: string, section?: string, edge?: string): string;
export function embeddedEvidenceKey(reference: string): 'publicApi' | 'scopedRuns' | null;
