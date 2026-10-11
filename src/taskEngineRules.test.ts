import test from "node:test";
import assert from "node:assert/strict";
import {
  combinationFundingShortfallCents,
  isBonusAcknowledgedForContent,
  isProcessingTask,
} from "./taskEngineRules.js";

test("bonus acknowledgment is scoped to the latest notification with matching content", () => {
  const bonus = { content: "Weekend bonus" };
  assert.equal(isBonusAcknowledgedForContent(bonus, []), false);
  assert.equal(isBonusAcknowledgedForContent(bonus, [
    { content: "Weekend bonus", createdAt: "2026-10-01T00:00:00.000Z", confirmedAt: "2026-10-01T00:01:00.000Z" },
    { content: "Other bonus", createdAt: "2026-10-02T00:00:00.000Z" },
  ]), true);
  assert.equal(isBonusAcknowledgedForContent(bonus, [
    { content: "Weekend bonus", createdAt: "2026-10-01T00:00:00.000Z", confirmedAt: "2026-10-01T00:01:00.000Z" },
    { content: "Weekend bonus", createdAt: "2026-10-03T00:00:00.000Z" },
  ]), false);
});

test("only a reserved pending task counts as Processing", () => {
  assert.equal(isProcessingTask({ status: "PENDING", reservedAmountCents: 5000 }), true);
  assert.equal(isProcessingTask({ status: "PENDING", reservedAmountCents: 0 }), false);
  assert.equal(isProcessingTask({ status: "COMPLETED", reservedAmountCents: 5000 }), false);
  assert.equal(isProcessingTask(null), false);
});

test("combination funding shortfall preserves the exact configured requirement", () => {
  assert.equal(combinationFundingShortfallCents(25000, 10000), 15000);
  assert.equal(combinationFundingShortfallCents(25000, 25000), 0);
  assert.equal(combinationFundingShortfallCents(25000, 40000), 0);
  assert.equal(combinationFundingShortfallCents(25000, -500), 25000);
});
