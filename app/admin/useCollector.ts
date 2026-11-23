"use client";

import { useEffect, useRef, useState } from "react";
import type {
  AdminStatus,
  Job,
  JobDetail,
  Measurements,
} from "@/src/collector/admin/contract.mts";
import { isActive } from "@/src/collector/admin/contract.mts";

export const apiRoot = "/api/collector";

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(apiRoot + path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("状態を読み込めませんでした。");
  return response.json() as Promise<T>;
}

const selectionKey = "ipro-admin-job";

export function useCollector() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [measurements, setMeasurements] = useState<Measurements | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refresh, refreshPoll] = useState(0);
  const [pollError, setPollError] = useState("");
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const current = useRef<JobDetail | null>(null);
  const pending = useRef(false);

  useEffect(() => setSelected(sessionStorage.getItem(selectionKey)), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A completed POST restarts the polling timer even when the selection is unchanged.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let nextDelay = 3500;
      try {
        const [status, history] = await Promise.all([
          get<AdminStatus>("/status", controller.signal),
          get<{ jobs: Job[] }>("/jobs", controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setStatus(status);
        setJobs(history.jobs);
        nextDelay = isActive(status.activeJob) ? 1400 : 3500;
        const visible =
          history.jobs.find(({ id }) => id === selected) ??
          status.activeJob ??
          history.jobs[0];
        if (visible) {
          const previous =
            current.current?.job.id === visible.id ? current.current : null;
          const suffix = previous ? `?after=${previous.cursor}` : "";
          const update = await get<JobDetail>(
            `/jobs/${visible.id}${suffix}`,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const loaded = {
            ...update,
            logs: [...(previous?.logs ?? []), ...update.logs].slice(-600),
          };
          current.current = loaded;
          setDetail(loaded);
          if (update.hasMore) nextDelay = 100;
        } else {
          current.current = null;
          setDetail(null);
        }
        setPollError("");
      } catch {
        if (!controller.signal.aborted)
          setPollError("管理APIに接続できません。再接続しています。");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, nextDelay);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, refresh]);

  const collectionRevision = status?.cameras
    .map(({ lastCollection }) => lastCollection?.id ?? "")
    .join("/");
  const ready = status?.d1Configured;
  useEffect(() => {
    if (ready !== true) return;
    const controller = new AbortController();
    void get<Measurements>(
      `/measurements?revision=${encodeURIComponent(collectionRevision ?? "")}`,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setMeasurements(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setMeasurements({
            food: { state: "unavailable" },
            island: { state: "unavailable" },
          });
      });
    return () => controller.abort();
  }, [ready, collectionRevision]);

  function select(id: string) {
    sessionStorage.setItem(selectionKey, id);
    setSelected(id);
  }

  async function submit(payload: object) {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setActionError("");
    try {
      const response = await fetch(`${apiRoot}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as {
        jobId?: string;
        error?: string;
      };
      if (data.jobId) select(data.jobId);
      if (!response.ok)
        setActionError(data.error ?? "操作を開始できませんでした。");
      refreshPoll((revision) => revision + 1);
    } catch {
      setActionError("管理APIに接続できませんでした。");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return {
    status,
    jobs,
    detail,
    measurements,
    pollError,
    actionError,
    submitting,
    select,
    submit,
  };
}
