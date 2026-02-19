/**
 * PERF-010: DOM update utilities — efficient DOM manipulation patterns
 * to avoid layout thrashing and minimize reflows.
 *
 * PERF-011: DocumentFragment batch rendering.
 * PERF-012: Avoid forced layout reads (getBoundingClientRect, offsetHeight, etc.)
 */

/**
 * PERF-011: Batch multiple DOM elements into a DocumentFragment,
 * then append once to minimize reflows.
 */
export function batchAppend(
    parent: HTMLElement,
    children: HTMLElement[],
): void {
    const fragment = document.createDocumentFragment();
    for (const child of children) {
        fragment.appendChild(child);
    }
    parent.appendChild(fragment);
}

/**
 * PERF-011: Batch replace children — clears parent and appends new children
 * in a single operation using DocumentFragment.
 */
export function batchReplaceChildren(
    parent: HTMLElement,
    children: HTMLElement[],
): void {
    const fragment = document.createDocumentFragment();
    for (const child of children) {
        fragment.appendChild(child);
    }
    parent.textContent = ''; // Fast clear
    parent.appendChild(fragment);
}

/**
 * PERF-012: Schedule a layout read to happen after all current writes.
 * Prevents the read-write-read-write pattern that causes forced synchronous layouts.
 */
export function scheduleRead(fn: () => void): void {
    requestAnimationFrame(() => {
        // The RAF callback fires just before the browser's layout/paint,
        // so reads here won't force additional layouts.
        fn();
    });
}

/**
 * PERF-012: Schedule a DOM write to happen in the next animation frame.
 */
export function scheduleWrite(fn: () => void): void {
    requestAnimationFrame(fn);
}

/**
 * PERF-010: Diff and update text content only if it changed.
 * Avoids unnecessary DOM mutations and associated style recalculations.
 */
export function updateTextContent(element: HTMLElement | null, text: string): boolean {
    if (!element) return false;
    if (element.textContent !== text) {
        element.textContent = text;
        return true;
    }
    return false;
}

/**
 * PERF-010: Diff and update innerHTML only if it changed.
 */
export function updateInnerHTML(element: HTMLElement | null, html: string): boolean {
    if (!element) return false;
    if (element.innerHTML !== html) {
        element.innerHTML = html;
        return true;
    }
    return false;
}

/**
 * PERF-010: Toggle a class only if the state actually changed.
 * Returns true if the class was toggled.
 */
export function toggleClass(element: HTMLElement | null, className: string, force: boolean): boolean {
    if (!element) return false;
    const has = element.classList.contains(className);
    if (has === force) return false;
    element.classList.toggle(className, force);
    return true;
}

/**
 * PERF-010: Create an element with attributes in one call
 * to avoid multiple setAttribute calls.
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string>,
    textContent?: string,
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (key === 'className') {
                el.className = value;
            } else {
                el.setAttribute(key, value);
            }
        }
    }
    if (textContent) {
        el.textContent = textContent;
    }
    return el;
}
