import type {
  ActivityPreferenceCoverage,
  PreferenceCoverageReport,
} from "@/lib/preference-coverage";

const BALANCE_COPY = {
  balanced: {
    label: "Balanced coverage",
    style: "bg-[#DCEAD4] text-[#46613D]",
    detail: "Matched activities are distributed relatively evenly across the group.",
  },
  mixed: {
    label: "Mixed coverage",
    style: "bg-[#F5E6C8] text-[#8A6D1F]",
    detail: "Everyone has some representation, but some travelers have noticeably more matched stops.",
  },
  uneven: {
    label: "Uneven coverage",
    style: "bg-[#F5DFDA] text-[#93472F]",
    detail: "At least one traveler has little or no tagged preference coverage in the current plan.",
  },
  unavailable: {
    label: "Coverage unclear",
    style: "bg-[#E5DED2] text-[#756B5E]",
    detail: "The current venue tags do not provide enough evidence to compare the group fairly.",
  },
} as const;

function namesWithValue(groups: { names: string[]; value: string }[]): string {
  return groups.map((group) => `${group.names.join(" & ")} (${group.value})`).join(" · ");
}

export function PreferenceCoverageSummary({ report }: { report: PreferenceCoverageReport }) {
  const balance = BALANCE_COPY[report.balance];
  const stopsPerDay = Number.isInteger(report.averageStopsPerDay)
    ? report.averageStopsPerDay.toFixed(0)
    : report.averageStopsPerDay.toFixed(1);

  return (
    <section className="mb-4 rounded-2xl border border-[#D9C49E] bg-[#FFF9EC] p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl font-semibold text-[#2D2A24]">How the plan fits the group</h2>
          <p className="mt-1 text-sm text-[#756B5E]">{balance.detail}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${balance.style}`}>
          {balance.label}
        </span>
      </div>

      <p className="mt-3 text-sm text-[#2D2A24]">
        <strong>{report.coveredInterestCount} of {report.requestedInterestCount}</strong> selected traveler interests
        appear in the current plan across <strong>{report.classifiedItemCount}</strong> tagged stops.
        {report.unclassifiedItemCount > 0 && (
          <> {report.unclassifiedItemCount} general {report.unclassifiedItemCount === 1 ? "pick is" : "picks are"} not scored.</>
        )}
      </p>

      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {report.travelers.map((traveler) => (
          <li key={traveler.travelerId} className="rounded-xl border border-[#EADFCC] bg-white/70 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <strong className="text-sm text-[#2D2A24]">{traveler.displayName}</strong>
              <span className="text-xs text-[#756B5E]">
                {traveler.matchedActivityCount} matched {traveler.matchedActivityCount === 1 ? "stop" : "stops"}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {traveler.coveredInterests.map((interest) => (
                <span key={interest} className="rounded-full bg-[#DCEAD4] px-2 py-0.5 text-xs text-[#46613D]">
                  ✓ {interest}
                </span>
              ))}
              {traveler.uncoveredInterests.map((interest) => (
                <span key={interest} className="rounded-full border border-dashed border-[#C9826A] px-2 py-0.5 text-xs text-[#93472F]">
                  not covered: {interest}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {(report.paceGroups.length > 1 || report.dietaryNeeds.length > 0 || report.constraintNotes.length > 0) && (
        <div className="mt-3 space-y-2 border-t border-[#EADFCC] pt-3 text-sm text-[#5E5548]">
          {report.paceGroups.length > 1 && (
            <p>
              <strong>Pace trade-off:</strong>{" "}
              {namesWithValue(report.paceGroups.map((group) => ({ names: group.names, value: group.pace })))}.
              The current plan averages {stopsPerDay} active stops per day.
            </p>
          )}
          {report.dietaryNeeds.length > 0 && (
            <p>
              <strong>Meal constraint:</strong>{" "}
              {namesWithValue(report.dietaryNeeds.map((group) => ({ names: group.names, value: group.dietary })))}.
              The planner was instructed to fit every listed dietary need; verify menus before booking.
            </p>
          )}
          {report.constraintNotes.length > 0 && (
            <div>
              <strong>Other constraints to verify:</strong>
              <ul className="mt-1 list-disc pl-5">
                {report.constraintNotes.map((constraint) => (
                  <li key={`${constraint.displayName}:${constraint.note}`}>
                    {constraint.displayName}: {constraint.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-xs text-[#8A8272]">
        Evidence: saved venue-search tags, not guesses from venue names or AI-written notes. Skipped stops do not count.
      </p>
    </section>
  );
}

export function ActivityPreferenceFit({
  activity,
  report,
}: {
  activity: ActivityPreferenceCoverage | undefined;
  report: PreferenceCoverageReport;
}) {
  if (!activity) return null;
  const uncoveredAcrossPlan = new Set(
    report.travelers
      .filter((traveler) => traveler.matchedActivityCount === 0)
      .map((traveler) => traveler.travelerId),
  );
  const needsAttention = activity.otherTravelers.filter((traveler) =>
    uncoveredAcrossPlan.has(traveler.travelerId),
  );

  return (
    <details className="mt-2 rounded-xl border border-[#EADFCC] bg-white/60 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-semibold text-[#5E5548]">Why this fits the group</summary>
      {activity.supporters.length > 0 ? (
        <ul className="mt-2 space-y-1.5 text-[#2D2A24]">
          {activity.supporters.map((supporter) => (
            <li key={supporter.travelerId}>
              <strong>{supporter.displayName}</strong>: {supporter.interests.join(" + ")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[#756B5E]">
          No saved interest tag matches this stop. It may be a general group pick or a member suggestion;
          the planner note above remains context, not proof of preference coverage.
        </p>
      )}
      {activity.otherTravelers.length > 0 && activity.supporters.length > 0 && (
        <p className="mt-2 text-[#756B5E]">
          <strong>Trade-off:</strong> this stop does not directly match the selected interests of{" "}
          {activity.otherTravelers.map((traveler) => traveler.displayName).join(", ")}.
        </p>
      )}
      {needsAttention.length > 0 && (
        <p className="mt-2 font-medium text-[#93472F]">
          Needs attention: {needsAttention.map((traveler) => traveler.displayName).join(", ")}{" "}
          {needsAttention.length === 1 ? "has" : "have"} no tagged preference match anywhere in the current plan.
        </p>
      )}
    </details>
  );
}
