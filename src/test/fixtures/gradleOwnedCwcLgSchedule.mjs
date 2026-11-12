/** Design-only trial order model. Does not run LG code or validate measured results. */
export const LG_SCHEDULE_VERSION = 'cwc-lg.schedule.v1';
const workloads = ['small', 'h0', 'single-large'];
const roles = ['reader', 'authority-broker'];
const observations = ['quiet', 'counts', 'timed'];
const groups = ['S/full-verify', 'S/fact-live', 'B/full-verify', 'B/fact-live'];

export function lgDesignSchedule(phase) {
  if (phase !== 'primary' && phase !== 'bridge') throw Error('lg_schedule_phase');
  const rows = [];
  for (let wi = 0; wi < workloads.length; wi++) for (let ri = 0; ri < roles.length; ri++) {
    const cohort = 2 * wi + ri;
    for (let round = -1; round < 3; round++) for (let observationSlot = 0; observationSlot < 3; observationSlot++) {
      const t = round + 1, observationIndex = (observationSlot + cohort + t) % 3;
      const observation = observations[observationIndex];
      for (let groupSlot = 0; groupSlot < (phase === 'primary' ? 4 : 1); groupSlot++) {
        const groupIndex = phase === 'primary' ? (groupSlot + cohort + t + observationSlot) % 4 : 0;
        const group = phase === 'primary' ? groups[groupIndex] : 'B/fact-live';
        const arms = phase === 'primary' ? [group + '/full-input', group + '/owned-input'] : ['old-VF-3P-v2', 'new-full-input'];
        if ((cohort + t + groupIndex + observationIndex) % 2) arms.reverse();
        for (let armSlot = 0; armSlot < 2; armSlot++) {
          const arm = arms[armSlot], trialOrdinal = rows.length;
          rows.push({scheduleVersion: LG_SCHEDULE_VERSION, phase, trialOrdinal,
            runOrdinal: trialOrdinal + (phase === 'bridge' ? 576 : 0),
            cohort, workload: workloads[wi], role: roles[ri], round,
            stage: round === -1 ? 'warmup' : 'measured', observationSlot, observation,
            groupSlot, group, armSlot, arm,
            pairId: `${phase}:${cohort}:${round}:${observation}:${group}`,
            comparisonKey: `${phase}:${cohort}:${round}:${observation}`,
            observationKey: `${phase}:${cohort}:${round}:${arm}`});
        }
      }
    }
  }
  return rows;
}

// Strict equality of each named field and its position, not unordered set equality.
export function assertLgDesignSchedule(rows, phase) {
  const expected = lgDesignSchedule(phase);
  if (!Array.isArray(rows) || rows.length !== expected.length) throw Error('lg_schedule_length');
  for (let i = 0; i < expected.length; i++) {
    const actual = rows[i], spec = expected[i], keys = Object.keys(spec);
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) ||
      Object.keys(actual).length !== keys.length ||
      keys.some(key => !Object.hasOwn(actual, key) || actual[key] !== spec[key])) {
      throw Error('lg_schedule_row_' + i);
    }
  }
  return true;
}
