export const EDUCATION_PRIORITY_UTC_DAY = 0;
export const EDUCATION_PRIORITY_UTC_HOUR = 8;

export function orderMacroSections(
  runAt,
  educationSection,
  physicalPremiumSection,
  macroSections,
) {
  const educationRunsFirst = runAt.getUTCDay() === EDUCATION_PRIORITY_UTC_DAY
    && runAt.getUTCHours() === EDUCATION_PRIORITY_UTC_HOUR;
  return educationRunsFirst
    ? [educationSection, physicalPremiumSection, ...macroSections]
    : [physicalPremiumSection, ...macroSections, educationSection];
}
