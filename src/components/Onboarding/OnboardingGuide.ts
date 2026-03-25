/**
 * Onboarding Guide Component
 *
 * Displays a 3-step guide for new users on first visit.
 * Steps: Map interaction → Layer controls → News panel
 * Can be skipped via button or ESC key.
 */

// Storage key for tracking guide completion
export const ONBOARDING_KEY = 'wm-onboarding-seen';

// Step durations in milliseconds
export const STEP_DURATIONS = [2000, 2000, 1000] as const;

// Total number of steps
export const TOTAL_STEPS = 3;

/**
 * Step content configuration
 */
export interface OnboardingStep {
  title: string;
  description: string;
  icon: string;
  position: 'center' | 'left' | 'right';
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: 'Explore the Map',
    description: 'Drag to pan • Scroll to zoom • Click markers for details',
    icon: '🗺️',
    position: 'center',
  },
  {
    title: 'Toggle Layers',
    description: 'Filter by category: Startups, Tech HQs, Data Centers...',
    icon: '📂',
    position: 'left',
  },
  {
    title: 'Latest News',
    description: 'Real-time updates from Irish tech ecosystem',
    icon: '📰',
    position: 'right',
  },
];

let overlayEl: HTMLElement | null = null;
let currentStep = 0;
let stepTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Check if user has already seen the onboarding guide
 */
export function hasSeenOnboarding(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === 'true';
}

/**
 * Mark onboarding as completed
 */
function markOnboardingComplete(): void {
  localStorage.setItem(ONBOARDING_KEY, 'true');
}

/**
 * Create step tooltip HTML
 */
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
        <span class="onboarding-progress">${stepIndex + 1} / ${TOTAL_STEPS}</span>
        <button class="onboarding-skip">Skip (Esc)</button>
      </div>
    </div>
  `;
}

/**
 * Advance to the next step or complete
 */
function nextStep(): void {
  if (currentStep < TOTAL_STEPS - 1) {
    currentStep++;
    renderCurrentStep();
    scheduleNextStep();
  } else {
    completeOnboarding();
  }
}

/**
 * Schedule auto-advance to next step
 */
function scheduleNextStep(): void {
  if (stepTimer) {
    clearTimeout(stepTimer);
  }
  stepTimer = setTimeout(nextStep, STEP_DURATIONS[currentStep]);
}

/**
 * Render the current step
 */
function renderCurrentStep(): void {
  if (!overlayEl) return;

  const step = ONBOARDING_STEPS[currentStep];
  if (!step) return;

  const tooltip = overlayEl.querySelector('.onboarding-tooltip');
  if (tooltip) {
    tooltip.classList.add('onboarding-out');
    setTimeout(() => {
      overlayEl!.innerHTML = createStepHTML(step, currentStep);
      attachSkipHandler();
      requestAnimationFrame(() => {
        overlayEl!.querySelector('.onboarding-tooltip')?.classList.add('onboarding-in');
      });
    }, 300);
  } else {
    overlayEl.innerHTML = createStepHTML(step, currentStep);
    attachSkipHandler();
    requestAnimationFrame(() => {
      overlayEl!.querySelector('.onboarding-tooltip')?.classList.add('onboarding-in');
    });
  }
}

/**
 * Attach click handler to skip button
 */
function attachSkipHandler(): void {
  const skipBtn = overlayEl?.querySelector('.onboarding-skip');
  if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      completeOnboarding();
    });
  }
}

/**
 * Handle ESC key to skip
 */
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    completeOnboarding();
  }
}

/**
 * Complete onboarding and cleanup
 */
function completeOnboarding(): void {
  if (stepTimer) {
    clearTimeout(stepTimer);
    stepTimer = null;
  }

  document.removeEventListener('keydown', handleKeydown);

  if (overlayEl) {
    const tooltip = overlayEl.querySelector('.onboarding-tooltip');
    if (tooltip) {
      tooltip.classList.add('onboarding-out');
    }
    overlayEl.classList.add('onboarding-overlay-out');

    setTimeout(() => {
      overlayEl?.remove();
      overlayEl = null;
    }, 300);
  }

  markOnboardingComplete();
  currentStep = 0;
}

/**
 * Show the onboarding guide if not seen before
 */
export function showOnboarding(container: HTMLElement): void {
  // Skip if already seen or in iframe
  if (hasSeenOnboarding()) return;
  if (window.self !== window.top) return;
  if (overlayEl) return;

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';

  container.appendChild(overlay);
  overlayEl = overlay;

  // Add ESC key listener
  document.addEventListener('keydown', handleKeydown);

  // Start with step 0
  currentStep = 0;
  renderCurrentStep();
  scheduleNextStep();

  // Fade in overlay
  requestAnimationFrame(() => {
    overlay.classList.add('onboarding-overlay-in');
  });
}

/**
 * Hide onboarding immediately (for programmatic use)
 */
export function hideOnboarding(): void {
  if (overlayEl) {
    completeOnboarding();
  }
}

/**
 * Check if onboarding is currently visible
 */
export function isOnboardingVisible(): boolean {
  return overlayEl !== null;
}

/**
 * Reset onboarding state (for testing or re-showing)
 */
export function resetOnboarding(): void {
  localStorage.removeItem(ONBOARDING_KEY);
}
