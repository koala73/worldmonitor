import { Window } from 'happy-dom';

function removeComments(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8) {
      child.remove();
    } else {
      removeComments(child);
    }
  }
}

export function crawlerDocumentSnapshot(html) {
  const window = new Window({
    url: 'https://www.worldmonitor.app/pro',
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });

  try {
    window.document.write(String(html));

    const roots = window.document.querySelectorAll('#root');
    if (roots.length !== 1) {
      throw new Error(`crawler document must contain exactly one #root element; found ${roots.length}`);
    }

    const visibleRoot = roots[0].cloneNode(true);
    for (const inert of visibleRoot.querySelectorAll('script, style, noscript, template')) {
      inert.remove();
    }
    removeComments(visibleRoot);

    const headRobotsContents = [...window.document.head.querySelectorAll('meta[name]')]
      .filter((meta) => meta.getAttribute('name')?.trim().toLowerCase() === 'robots')
      .map((meta) => meta.getAttribute('content') ?? '');

    return Object.freeze({
      visibleRootMarkup: visibleRoot.outerHTML,
      headRobotsContents: Object.freeze(headRobotsContents),
    });
  } finally {
    window.close();
  }
}
