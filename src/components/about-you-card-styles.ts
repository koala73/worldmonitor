/**
 * Styles for the About-you card (src/components/AboutYouCard.ts), injected by
 * the lazy chunk so none of this ships in the dashboard stylesheet. A string
 * module rather than a `?inline` CSS import so esbuild-bundled tests can load
 * the card. Logical properties keep it docked to the reading-start edge in RTL.
 */
export const ABOUT_YOU_CARD_CSS = `
/* Quiet chrome on the dashboard's own neutrals; the one accent is the signal
   green, used only for the chosen answer and the step meter. 4px grid. */
.about-you-card {
  position: fixed;
  inset-block-end: 16px;
  inset-inline-start: 16px;
  z-index: 4000; /* above panels, below the mission picker and modals */
  box-sizing: border-box;
  width: min(360px, calc(100vw - 32px));
  /* A short desktop window must not push the close button off the top. */
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32);
  font-size: 12px;
  line-height: 1.5;
  animation: about-you-card-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes about-you-card-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

.about-you-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.about-you-card__title {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 500;
}

.about-you-card__close {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-inline-end: -4px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.about-you-card__close:hover {
  background: var(--overlay-light);
  color: var(--text);
}

/* Signature: a segmented step meter, read like a signal-strength bar. */
.about-you-card__progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.about-you-card__progress[hidden] {
  display: none;
}

.about-you-card__meter {
  display: flex;
  flex: 1;
  gap: 4px;
}

.about-you-card__segment {
  flex: 1;
  height: 2px;
  border-radius: 1px;
  background: var(--overlay-medium);
  transition: background-color 200ms ease;
}

.about-you-card__segment[data-state='done'],
.about-you-card__segment[data-state='current'] {
  background: var(--green);
}

.about-you-card__segment[data-state='current'] {
  opacity: 0.55;
}

.about-you-card__count {
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.about-you-card__question {
  display: block;
  margin: 16px 0 12px;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
}

.about-you-card__options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.about-you-card__option,
.about-you-card__done,
.about-you-card__skip,
.about-you-card__retry {
  box-sizing: border-box;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.about-you-card__option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  background: var(--overlay-subtle);
  color: var(--text-secondary, var(--text));
}

.about-you-card__option:hover {
  border-color: var(--border-strong);
  background: var(--overlay-light);
  color: var(--text);
}

.about-you-card__option:active {
  transform: scale(0.98);
}

.about-you-card__option[aria-pressed='true'] {
  border-color: var(--green);
  color: var(--green-text, var(--green));
}

/* A drawn check, so the chosen answer reads at a glance. */
.about-you-card__option[aria-pressed='true']::before {
  content: '';
  width: 8px;
  height: 4px;
  margin-top: -2px;
  border-inline-start: 1.5px solid currentColor;
  border-block-end: 1.5px solid currentColor;
  transform: rotate(-45deg);
}

/* Long lists (primary use, role) sit in two even columns so the card stays
   short over the map. */
.about-you-card__options[data-layout='grid'] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.about-you-card__options[data-layout='grid'] .about-you-card__option {
  padding-block: 6px;
  text-align: start;
  line-height: 1.35;
}

.about-you-card__options[aria-busy='true'] .about-you-card__option {
  cursor: progress;
}

.about-you-card__option:focus-visible,
.about-you-card__close:focus-visible,
.about-you-card__done:focus-visible,
.about-you-card__skip:focus-visible,
.about-you-card__retry:focus-visible,
.about-you-card__text:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}

.about-you-card__text {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--overlay-subtle);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  resize: vertical;
}

.about-you-card__text::placeholder {
  color: var(--text-muted);
}

.about-you-card__done {
  margin-top: 12px;
  border: 0;
  background: var(--green);
  color: #0a0a0a;
  font-weight: 500;
}

.about-you-card__done:hover {
  filter: brightness(1.08);
}

.about-you-card__status {
  margin: 12px 0 0;
  color: var(--text-dim);
}

/* Collapsed, not display:none: a live region must stay in the accessibility
   tree before text is written into it, or "Saving…" and "Thanks" go unread. */
.about-you-card__status:empty {
  height: 0;
  margin: 0;
  overflow: hidden;
}

.about-you-card__retry {
  min-height: 24px;
  margin-inline-start: 8px;
  padding: 0 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
}

.about-you-card__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.about-you-card__footer:empty {
  display: none;
}

.about-you-card__skip {
  min-height: 28px;
  margin-inline-end: -8px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
}

.about-you-card__skip:hover {
  color: var(--text);
}

@media (prefers-reduced-motion: reduce) {
  .about-you-card { animation: none; }
}

/* Touch screens get 44px targets. */
@media (pointer: coarse) {
  .about-you-card__option,
  .about-you-card__done,
  .about-you-card__skip {
    min-height: 44px;
  }
}

/* Phones: a bottom sheet that never takes more than 40% of the screen, so the
   map stays usable above it. It sits on top of the fixed .mobile-tab-bar
   (--wm-bottom-base, which already includes the safe-area inset), not under
   it, so its last option and Skip are never hidden. */
@media (max-width: 768px) {
  .about-you-card {
    inset-block-end: var(--wm-bottom-base, 0px);
    inset-inline: 0;
    width: auto;
    max-height: 40vh;
    overflow-y: auto;
    border-radius: 12px 12px 0 0;
    border-block-end: 0;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.24);
  }
}
`;
