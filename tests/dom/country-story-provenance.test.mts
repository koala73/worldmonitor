import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { collectBriefSources, renderBriefSourcesFooter } from '@/utils/brief-sources';
import { formatIntelBrief, renderBriefEvidenceFooter } from '@/utils/format-intel-brief';
import { trustedHtml, setTrustedHtml } from '@/utils/dom-utils';
import { createCountryBriefOutput, freezeBriefContent, type BriefOutputSnapshot } from '@/components/CountryBriefOutput';
import { briefSectionState, summarizeCountryBrief, BRIEF_SECTIONS } from '@/components/country-brief-presentation';

const source = readFileSync(new FileURL('../../src/components/CountryDeepDivePanel.ts', import.meta.url), 'utf8');
const syntax = ts.createSourceFile('panel.ts', source, ts.ScriptTarget.Latest, true);
const declaration = syntax.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'CountryDeepDivePanel') as ts.ClassDeclaration;
const methods = ['openOutput', 'show', 'resetPanelContent', 'updateBrief', 'formatBrief'].map(name => declaration.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(syntax) === name)!.getText(syntax));
const executable = ts.transpileModule(`class Harness {${methods.join('\n')}} exports.Harness=Harness;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function element(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

function fixture() {
  let captured: BriefOutputSnapshot | undefined;
  const failures: unknown[] = [];
  const outputModule = { freezeBriefContent, createCountryBriefOutput: (...args: Parameters<typeof createCountryBriefOutput>) => {
    captured = args[0]; return createCountryBriefOutput(...args);
  } };
  const context = { exports: {} as { Harness?: new () => any }, Date, Array, AbortController, clearTimeout,
    console: { error: (...args: unknown[]) => failures.push(args) }, BRIEF_SECTIONS, briefSectionState, summarizeCountryBrief,
    collectBriefSources, renderBriefSourcesFooter, renderBriefEvidenceFooter, formatIntelBrief, trustedHtml, setTrustedHtml,
    t: (key: string) => key, showToast: (message: string) => failures.push(message), require: () => outputModule };
  vm.runInNewContext(executable, context);
  const panel = new context.exports.Harness!();
  panel.abortController = new AbortController(); Object.defineProperty(panel, 'signal', { get: () => panel.abortController.signal });
  Object.assign(panel, { currentCode: 'CA', currentName: 'Canada', currentHeadlineCount: 0, outputClose: null, outputRequestSignal: null,
    content: element('div'), sections: [], infrastructureByType: new Map(), isVisible: () => true, el: element,
    makeEmpty: (message: string) => element('div', 'cdp-empty', message), open: () => {}, tearDownFiveFactorScorecard: () => {},
    destroyResilienceWidget: () => {}, tearDownFollowButton: () => {} });
  document.body.replaceChildren(panel.content);
  const shell = element('div', 'cdp-shell'); panel.content.append(shell);
  const assessment = element('section', 'cdp-card'); panel.briefBody = element('div', 'cdp-card-body'); assessment.append(panel.briefBody); shell.append(assessment);
  panel.sections.push({ id: 'assessment', title: 'Assessment', card: assessment, body: panel.briefBody });
  panel.newsBody = element('div'); shell.append(panel.newsBody);
  panel.renderSkeleton = () => { panel.resetPanelContent(); panel.content.append(element('div', 'cdp-shell')); };
  panel.updateBrief({ code: 'CA', brief: 'The assessment cites [wm:fixture-evidence] and a news report [1]. Missing observations remain unknown.',
    generatedAt: '2026-10-04T11:22:33Z', cached: true,
    sources: [{ title: 'News observation', source: 'Fixture News Agency', url: 'https://example.com/news', publishedAt: '2026-10-02T05:06:07Z' }],
    evidence: [{ id: 'fixture-evidence', label: 'Fixture evidence observation', value: 'Unknown coverage', asOf: '2026-10-03T09:12:34Z', url: 'https://example.com/data' }] });
  return { panel, failures, snapshot: () => captured!, paper: () => panel.content.querySelector('.cdp-output-paper') as HTMLElement };
}

describe('Actual assessment renderer to captured story provenance', () => {
  it('retains cited evidence, Unknown, original dates and metadata alongside news without duplicate footers', async () => {
    const { panel, failures, snapshot, paper } = fixture();
    const metadata = panel.briefBody.querySelector('.cdp-assessment-meta').textContent;
    expect(metadata).toContain('Cached'); expect(metadata).toContain('Updated');
    await panel.openOutput('story', element('button'));
    expect(failures).toEqual([]);
    expect(paper().textContent, 'Story must preserve the evidence cited by its assessment').toContain('Fixture evidence observation');
    for (const text of ['[wm:fixture-evidence]', 'Unknown coverage', '2026-10-03', 'Fixture News Agency', '2026-10-02', metadata]) expect(paper().textContent).toContain(text);
    expect(paper().querySelectorAll('.cdp-brief-evidence')).toHaveLength(1);
    expect(paper().querySelectorAll('.cdp-brief-sources')).toHaveLength(2);
    expect(paper().querySelector('.cdp-assessment-meta')?.textContent).toBe(metadata);
    const report = createCountryBriefOutput(snapshot(), 'report', () => {});
    for (const text of ['Fixture evidence observation', 'Unknown coverage', '2026-10-03', 'Fixture News Agency', '2026-10-02', metadata]) expect(report.textContent).toContain(text);
  });

  it('keeps captured country, footers and original metadata frozen after live assessment and country changes', async () => {
    const { panel, snapshot } = fixture(); await panel.openOutput('story', element('button'));
    const captured = snapshot(); const before = captured.story[0]!.content.outerHTML;
    panel.updateBrief({ code: 'CA', brief: 'Replacement assessment', generatedAt: '2026-10-06T01:02:03Z', cached: false, sources: [], evidence: [] });
    panel.show('France', 'FR', null, null);
    expect(panel.currentCode).toBe('FR'); expect(captured.code).toBe('CA'); expect(captured.country).toBe('Canada');
    expect(captured.story[0]!.content.outerHTML).toBe(before);
    const story = createCountryBriefOutput(captured, 'story', () => {});
    expect(story.textContent).toContain('Fixture evidence observation'); expect(story.textContent).toContain('2026-10-03');
    expect(story.textContent).not.toContain('Replacement assessment'); expect(story.textContent).not.toContain('France');
  });

  it('preserves actual unavailable assessment state without stale footers or invented clocks', async () => {
    const { panel, failures, paper } = fixture();
    panel.updateBrief({ code: 'CA', error: 'Assessment source unavailable' });
    await panel.openOutput('story', element('button'));
    expect(failures).toEqual([]); expect(paper().textContent).toContain('Assessment is not available in this snapshot.');
    expect(paper().querySelector('.cdp-brief-sources, .cdp-assessment-meta')).toBeNull();
    expect(paper().textContent).not.toContain('2026-10-03'); expect(paper().textContent).not.toContain('Updated');
  });
});
