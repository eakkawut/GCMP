/**
 * UI utility functions
 */

/**
 * Create DOM element
 */
export function createElement(
    tag: string,
    className: string = '',
    attributes: Record<string, unknown> = {}
): HTMLElement {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    Object.assign(element, attributes);
    return element;
}
