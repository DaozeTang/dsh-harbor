import assert from "node:assert/strict";
import { dialogDepth, enterDialog, isTopDialog, leaveDialog, resetDialogStack } from "../../../src/client/ui/dialog-stack.js";

resetDialogStack();
assert.equal(dialogDepth(), 0);
assert.equal(isTopDialog(Symbol("nobody")), false);

const settings = enterDialog(1);
assert.equal(isTopDialog(settings), true, "the first dialog is on top");
const confirm = enterDialog(2);
assert.equal(isTopDialog(settings), false, "a stacked dialog takes the top");
assert.equal(isTopDialog(confirm), true);

leaveDialog(confirm);
assert.equal(isTopDialog(settings), true, "closing the top hands keys back to the one below");
assert.equal(dialogDepth(), 1);

leaveDialog(settings);
assert.equal(dialogDepth(), 0);
leaveDialog(settings);
assert.equal(dialogDepth(), 0, "a double leave is harmless");

const first = enterDialog(1);
const second = enterDialog(2);
leaveDialog(first);
assert.equal(isTopDialog(second), true, "leaving a lower dialog must not disturb the top");

// A dialog rendered later can be registered first (child effects run first):
// the order number, not push order, decides which one owns Escape.
resetDialogStack();
const late = enterDialog(7);
const early = enterDialog(6);
assert.equal(isTopDialog(early), false);
assert.equal(isTopDialog(late), true);
leaveDialog(early);
assert.equal(isTopDialog(late), true);

resetDialogStack();
assert.equal(dialogDepth(), 0);
console.log("dialog stack: Escape/focus ownership follows the topmost dialog");
