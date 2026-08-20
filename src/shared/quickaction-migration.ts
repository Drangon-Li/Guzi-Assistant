export function shouldUpgradeQuickAction(
  currentExists: boolean,
  currentIsCurrent: boolean,
  legacyExists: boolean
): boolean {
  return legacyExists || (currentExists && !currentIsCurrent)
}
