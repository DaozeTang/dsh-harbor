/**
 * English dictionary, composed from one file per area plus the historical
 * base. Keeping areas apart means two people can add wording without editing
 * the same object, and a screen's vocabulary can be reviewed next to its code.
 *
 * Lookup is exact-match first and pattern-based second (see core.js), so the
 * merge order only matters for duplicate keys — the base wins, because it is
 * the reviewed wording for strings that predate the split.
 */
import { en as base } from "../messages.en.js";
import { en as workspace } from "./en-workspace.js";
import { en as files } from "./en-files.js";
import { en as operations } from "./en-operations.js";
import { en as settings } from "./en-settings.js";

export const en = {
 ...workspace,
 ...files,
 ...operations,
 ...settings,
 ...base
};
