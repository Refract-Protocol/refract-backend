import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketCalendarResolver } from "./marketCalendar.ts";

function buildNyseResolver(): MarketCalendarResolver {
  const resolver = new MarketCalendarResolver();
  resolver.registerFeedCalendar({
    feedId: "EquityVolIndex",
    timeZone: "America/New_York",
    activeWindows: [
      {
        daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
        startMinuteOfDay: 9 * 60 + 30, // 09:30 ET
        endMinuteOfDay: 16 * 60, // 16:00 ET
      },
    ],
    holidays: ["2026-07-03", "2026-12-25"],
    activeFreshnessWindowMs: 5 * 60 * 1000, // 5m freshness
    unexpectedHaltGracePeriodMs: 10 * 60 * 1000, // +10m grace period -> alert after 15m
    suspendFlatlineCheckInQuietPeriod: true,
  });
  return resolver;
}

test("Issue #291: handles DST spring-forward and fall-back transitions without off-by-one-hour gaps", () => {
  const resolver = buildNyseResolver();

  // Before US DST spring-forward: Friday 2026-03-06 14:30:00 UTC is 09:30 EST (market open)
  const preDstOpen = Date.parse("2026-03-06T14:30:00Z");
  const preRes = resolver.evaluateFeedAt("EquityVolIndex", preDstOpen, preDstOpen - 60_000);
  assert.equal(preRes.activityState, "active_session");
  assert.equal(preRes.isExpectedActive, true);
  assert.equal(preRes.localMinuteOfDay, 9 * 60 + 30);

  // After US DST spring-forward (2026-03-08): Monday 2026-03-09 13:30:00 UTC is 09:30 EDT (market open)
  // whereas 13:29:00 UTC is 09:29 EDT (still pre-market quiet_off_hours)
  const postDstPreOpen = Date.parse("2026-03-09T13:29:00Z");
  const postDstOpen = Date.parse("2026-03-09T13:30:00Z");
  assert.equal(
    resolver.evaluateFeedAt("EquityVolIndex", postDstPreOpen, null).activityState,
    "quiet_off_hours"
  );
  assert.equal(
    resolver.evaluateFeedAt("EquityVolIndex", postDstOpen, postDstOpen - 30_000).activityState,
    "active_session"
  );

  // After US DST fall-back (2026-11-01): Monday 2026-11-02 14:30:00 UTC is 09:30 EST again
  const fallBackPreOpen = Date.parse("2026-11-02T13:30:00Z"); // 08:30 EST -> quiet_off_hours
  const fallBackOpen = Date.parse("2026-11-02T14:30:00Z"); // 09:30 EST -> active_session
  assert.equal(
    resolver.evaluateFeedAt("EquityVolIndex", fallBackPreOpen, null).activityState,
    "quiet_off_hours"
  );
  assert.equal(
    resolver.evaluateFeedAt("EquityVolIndex", fallBackOpen, fallBackOpen - 30_000).activityState,
    "active_session"
  );
});

test("Issue #291: weekends and exchange holidays do not accrue staleness penalties and suspend flatline plausibility checks", () => {
  const resolver = buildNyseResolver();

  // Exchange holiday: Friday 2026-07-03 15:00 UTC (11:00 EDT)
  const holidayMs = Date.parse("2026-07-03T15:00:00Z");
  const holidayEval = resolver.evaluateFeedAt(
    "EquityVolIndex",
    holidayMs,
    holidayMs - 12 * 60 * 60 * 1000 // last reading 12h ago
  );
  assert.equal(holidayEval.activityState, "quiet_holiday");
  assert.equal(holidayEval.isExpectedActive, false);
  assert.equal(holidayEval.accruesStalenessPenalty, false);
  assert.equal(holidayEval.isStale, false);
  assert.equal(holidayEval.unexpectedHaltAlert, false);
  assert.equal(holidayEval.plausibilityCheckMode, "suspended_quiet_period");

  // Weekend: Saturday 2026-07-04 15:00 UTC
  const weekendMs = Date.parse("2026-07-04T15:00:00Z");
  const weekendEval = resolver.evaluateFeedAt(
    "EquityVolIndex",
    weekendMs,
    weekendMs - 24 * 60 * 60 * 1000
  );
  assert.equal(weekendEval.activityState, "quiet_weekend");
  assert.equal(weekendEval.isStale, false);
  assert.equal(weekendEval.plausibilityCheckMode, "suspended_quiet_period");
});

test("Issue #291: fires unexpected-halt alert after grace period during active hours and is deterministic when clock is frozen", () => {
  const resolver = buildNyseResolver();
  const activeTimeMs = Date.parse("2026-03-10T15:00:00Z"); // Tuesday 11:00 EDT

  // 8m old reading: stale (>5m), but inside 10m grace period (<=15m) -> no unexpectedHaltAlert yet
  const staleWithinGrace = resolver.evaluateFeedAt(
    "EquityVolIndex",
    activeTimeMs,
    activeTimeMs - 8 * 60 * 1000
  );
  assert.equal(staleWithinGrace.isStale, true);
  assert.equal(staleWithinGrace.unexpectedHaltAlert, false);

  // 16m old reading: exceeds 5m freshness + 10m grace period -> unexpectedHaltAlert fires
  const haltAlertEval1 = resolver.evaluateFeedAt(
    "EquityVolIndex",
    activeTimeMs,
    activeTimeMs - 16 * 60 * 1000
  );
  const haltAlertEval2 = resolver.evaluateFeedAt(
    "EquityVolIndex",
    activeTimeMs,
    activeTimeMs - 16 * 60 * 1000
  );
  assert.equal(haltAlertEval1.isStale, true);
  assert.equal(haltAlertEval1.unexpectedHaltAlert, true);
  assert.deepEqual(haltAlertEval1, haltAlertEval2);
});
