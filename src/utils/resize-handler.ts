import { ROW_RESIZE_STEP_PX, COL_RESIZE_STEP_PX } from './resize-utils';

export interface ResizeHandlerOptions {
  id: string;
  element: HTMLElement;
  handle: HTMLElement;
  type: 'row' | 'col';
  onResizeStart?: () => void;
  onResizeMove?: (newSpan: number) => void;
  onResizeEnd?: (finalSpan: number) => void;
  getStartSpan: () => number;
  setSpanClass: (span: number) => void;
  maxSpan?: number;
}

export class ResizeHandler {
  private isResizing = false;
  private startCoord = 0;
  private startSpan = 1;
  private rafId: number | null = null;

  private onMouseMoveBound: (e: MouseEvent) => void;
  private onMouseUpBound: () => void;
  private onTouchMoveBound: (e: TouchEvent) => void;
  private onTouchEndBound: () => void;
  private onMouseDownBound: (e: MouseEvent) => void;
  private onTouchStartBound: (e: TouchEvent) => void;

  constructor(private options: ResizeHandlerOptions) {
    this.onMouseMoveBound = this.onMouseMove.bind(this);
    this.onMouseUpBound = this.onMouseUp.bind(this);
    this.onTouchMoveBound = this.onTouchMove.bind(this);
    this.onTouchEndBound = this.onTouchEnd.bind(this);
    this.onMouseDownBound = this.onMouseDown.bind(this);
    this.onTouchStartBound = this.onTouchStart.bind(this);

    this.init();
  }

  private init(): void {
    this.options.handle.addEventListener('mousedown', this.onMouseDownBound);
    this.options.handle.addEventListener('touchstart', this.onTouchStartBound, { passive: false });
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return; // Only primary button
    e.preventDefault();
    e.stopPropagation();
    this.startResize(this.options.type === 'row' ? e.clientY : e.clientX);
    
    document.addEventListener('mousemove', this.onMouseMoveBound);
    document.addEventListener('mouseup', this.onMouseUpBound);
    window.addEventListener('blur', this.onMouseUpBound);
  }

  private onTouchStart(e: TouchEvent): void {
    const touch = e.touches[0];
    if (!touch) return;
    e.preventDefault();
    e.stopPropagation();
    this.startResize(this.options.type === 'row' ? touch.clientY : touch.clientX);

    document.addEventListener('touchmove', this.onTouchMoveBound, { passive: false });
    document.addEventListener('touchend', this.onTouchEndBound);
    document.addEventListener('touchcancel', this.onTouchEndBound);
  }

  private startResize(coord: number): void {
    this.isResizing = true;
    this.startCoord = coord;
    this.startSpan = this.options.getStartSpan();
    
    this.options.element.dataset.resizing = 'true';
    this.options.element.classList.add(this.options.type === 'row' ? 'resizing' : 'col-resizing');
    document.body.classList.add('panel-resize-active');
    this.options.handle.classList.add('active');
    
    this.options.onResizeStart?.();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isResizing) return;
    this.scheduleUpdate(this.options.type === 'row' ? e.clientY : e.clientX);
  }

  private onTouchMove(e: TouchEvent): void {
    if (!this.isResizing) return;
    const touch = e.touches[0];
    if (!touch) return;
    this.scheduleUpdate(this.options.type === 'row' ? touch.clientY : touch.clientX);
  }

  private scheduleUpdate(coord: number): void {
    if (this.rafId !== null) return; // Already scheduled
    
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (!this.isResizing) return;

      const delta = coord - this.startCoord;
      const step = this.options.type === 'row' ? ROW_RESIZE_STEP_PX : COL_RESIZE_STEP_PX;
      const spanDelta = delta > 0 ? Math.floor(delta / step) : Math.ceil(delta / step);
      
      let newSpan = this.startSpan + spanDelta;
      if (this.options.type === 'row') {
        newSpan = Math.max(1, Math.min(4, newSpan));
      } else {
        const max = this.options.maxSpan ?? 3;
        newSpan = Math.max(1, Math.min(max, newSpan));
      }
      
      this.options.setSpanClass(newSpan);
      this.options.onResizeMove?.(newSpan);
    });
  }

  private onMouseUp(): void {
    this.endResize();
    document.removeEventListener('mousemove', this.onMouseMoveBound);
    document.removeEventListener('mouseup', this.onMouseUpBound);
    window.removeEventListener('blur', this.onMouseUpBound);
  }

  private onTouchEnd(): void {
    this.endResize();
    document.removeEventListener('touchmove', this.onTouchMoveBound);
    document.removeEventListener('touchend', this.onTouchEndBound);
    document.removeEventListener('touchcancel', this.onTouchEndBound);
  }

  private endResize(): void {
    if (!this.isResizing) return;
    this.isResizing = false;
    
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.options.element.classList.remove('resizing', 'col-resizing');
    delete this.options.element.dataset.resizing;
    document.body.classList.remove('panel-resize-active');
    this.options.handle.classList.remove('active');

    const finalSpan = this.options.getStartSpan(); // get current span
    this.options.onResizeEnd?.(finalSpan);
  }

  public destroy(): void {
    this.endResize();
    this.options.handle.removeEventListener('mousedown', this.onMouseDownBound);
    this.options.handle.removeEventListener('touchstart', this.onTouchStartBound);
    
    document.removeEventListener('mousemove', this.onMouseMoveBound);
    document.removeEventListener('mouseup', this.onMouseUpBound);
    window.removeEventListener('blur', this.onMouseUpBound);
    document.removeEventListener('touchmove', this.onTouchMoveBound);
    document.removeEventListener('touchend', this.onTouchEndBound);
    document.removeEventListener('touchcancel', this.onTouchEndBound);
  }
}
