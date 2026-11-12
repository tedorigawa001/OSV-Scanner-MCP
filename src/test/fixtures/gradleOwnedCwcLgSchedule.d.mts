export type LgSchedulePhase = 'primary' | 'bridge';
export interface LgScheduleRow {
  scheduleVersion: string; phase: LgSchedulePhase; trialOrdinal: number; runOrdinal: number;
  cohort: number; workload: string; role: string; round: number; stage: string;
  observationSlot: number; observation: string; groupSlot: number; group: string;
  armSlot: number; arm: string; pairId: string; comparisonKey: string; observationKey: string;
}
export const LG_SCHEDULE_VERSION: string;
export function lgDesignSchedule(phase: LgSchedulePhase): LgScheduleRow[];
export function assertLgDesignSchedule(rows: unknown, phase: LgSchedulePhase): true;
