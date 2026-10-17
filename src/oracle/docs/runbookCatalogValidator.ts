export const REQUIRED_RUNBOOK_SCENARIOS = [
  "FEED_STALE",
  "SOURCE_DIVERGENCE",
  "CIRCUIT_BREAKER_TRIP",
  "COMPROMISED_SOURCE",
  "RESTORE_FROM_PAUSE",
] as const;

export const REQUIRED_INVENTORY_FEEDS = [
  "USDC-DEPEG",
  "PROTOCOL-TVL-DROP",
  "VALIDATOR-SLASHER",
  "LIQUIDATION-SHIELD",
  "FLIGHT-DELAY",
] as const;

export function validateRunbookMarkdownContent(markdown: string): {
  valid: boolean;
  missingScenarios: string[];
  missingFeeds: string[];
} {
  const missingScenarios = REQUIRED_RUNBOOK_SCENARIOS.filter(
    (scenario) => !markdown.includes(scenario)
  );
  const missingFeeds = REQUIRED_INVENTORY_FEEDS.filter(
    (feed) => !markdown.includes(feed)
  );

  return {
    valid: missingScenarios.length === 0 && missingFeeds.length === 0,
    missingScenarios,
    missingFeeds,
  };
}
