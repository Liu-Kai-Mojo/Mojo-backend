export type BonusAcknowledgmentRecord = {
  content?: unknown;
  createdAt?: unknown;
  confirmedAt?: unknown;
};

export function isBonusAcknowledgedForContent(
  bonus: { content?: unknown } | null | undefined,
  history: BonusAcknowledgmentRecord[],
): boolean {
  const content = String(bonus?.content ?? "").trim();
  if (!content) return false;
  const latest = history
    .filter((item) => String(item.content ?? "").trim() === content)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
  return Boolean(latest?.confirmedAt);
}

export function isProcessingTask(
  task: { status?: unknown; reservedAmountCents?: unknown } | null | undefined,
): boolean {
  return String(task?.status ?? "") === "PENDING" && Number(task?.reservedAmountCents ?? 0) > 0;
}

export function combinationFundingShortfallCents(requiredCents: number, availableCents: number): number {
  const required = Number.isFinite(Number(requiredCents)) ? Math.max(0, Math.trunc(Number(requiredCents))) : 0;
  const available = Number.isFinite(Number(availableCents)) ? Math.max(0, Math.trunc(Number(availableCents))) : 0;
  return Math.max(0, required - available);
}
