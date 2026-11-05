export const EDUCATION_PRIORITY_UTC_DAY = 0;
export const EDUCATION_PRIORITY_UTC_HOUR = 8;

/** Preserve protected priority slots, or rotate the leased admission leader for the recovery tick. */
export function orderMacroSections(
  runAt,
  educationSection,
  physicalPremiumSection,
  macroSections,
  turn = null,
) {
  if (turn !== null) {
    if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError('turn must be a non-negative safe integer');
    if (!macroSections.length) return [physicalPremiumSection, educationSection];
    const offset = turn % macroSections.length;
    const rotated = [...macroSections.slice(offset), ...macroSections.slice(0, offset)];
    // The 10:00 rotation gives one member an unconditional lead slot. Physical
    // keeps the next slot and the protected 08:00/09:00 runs; failed upstream jobs
    // cannot permanently block a never-seeded member at the tail.
    return [rotated[0], physicalPremiumSection, ...rotated.slice(1), educationSection];
  }
  const educationRunsFirst = runAt.getUTCDay() === EDUCATION_PRIORITY_UTC_DAY
    && runAt.getUTCHours() === EDUCATION_PRIORITY_UTC_HOUR;
  return educationRunsFirst
    ? [educationSection, physicalPremiumSection, ...macroSections]
    : [physicalPremiumSection, ...macroSections, educationSection];
}
