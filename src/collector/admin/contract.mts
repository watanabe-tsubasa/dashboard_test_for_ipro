import type { CameraId } from "../config.mts";
import type { CollectionEvent } from "../d1/collect.mts";
import type { WriteCounts } from "../d1/repository.mts";
import type { NormalizedKind } from "../parse/csv.mts";

export type Selection = CameraId | "all";
export type JobRequest =
  | { operation: "sync"; camera: Selection }
  | {
      operation: "backfill";
      camera: Selection;
      from?: string;
      to?: string;
      dryRun: boolean;
    }
  | { operation: "thumbnail"; camera: CameraId };
export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted";

export type Plan = Extract<CollectionEvent, { type: "plan" }>;
type TargetResult = Extract<CollectionEvent, { type: "result" }>;
export type JobProgress = {
  camera?: CameraId;
  kind?: NormalizedKind;
  totalTargets: number;
  completedTargets: number;
  requestsDone?: number;
  requestsTotal?: number;
};
export type JobReport = {
  plans: Plan[];
  targets: TargetResult[];
  counts: WriteCounts & { noData: number; records: number };
  thumbnail?: {
    outcome: "uploaded" | "unchanged" | "no_data" | "failed" | "uncertain";
    lastModifiedUtc?: string;
    retrievedAtUtc?: string;
    bytes?: number;
    errorCode?: string;
  };
};
export type Job = {
  id: string;
  request: JobRequest;
  state: JobState;
  createdAtUtc: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  exitCode: number | null;
  error: string | null;
  progress: JobProgress | null;
  report: JobReport | null;
};
export type CameraStatus = {
  id: CameraId;
  name: string;
  configured: boolean;
  kinds: NormalizedKind[];
  historySettingsValid: boolean;
  thumbnailSettingsValid: boolean;
  lastCollection: Job | null;
  lastThumbnail: Job | null;
};
export type AdminStatus = {
  cameras: CameraStatus[];
  d1Configured: boolean;
  r2Configured: boolean;
  activeJob: Job | null;
};
export type JobDetail = {
  job: Job;
  logs: Array<{ seq: number; message: string }>;
  cursor: number;
  hasMore: boolean;
};
export type MeasurementStatus =
  | {
      state: "ready";
      rows: Array<{
        kind: NormalizedKind;
        rows: number;
        newestStartUtc: string;
      }>;
    }
  | { state: "not_configured" | "unavailable" };
export type Measurements = Record<CameraId, MeasurementStatus>;

export function isActive(job: Job | null | undefined): boolean {
  return job?.state === "queued" || job?.state === "running";
}
