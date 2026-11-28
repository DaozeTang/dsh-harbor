/**
 * Modal stacking order for Escape and focus containment.
 *
 * Every Dialog registers on mount. Only the newest one may handle Escape or
 * trap Tab: without this, pressing Escape while a confirmation sits on top of
 * a settings dialog closed both (each Dialog listened on document, and
 * stopPropagation does not affect sibling listeners on the same node).
 *
 * Pure bookkeeping so the order is testable without a DOM.
 */
const stack = [];
let sequence = 0;

/**
 * Monotone render order for one Dialog. Child dialogs render after their
 * parent, so a later number is always the visually upper one. Effects run
 * child-first, which is why the stack cannot use effect order.
 */
export function nextDialogOrder() {
  sequence += 1;
  return sequence;
}

/** Register one open dialog; returns the token its handlers compare against. */
export function enterDialog(order = 0) {
  const token = { order };
  stack.push(token);
  stack.sort((left, right) => left.order - right.order);
  return token;
}

/** Unregister a dialog; safe when the token was already removed. */
export function leaveDialog(token) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index] === token) {
      stack.splice(index, 1);
      return;
    }
  }
}

/** Whether this dialog is the one allowed to consume Escape/Tab right now. */
export function isTopDialog(token) {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** Number of open dialogs (test/teardown helper). */
export function dialogDepth() {
  return stack.length;
}

/** Drop every registration (test/plugin-teardown helper). */
export function resetDialogStack() {
  stack.length = 0;
}
