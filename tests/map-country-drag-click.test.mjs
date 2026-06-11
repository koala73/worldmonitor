import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRY_CLICK_DRAG_SUPPRESSION_MS,
  COUNTRY_CLICK_DRAG_THRESHOLD_PX,
  createCountryClickGestureTracker,
  finishCountryClickGesture,
  markCountryClickDrag,
  refreshCountryClickDragSuppression,
  shouldSuppressCountryClick,
  startCountryClickGesture,
  updateCountryClickGestureDrag,
} from '../src/components/map-interaction-guard.ts';

describe('map country drag/click guard', () => {
  it('keeps sub-threshold pointer jitter as an intentional country click', () => {
    const tracker = createCountryClickGestureTracker();
    startCountryClickGesture(tracker, { x: 100, y: 100 });

    assert.equal(
      updateCountryClickGestureDrag(tracker, { x: 100 + COUNTRY_CLICK_DRAG_THRESHOLD_PX - 1, y: 100 }, 10),
      false,
    );

    finishCountryClickGesture(tracker, 20);
    assert.equal(shouldSuppressCountryClick(tracker, 21), false);
  });

  it('suppresses exactly one country click after a real drag gesture', () => {
    const tracker = createCountryClickGestureTracker();
    startCountryClickGesture(tracker, { x: 100, y: 100 });

    assert.equal(
      updateCountryClickGestureDrag(tracker, { x: 100 + COUNTRY_CLICK_DRAG_THRESHOLD_PX + 1, y: 100 }, 10),
      true,
    );
    finishCountryClickGesture(tracker, 20);

    assert.equal(shouldSuppressCountryClick(tracker, 21), true);
    assert.equal(shouldSuppressCountryClick(tracker, 22), false);
  });

  it('does not suppress a later intentional country click after the drag window expires', () => {
    const tracker = createCountryClickGestureTracker();
    markCountryClickDrag(tracker, 100);

    assert.equal(
      shouldSuppressCountryClick(tracker, 100 + COUNTRY_CLICK_DRAG_SUPPRESSION_MS + 1),
      false,
    );
  });

  it('preserves suppression across a rapid gesture restart after a drag', () => {
    const tracker = createCountryClickGestureTracker();
    markCountryClickDrag(tracker, 100);

    startCountryClickGesture(tracker, { x: 25, y: 25 });
    finishCountryClickGesture(tracker, 110);

    assert.equal(shouldSuppressCountryClick(tracker, 111), true);
  });

  it('refreshes dragend suppression without leaving stale dragged state', () => {
    const tracker = createCountryClickGestureTracker();
    startCountryClickGesture(tracker, { x: 100, y: 100 });
    updateCountryClickGestureDrag(tracker, { x: 100 + COUNTRY_CLICK_DRAG_THRESHOLD_PX + 1, y: 100 }, 10);
    finishCountryClickGesture(tracker, 20);

    refreshCountryClickDragSuppression(tracker, 25);

    assert.equal(tracker.pointerStart, null);
    assert.equal(tracker.dragged, false);
    assert.equal(shouldSuppressCountryClick(tracker, 26), true);
  });
});
