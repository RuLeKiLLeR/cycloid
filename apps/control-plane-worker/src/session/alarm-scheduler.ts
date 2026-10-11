export interface SessionAlarmScheduler {
  alarm(): Promise<void>;
}

interface SessionAlarmSchedulerHost {
  runAlarmTick(): Promise<void>;
}

export function createSessionAlarmScheduler(host: SessionAlarmSchedulerHost): SessionAlarmScheduler {
  return {
    alarm: () => host.runAlarmTick(),
  };
}
