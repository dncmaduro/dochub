import { describe, expect, it } from "vitest";
import { discardSavedEdits } from "../src/spreadsheet-editor/editor-state";

describe("spreadsheet save rebase", () => {
  it("keeps only edits made after the save snapshot", () => {
    const saved = { "sheet-1\u0000A1": "saved", "sheet-1\u0000B1": 2 };
    const current = { "sheet-1\u0000A1": "saved", "sheet-1\u0000B1": 3, "sheet-1\u0000C1": "later" };

    expect(discardSavedEdits(current, saved)).toEqual({ "sheet-1\u0000B1": 3, "sheet-1\u0000C1": "later" });
  });
});
