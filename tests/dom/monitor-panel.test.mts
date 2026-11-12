import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MonitorPanel } from '@/components/MonitorPanel';
import type { Monitor, NewsItem } from '@/types';
import { initTestI18n } from './helpers/i18n.mts';

const panels: MonitorPanel[] = [];
const savedMonitors: Monitor[] = [
  { id: 'strait', keywords: ['taiwan', 'strait'], color: '#ff0000' },
  { id: 'shipping', keywords: ['shipping'], color: '#00ff00' },
];

beforeAll(initTestI18n);

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
    panel.getElement().remove();
  }
});

function createPanel(monitors: Monitor[] = savedMonitors): MonitorPanel {
  const panel = new MonitorPanel(structuredClone(monitors));
  panels.push(panel);
  return panel;
}

function tags(panel: MonitorPanel): string[] {
  return Array.from(panel.getElement().querySelectorAll('.monitor-tag'), tag => tag.textContent ?? '');
}

describe('monitor panel DOM ownership', () => {
  it('renders saved keywords before connection and retains them on mount', () => {
    const panel = createPanel();
    const element = panel.getElement();
    expect(element.isConnected).toBe(false);
    expect(tags(panel)).toEqual(['taiwan, strait×', 'shipping×']);

    document.body.append(element);
    panel.notifyConnected();
    expect(tags(panel)).toEqual(['taiwan, strait×', 'shipping×']);
  });

  it('renders replacement monitors and queued results while detached', () => {
    const panel = createPanel([]);
    panel.setMonitors(structuredClone(savedMonitors));
    const news: NewsItem = {
      source: 'Test Wire', title: 'Shipping through the Taiwan Strait',
      link: 'https://example.com/strait', pubDate: new Date(), isAlert: false,
    };
    panel.renderResults([news]);
    document.body.append(panel.getElement());
    panel.notifyConnected();

    expect(tags(panel)).toEqual(['taiwan, strait×', 'shipping×']);
    expect(panel.getElement().querySelectorAll('#monitorsResults .item-title')).toHaveLength(1);
    expect(panel.getElement().querySelector('.item-title')?.textContent).toBe(news.title);
  });

  it('keeps edits and results within their panel instance', () => {
    const first = createPanel();
    const second = createPanel([]);
    document.body.append(first.getElement(), second.getElement());
    first.notifyConnected();
    second.notifyConnected();

    const input = second.getElement().querySelector<HTMLInputElement>('.monitor-input')!;
    input.value = 'energy';
    second.getElement().querySelector<HTMLButtonElement>('.monitor-add-btn')!.click();
    expect(second.getMonitors().map(monitor => monitor.keywords)).toEqual([['energy']]);
    expect(input.value).toBe('');
    expect(tags(second)).toEqual(['energy×']);
    expect(tags(first)).toEqual(['taiwan, strait×', 'shipping×']);

    second.renderResults([]);
    expect(second.getElement().querySelector('#monitorsResults')?.textContent).toContain('No matches');
    expect(first.getElement().querySelector('#monitorsResults')?.textContent).toBe('');

    second.getElement().querySelector<HTMLElement>('.monitor-tag-remove')!.click();
    expect(tags(second)).toEqual([]);
    expect(first.getMonitors()).toEqual(savedMonitors);
  });
});

describe('monitor keyword matching', () => {
  function matchedTitles(keywords: string[], titles: string[]): string[] {
    const panel = createPanel([{ id: 'watch', keywords, color: '#ff0000' }]);
    document.body.append(panel.getElement());
    panel.notifyConnected();
    panel.renderResults(titles.map((title, index) => ({
      source: 'Test Wire', title, link: `https://example.com/${index}`, pubDate: new Date(), isAlert: false,
    })));
    return Array.from(panel.getElement().querySelectorAll('#monitorsResults .item-title'), item => item.textContent ?? '');
  }

  it('matches whole words in scripts beyond ASCII', () => {
    expect(matchedTitles(['россия'], ['Россия и Украина начали переговоры'])).toEqual(['Россия и Украина начали переговоры']);
    expect(matchedTitles(['ελλάδα'], ['Η Ελλάδα στέλνει φρεγάτα'])).toEqual(['Η Ελλάδα στέλνει φρεγάτα']);
    expect(matchedTitles(['بيروت'], ['غارات على بيروت'])).toEqual(['غارات على بيروت']);
    expect(matchedTitles(['bogotá'], ['Protests spread in Bogotá'])).toEqual(['Protests spread in Bogotá']);
  });

  it('matches keywords inside text written without spaces between words', () => {
    expect(matchedTitles(['台湾'], ['台湾周辺で中国軍が演習'])).toEqual(['台湾周辺で中国軍が演習']);
    expect(matchedTitles(['북한'], ['북한이 탄도미사일 발사'])).toEqual(['북한이 탄도미사일 발사']);
    expect(matchedTitles(['g7'], ['G7サミットが開幕'])).toEqual(['G7サミットが開幕']);
  });

  it('still rejects a keyword that is only part of a longer word', () => {
    expect(matchedTitles(['ai'], ['Train strike ends'])).toEqual([]);
    expect(matchedTitles(['мир'], ['Мирный договор подписан'])).toEqual([]);
  });
});
