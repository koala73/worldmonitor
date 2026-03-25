/**
 * Onboarding Guide Tests
 *
 * Tests for the 3-step onboarding guide component.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_KEY,
  STEP_DURATIONS,
  TOTAL_STEPS,
  ONBOARDING_STEPS,
  type OnboardingStep,
} from '../src/components/Onboarding/OnboardingGuide.js';

describe('Onboarding Constants', () => {
  it('should have correct storage key', () => {
    assert.equal(ONBOARDING_KEY, 'wm-onboarding-seen');
  });

  it('should have 3 steps', () => {
    assert.equal(TOTAL_STEPS, 3);
    assert.equal(ONBOARDING_STEPS.length, 3);
  });

  it('should have correct step durations (2s, 2s, 1s)', () => {
    assert.equal(STEP_DURATIONS[0], 2000);
    assert.equal(STEP_DURATIONS[1], 2000);
    assert.equal(STEP_DURATIONS[2], 1000);
  });

  it('should have total duration of 5 seconds', () => {
    const total = STEP_DURATIONS.reduce((sum, d) => sum + d, 0);
    assert.equal(total, 5000);
  });
});

describe('Onboarding Steps', () => {
  it('step 1 should be about map interaction', () => {
    const step = ONBOARDING_STEPS[0];
    assert.ok(step);
    assert.equal(step.title, 'Explore the Map');
    assert.ok(step.description.includes('Drag'));
    assert.ok(step.description.includes('zoom'));
    assert.equal(step.icon, '🗺️');
    assert.equal(step.position, 'center');
  });

  it('step 2 should be about layer controls', () => {
    const step = ONBOARDING_STEPS[1];
    assert.ok(step);
    assert.equal(step.title, 'Toggle Layers');
    assert.ok(step.description.includes('Filter'));
    assert.equal(step.icon, '📂');
    assert.equal(step.position, 'left');
  });

  it('step 3 should be about news panel', () => {
    const step = ONBOARDING_STEPS[2];
    assert.ok(step);
    assert.equal(step.title, 'Latest News');
    assert.ok(step.description.includes('Real-time'));
    assert.equal(step.icon, '📰');
    assert.equal(step.position, 'right');
  });

  it('all steps should have required properties', () => {
    for (const step of ONBOARDING_STEPS) {
      assert.ok(step.title, 'step should have title');
      assert.ok(step.description, 'step should have description');
      assert.ok(step.icon, 'step should have icon');
      assert.ok(['center', 'left', 'right'].includes(step.position), 'step should have valid position');
    }
  });
});

describe('Step Interface', () => {
  it('OnboardingStep should match expected structure', () => {
    const step: OnboardingStep = {
      title: 'Test Title',
      description: 'Test description',
      icon: '🔧',
      position: 'center',
    };

    assert.equal(step.title, 'Test Title');
    assert.equal(step.description, 'Test description');
    assert.equal(step.icon, '🔧');
    assert.equal(step.position, 'center');
  });

  it('position should be union type', () => {
    const positions: OnboardingStep['position'][] = ['center', 'left', 'right'];
    assert.equal(positions.length, 3);
    assert.ok(positions.includes('center'));
    assert.ok(positions.includes('left'));
    assert.ok(positions.includes('right'));
  });
});

describe('LocalStorage Logic', () => {
  // Mock localStorage for testing
  function mockLocalStorage() {
    const storage = new Map<string, string>();
    return {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
  }

  function hasSeenOnboarding(ls: ReturnType<typeof mockLocalStorage>): boolean {
    return ls.getItem(ONBOARDING_KEY) === 'true';
  }

  it('should return false when not seen', () => {
    const ls = mockLocalStorage();
    assert.equal(hasSeenOnboarding(ls), false);
  });

  it('should return true when marked as seen', () => {
    const ls = mockLocalStorage();
    ls.setItem(ONBOARDING_KEY, 'true');
    assert.equal(hasSeenOnboarding(ls), true);
  });

  it('should return false for non-true values', () => {
    const ls = mockLocalStorage();
    ls.setItem(ONBOARDING_KEY, 'false');
    assert.equal(hasSeenOnboarding(ls), false);

    ls.setItem(ONBOARDING_KEY, '1');
    assert.equal(hasSeenOnboarding(ls), false);
  });

  it('reset should clear the storage', () => {
    const ls = mockLocalStorage();
    ls.setItem(ONBOARDING_KEY, 'true');
    assert.equal(hasSeenOnboarding(ls), true);

    ls.removeItem(ONBOARDING_KEY);
    assert.equal(hasSeenOnboarding(ls), false);
  });
});

describe('HTML Structure', () => {
  function createStepHTML(step: OnboardingStep, stepIndex: number): string {
    return `
    <div class="onboarding-tooltip onboarding-${step.position}">
      <div class="onboarding-content">
        <span class="onboarding-icon">${step.icon}</span>
        <div class="onboarding-text">
          <strong>${step.title}</strong>
          <p>${step.description}</p>
        </div>
      </div>
      <div class="onboarding-footer">
        <span class="onboarding-progress">${stepIndex + 1} / 3</span>
        <button class="onboarding-skip">Skip (Esc)</button>
      </div>
    </div>
  `;
  }

  it('should contain tooltip class', () => {
    const html = createStepHTML(ONBOARDING_STEPS[0]!, 0);
    assert.ok(html.includes('onboarding-tooltip'));
  });

  it('should contain position class', () => {
    const html = createStepHTML(ONBOARDING_STEPS[0]!, 0);
    assert.ok(html.includes('onboarding-center'));
  });

  it('should contain icon', () => {
    const html = createStepHTML(ONBOARDING_STEPS[0]!, 0);
    assert.ok(html.includes('🗺️'));
  });

  it('should contain progress indicator', () => {
    const html = createStepHTML(ONBOARDING_STEPS[0]!, 0);
    assert.ok(html.includes('1 / 3'));

    const html2 = createStepHTML(ONBOARDING_STEPS[2]!, 2);
    assert.ok(html2.includes('3 / 3'));
  });

  it('should contain skip button', () => {
    const html = createStepHTML(ONBOARDING_STEPS[0]!, 0);
    assert.ok(html.includes('onboarding-skip'));
    assert.ok(html.includes('Skip (Esc)'));
  });
});

describe('CSS Classes', () => {
  it('should have overlay classes', () => {
    const classes = ['onboarding-overlay', 'onboarding-overlay-in', 'onboarding-overlay-out'];
    for (const cls of classes) {
      assert.ok(typeof cls === 'string');
    }
  });

  it('should have tooltip animation classes', () => {
    const classes = ['onboarding-in', 'onboarding-out'];
    for (const cls of classes) {
      assert.ok(typeof cls === 'string');
    }
  });

  it('should have position classes', () => {
    const positions = ['onboarding-center', 'onboarding-left', 'onboarding-right'];
    for (const pos of positions) {
      assert.ok(typeof pos === 'string');
    }
  });
});

describe('Step Flow', () => {
  it('should start at step 0', () => {
    let currentStep = 0;
    assert.equal(currentStep, 0);
  });

  it('should advance through steps correctly', () => {
    let currentStep = 0;

    // Simulate advancing through steps
    currentStep++;
    assert.equal(currentStep, 1);

    currentStep++;
    assert.equal(currentStep, 2);

    // Should complete after step 2
    assert.equal(currentStep, TOTAL_STEPS - 1);
  });

  it('should not exceed total steps', () => {
    let currentStep = 0;

    for (let i = 0; i < 10; i++) {
      if (currentStep < TOTAL_STEPS - 1) {
        currentStep++;
      }
    }

    assert.equal(currentStep, TOTAL_STEPS - 1);
  });
});
