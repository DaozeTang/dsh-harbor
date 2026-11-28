/**
 * Server groups: disclosure state.
 *
 * Groups are a navigational aid, so the contract is small and behavioural: a
 * header is a real button that reports its state, groups start open (a collapsed
 * default hides the inventory the page exists to show), a search expands
 * everything it matched, and an ungrouped bucket exists for resources outside
 * any group. Asserted on the source because the page renders inside DSH's
 * settings column, which this suite cannot boot.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/client/features/resources/HarborResources.jsx", import.meta.url), "utf8");

assert.match(
  source,
  /const \[collapsedGroups, setCollapsedGroups\] = useState\(\(\) => new Set\(\)\)/,
  "groups start expanded: the collapsed set is empty"
);
assert.match(source, /const toggleGroup = \(key\) =>/, "each group owns a collapse toggle");
assert.match(
  source,
  /const collapsed = !query && collapsedGroups\.has\(key\)/,
  "a search overrides manual collapse so matches are never hidden"
);
assert.match(
  source,
  /<button type="button" className="hb-settings-group__head" onClick=\{\(\) => toggleGroup\(key\)\} aria-expanded=\{!collapsed\}>/,
  "the group header is a button that reports its expansion state"
);
assert.match(
  source,
  /name=\{collapsed \? "chevron-right-outline" : "chevron-down-outline"\}/,
  "the header glyph follows the state with the host's own chevron"
);
assert.match(source, /key=\{group\.groupId\}/, "saved groups have stable keys");
assert.match(source, /const key = "ungrouped"/, "ungrouped resources get their own collapsible bucket");

console.log("resource group collapse: disclosure, search override and ungrouped bucket passed");
