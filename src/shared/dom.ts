/**
 * Recursively find all elements matching a selector, traversing open Shadow DOMs.
 * This is crucial for modern SPAs (like Reddit and Web Component frameworks)
 * where traditional document.querySelectorAll fails to pierce component boundaries.
 */
export function deepQuerySelectorAll<T extends Element>(selector: string, root: Document | Element | ShadowRoot = document): T[] {
  const elements = Array.from(root.querySelectorAll<T>(selector));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof Element && currentNode.shadowRoot) {
      elements.push(...deepQuerySelectorAll<T>(selector, currentNode.shadowRoot));
    }
    currentNode = walker.nextNode();
  }
  return elements;
}
