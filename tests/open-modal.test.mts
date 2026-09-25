import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODAL_SELECTORS,
  OPEN_MODAL_SELECTOR,
  RELOAD_BLOCKING_MODAL_SELECTOR,
  RELOAD_POLICY_ATTR,
  declareOverlay,
  findReloadBlockingModal,
  isModalOpen,
  type ModalDocumentLike,
  type VisibleElementLike,
} from '../src/utils/open-modal.ts';

// ---------------------------------------------------------------------------
// Fake document
//
// Elements carry the raw value of the reload-policy attribute (or none, which
// models third-party DOM and any gate escape). The fake applies the
// `:not([data-reload-policy="safe"])` clause itself, which is what a real DOM
// does when handed RELOAD_BLOCKING_MODAL_SELECTOR, and answers
// getAttribute(RELOAD_POLICY_ATTR) from the same value so the policy read
// sees exactly what the selector saw.
// ---------------------------------------------------------------------------

interface FakeEl {
  rendered: boolean;
  /** Raw attribute value. undefined models silence. */
  reloadPolicyAttr?: string;
  className?: string;
  role?: string;
  tagName?: string;
  /** false models Safari 17.0-17.3 / Firefox <125 (no checkVisibility). */
  supportsCheckVisibility?: boolean;
}

function makeDoc(els: FakeEl[]): ModalDocumentLike {
  return {
    querySelectorAll: (sel: string) => {
      const excludeSafe = sel === RELOAD_BLOCKING_MODAL_SELECTOR;
      return els
        .filter((e) => !(excludeSafe && e.reloadPolicyAttr === 'safe'))
        .map((e) => {
          const el: VisibleElementLike = {
            getClientRects: () => ({ length: e.rendered ? 1 : 0 }),
            className: e.className,
            tagName: e.tagName ?? 'DIV',
            getAttribute: (name: string) => {
              if (name === 'role') return e.role ?? null;
              if (name === RELOAD_POLICY_ATTR) return e.reloadPolicyAttr ?? null;
              return null;
            },
          };
          if (e.supportsCheckVisibility !== false) el.checkVisibility = () => e.rendered;
          return el as Element & VisibleElementLike;
        });
    },
  };
}

describe('OPEN_MODAL_SELECTOR / RELOAD_BLOCKING_MODAL_SELECTOR', () => {
  it('derives the reload-blocking selector from the same clause list', () => {
    const base = OPEN_MODAL_SELECTOR.split(', ');
    const blocking = RELOAD_BLOCKING_MODAL_SELECTOR.split(', ');
    assert.equal(
      blocking.length,
      base.length,
      'a clause added to one list must appear in the other — that drift is the whole reason these are derived',
    );
    for (const [i, clause] of base.entries()) {
      assert.equal(blocking[i], `${clause}:not([${RELOAD_POLICY_ATTR}="safe"])`);
    }
  });

  it('exports the clause tuple the lint gate pins against', () => {
    // The tuple exists for the gate's self-test; this keeps it from drifting
    // from the string every consumer actually queries.
    assert.equal(OPEN_MODAL_SELECTOR, MODAL_SELECTORS.join(', '));
  });

  it('still matches the Clerk backdrop, which is what #8577 turned on', () => {
    assert.ok(OPEN_MODAL_SELECTOR.includes('.cl-modalBackdrop'));
    assert.ok(RELOAD_BLOCKING_MODAL_SELECTOR.includes('.cl-modalBackdrop'));
  });
});

describe('declareOverlay', () => {
  it('writes the policy literal onto the element and nothing else', () => {
    // role and aria-modal stay the surface's own claims; the declaration is
    // one attribute, so a grep for RELOAD_POLICY_ATTR finds every contract.
    const writes: Array<[string, string]> = [];
    const el = { setAttribute: (name: string, value: string) => { writes.push([name, value]); } };
    declareOverlay(el, { reload: 'safe' });
    declareOverlay(el, { reload: 'blocking' });
    assert.deepEqual(writes, [[RELOAD_POLICY_ATTR, 'safe'], [RELOAD_POLICY_ATTR, 'blocking']]);
  });

  it('is idempotent and the last call wins', () => {
    // A surface whose contract varies by open path re-declares in each path
    // and relies on exactly this.
    const attrs = new Map<string, string>();
    const el = { setAttribute: (name: string, value: string) => { attrs.set(name, value); } };
    declareOverlay(el, { reload: 'safe' });
    declareOverlay(el, { reload: 'blocking' });
    declareOverlay(el, { reload: 'safe' });
    assert.deepEqual([...attrs.entries()], [[RELOAD_POLICY_ATTR, 'safe']]);
  });
});

describe('isModalOpen', () => {
  it('reports a rendered overlay', () => {
    assert.equal(isModalOpen(makeDoc([{ rendered: true }])), true);
  });

  it('ignores a mounted-but-hidden overlay (UnifiedSettings at rest)', () => {
    assert.equal(isModalOpen(makeDoc([{ rendered: false }])), false);
  });

  it('keeps reporting a reload-safe overlay — accessibility still sees a dialog', () => {
    // The passkey prompt must not mount under ANY overlay, declared or not.
    assert.equal(isModalOpen(makeDoc([{ rendered: true, reloadPolicyAttr: 'safe' }])), true);
  });

  it('falls back to getClientRects when checkVisibility is unavailable', () => {
    assert.equal(isModalOpen(makeDoc([{ rendered: true, supportsCheckVisibility: false }])), true);
    assert.equal(isModalOpen(makeDoc([{ rendered: false, supportsCheckVisibility: false }])), false);
  });
});

describe('findReloadBlockingModal', () => {
  it('returns null when the only overlay declared safe (WORLDMONITOR-15X / SignalModal)', () => {
    // The SignalModal auto-opens from background correlation and never
    // auto-dismisses. Treating it as work worth protecting wedged both reload
    // consumers for the session rather than the sign-up case the guard exists for.
    const doc = makeDoc([{ rendered: true, reloadPolicyAttr: 'safe', className: 'signal-modal-overlay', role: 'dialog' }]);
    assert.equal(findReloadBlockingModal(doc), null);
  });

  it('reports policy undeclared for a silent overlay', () => {
    // The legitimate Clerk deferral: third-party DOM carries no contract.
    const doc = makeDoc([{ rendered: true, className: 'cl-modalBackdrop cl-internal-a6z71v' }]);
    assert.deepEqual(findReloadBlockingModal(doc), { label: 'cl-modalBackdrop', policy: 'undeclared' });
  });

  it('reports policy blocking for an overlay that declared it', () => {
    // A wedge with this value is a declared judgment to revisit, and the
    // Sentry tag is how it is told apart from a gate escape.
    const doc = makeDoc([{ rendered: true, reloadPolicyAttr: 'blocking', className: 'modal-overlay' }]);
    assert.deepEqual(findReloadBlockingModal(doc), { label: 'modal-overlay', policy: 'blocking' });
  });

  it('treats any attribute value other than blocking as undeclared', () => {
    // 'safe' cannot reach here because the selector excluded it; anything else
    // that is not the literal 'blocking' is silence wearing a typo.
    for (const garbage of ['yes', '', 'Blocking', 'true']) {
      const doc = makeDoc([{ rendered: true, reloadPolicyAttr: garbage, className: 'modal-overlay' }]);
      assert.equal(findReloadBlockingModal(doc)?.policy, 'undeclared', `value ${JSON.stringify(garbage)}`);
    }
  });

  it('looks past a declared-safe overlay to find a silent one behind it', () => {
    const doc = makeDoc([
      { rendered: true, reloadPolicyAttr: 'safe', className: 'mission-preset-popover' },
      { rendered: true, className: 'cl-modalBackdrop' },
    ]);
    assert.deepEqual(findReloadBlockingModal(doc), { label: 'cl-modalBackdrop', policy: 'undeclared' });
  });

  it('looks past a hidden persistent overlay to find the visible one', () => {
    const doc = makeDoc([
      { rendered: false, reloadPolicyAttr: 'blocking', className: 'modal-overlay' },
      { rendered: true, className: 'cl-modalBackdrop' },
    ]);
    assert.deepEqual(findReloadBlockingModal(doc), { label: 'cl-modalBackdrop', policy: 'undeclared' });
  });

  it('returns null when nothing is rendered', () => {
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: false, className: 'modal-overlay' }])), null);
  });

  it('falls back to role, then tagName, when an overlay carries no class', () => {
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: true, role: 'dialog' }]))?.label, 'dialog');
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: true, tagName: 'DIALOG' }]))?.label, 'DIALOG');
  });

  it('sanitises and bounds the label — it ships as a Sentry tag', () => {
    const doc = makeDoc([{ rendered: true, className: '🔒️weird/class name' }]);
    assert.equal(findReloadBlockingModal(doc)?.label, 'weirdclass', 'strips anything outside [A-Za-z0-9_-]');

    const long = makeDoc([{ rendered: true, className: 'a'.repeat(120) }]);
    assert.equal(findReloadBlockingModal(long)?.label.length, 40, 'truncates so tag cardinality stays bounded');
  });

  it('never returns an empty label', () => {
    // A class of only stripped characters must not produce '' — an empty tag
    // reads as "no overlay" to anyone querying Sentry by blocked_by.
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: true, className: '🔒️' }]))?.label, 'unknown');
  });
});
