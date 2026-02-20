export function batchAppend(parent: Node, nodes: Iterable<Node>): void {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    fragment.appendChild(node);
  }
  parent.appendChild(fragment);
}

export function batchReplaceChildren(parent: Element, nodes: Iterable<Node>): void {
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    fragment.appendChild(node);
  }
  parent.replaceChildren(fragment);
}
