// 배포 대기열 워커. (261111, 학원관리 sync_queue 방식)
//
// 표·SQL 함수는 supabase/publish_queue.sql 에 있다. 이 파일은 저장소에 기대지 않는 순수 로직만 둔다
// (QueueStore 를 받아 쓴다). 그래서 메모리 저장소로 단위 테스트할 수 있다(queue_test.ts).
//
// 한 번의 워커 실행은
//   잠금 → 멈춘 줄 복구 → 다음 시도 시각이 된 줄 하나 꺼내기 → 처리 → 결과 반영 → 잠금 풀기
// 를 하고 끝난다. 한 실행이 한 채널만 맡아 함수 실행 한도(150초)를 채널마다 따로 쓴다.
// 남은 줄이 있으면 호출부가 워커를 다시 깨운다.

export type JobStatus = "pending" | "processing" | "done" | "failed";

/** 메타 컨테이너 상태. id 가 비어 있고 children 만 있으면 스레드 캐러셀의 자식을 기다리는 중이다. */
export type ContainerState = { id: string; children: string[]; createdAt: string };

export type PublishJob = {
  id: number;
  page_id: string;
  channel: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  container_id: string | null;
  container_children: string[] | null;
  container_created_at: string | null;
  wait_started_at: string | null;
  published_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type JobPatch = Partial<Omit<PublishJob, "id" | "page_id" | "channel" | "created_at">>;

export interface QueueStore {
  /** (페이지, 채널)에 pending/processing 줄이 없을 때만 넣는다. 넣었으면 true. */
  enqueue(pageId: string, channel: string, payload: Record<string, unknown>): Promise<boolean>;
  /** 다음 시도 시각이 된 pending 줄 중 가장 먼저 쌓인 것을 processing 으로 바꿔 돌려준다. */
  claimNext(): Promise<PublishJob | null>;
  update(id: number, patch: JobPatch): Promise<void>;
  /** processing 으로 오래 멈춘 줄을 되돌린다. 되돌린 줄 수. */
  recoverStale(staleSeconds: number, maxAttempts: number): Promise<number>;
  tryLock(leaseSeconds: number): Promise<boolean>;
  renewLock(leaseSeconds: number): Promise<void>;
  releaseLock(): Promise<void>;
  /** 지금 바로 꺼낼 수 있는 pending 줄이 있는지. */
  hasReady(): Promise<boolean>;
}

export const QUEUE_DEFAULTS = {
  maxAttempts: 3,
  /** 처리 대기 재확인 간격. */
  recheckDelayMs: 60_000,
  /** 처리 대기 전체 한도. 넘으면 실패로 확정한다. */
  waitLimitMs: 30 * 60_000,
  /** 진짜 실패 뒤 다시 시도할 때까지. 시도마다 이만큼씩 늘린다(1분, 2분). */
  retryDelayMs: 60_000,
  staleSeconds: 15 * 60,
  leaseSeconds: 180,
  renewIntervalMs: 60_000,
};
export type QueueOptions = typeof QUEUE_DEFAULTS;

/** 메타 컨테이너는 만든 지 24시간이 지나면 발행할 수 없다. 조금 일찍(23시간) 새로 만든다. */
export const CONTAINER_TTL_MS = 23 * 60 * 60_000;

/** 처리 결과. done 이면 끝, wait 면 컨테이너가 아직 처리 중이라 1분 뒤 이어서 확인한다. */
export type ProcessResult =
  | { kind: "done"; detail?: string }
  | { kind: "wait"; container: ContainerState | null; reason?: string };

export type JobHandlers = {
  process(job: PublishJob, hooks: ProcessHooks): Promise<ProcessResult>;
  /** 다시 시도할 실패. 노션에 '재시도 예정'을 남긴다. */
  onRetry?(job: PublishJob, error: string, attempt: number, maxAttempts: number): Promise<void>;
  /** 확정 실패. 노션 상태를 ⚠️ 오류로 바꾸고 이유를 남긴다. */
  onFailed(job: PublishJob, error: string): Promise<void>;
};

export type ProcessHooks = {
  /**
   * 발행 API 가 성공하면 바로 부른다. 뒤 단계가 실패해 다시 시도해도 두 번 올리지 않게 한다.
   * 쓴 컨테이너와 처리 대기 시각도 비운다(같은 줄이 이어서 답글을 달 때 새 컨테이너 칸으로 쓴다).
   */
  markPublished(publishedId: string): Promise<void>;
  /** 새 컨테이너를 만들면 바로 부른다. 실행이 중간에 잘려도 다음 실행이 이어서 확인한다. */
  saveContainer(container: ContainerState): Promise<void>;
  /** 컨테이너 칸과 처리 대기 시각을 비운다. 답글을 올린 직후나 답글이 실패했을 때 쓴다. */
  clearContainer(): Promise<void>;
};

/** 다시 시도해도 소용없는 실패(설정·형식 오류 등). 바로 failed 로 확정한다. */
export class PermanentError extends Error {
  readonly permanent = true;
}

export function isPermanent(e: unknown): boolean {
  return Boolean((e as { permanent?: unknown } | null)?.permanent);
}

/** 컨테이너가 만료돼 새로 만들어야 할 때. 처리하는 쪽이 잡아 새로 만든다. */
export class ContainerExpired extends Error {
  readonly expired = true;
}

export function isContainerExpired(e: unknown): boolean {
  return Boolean((e as { expired?: unknown } | null)?.expired);
}

/** 메타 컨테이너 상태 문자열을 다음 할 일로 바꾼다. */
export function containerStep(status: string): "ready" | "wait" | "error" | "expired" {
  const value = status.trim().toUpperCase();
  if (value === "FINISHED" || value === "PUBLISHED") return "ready";
  if (value === "ERROR") return "error";
  if (value === "EXPIRED") return "expired";
  return "wait"; // IN_PROGRESS·빈 값·모르는 값은 아직 처리 중으로 본다.
}

/** 저장해 둔 컨테이너를 이어 쓸 수 있는지. 없거나 만료가 가까우면 null. */
export function resumableContainer(job: PublishJob, now: number): ContainerState | null {
  const id = job.container_id ?? "";
  const children = job.container_children ?? [];
  if (id === "" && children.length === 0) return null;
  const created = job.container_created_at ? Date.parse(job.container_created_at) : Number.NaN;
  if (!Number.isFinite(created) || now - created >= CONTAINER_TTL_MS) return null;
  return { id, children, createdAt: job.container_created_at as string };
}

/** 진짜 실패 뒤 어떻게 할지. attempts 는 이번 실패를 더한 값. */
export function failureDecision(
  attempts: number,
  maxAttempts: number,
  permanent: boolean,
): "retry" | "failed" {
  return permanent || attempts >= maxAttempts ? "failed" : "retry";
}

/** 처리 대기를 더 할지, 한도를 넘었는지. */
export function waitDecision(waitStartedAt: string | null, now: number, limitMs: number): "wait" | "timeout" {
  if (!waitStartedAt) return "wait";
  const started = Date.parse(waitStartedAt);
  if (!Number.isFinite(started)) return "wait";
  return now - started >= limitMs ? "timeout" : "wait";
}

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type WorkerReport =
  | { ran: false; reason: "locked" }
  | { ran: true; recovered: number; job: null; hasMore: boolean }
  | {
    ran: true;
    recovered: number;
    job: { id: number; pageId: string; channel: string };
    outcome: "done" | "wait" | "retry" | "failed";
    detail?: string;
    hasMore: boolean;
  };

/** 워커 한 번. 잠금을 못 잡으면 다른 실행이 돌고 있는 것이라 그냥 끝난다. */
export async function runWorkerOnce(
  store: QueueStore,
  handlers: JobHandlers,
  options: Partial<QueueOptions> = {},
  now: () => number = Date.now,
): Promise<WorkerReport> {
  const opt = { ...QUEUE_DEFAULTS, ...options };
  const locked = await store.tryLock(opt.leaseSeconds).catch(() => false);
  if (!locked) return { ran: false, reason: "locked" };

  const timer = opt.renewIntervalMs > 0
    ? setInterval(() => {
      store.renewLock(opt.leaseSeconds).catch(() => {});
    }, opt.renewIntervalMs)
    : null;

  try {
    const recovered = await store.recoverStale(opt.staleSeconds, opt.maxAttempts).catch(() => 0);
    const job = await store.claimNext();
    if (!job) return { ran: true, recovered, job: null, hasMore: false };

    const ref = { id: job.id, pageId: job.page_id, channel: job.channel };
    const emptyContainer = {
      container_id: null,
      container_children: null,
      container_created_at: null,
      wait_started_at: null,
    };
    const forgetContainer = () => {
      job.container_id = null;
      job.container_children = null;
      job.container_created_at = null;
      job.wait_started_at = null;
    };
    const hooks: ProcessHooks = {
      markPublished: async (publishedId) => {
        job.published_id = publishedId;
        forgetContainer();
        await store.update(job.id, { published_id: publishedId, ...emptyContainer, updated_at: iso(now()) });
      },
      clearContainer: async () => {
        forgetContainer();
        await store.update(job.id, { ...emptyContainer, updated_at: iso(now()) });
      },
      saveContainer: async (container) => {
        job.container_id = container.id;
        job.container_children = container.children;
        job.container_created_at = container.createdAt;
        await store.update(job.id, {
          container_id: container.id,
          container_children: container.children,
          container_created_at: container.createdAt,
          updated_at: iso(now()),
        });
      },
    };

    let outcome: "done" | "wait" | "retry" | "failed";
    let detail: string | undefined;
    try {
      const result = await handlers.process(job, hooks);
      if (result.kind === "done") {
        outcome = "done";
        detail = result.detail;
        await store.update(job.id, {
          status: "done",
          last_error: null,
          finished_at: iso(now()),
          updated_at: iso(now()),
        });
      } else if (waitDecision(job.wait_started_at, now(), opt.waitLimitMs) === "timeout") {
        // 처리 대기가 한도를 넘었다. 메타 쪽이 멈춘 것으로 보고 실패로 확정한다.
        outcome = "failed";
        detail = `메타가 ${Math.round(opt.waitLimitMs / 60_000)}분 넘게 파일을 처리하는 중이라 멈췄습니다. ` +
          "올라간 글은 없습니다. 잠시 뒤 배포 버튼을 다시 누르면 새로 처리합니다.";
        await store.update(job.id, {
          status: "failed",
          last_error: detail,
          container_id: null,
          container_children: null,
          container_created_at: null,
          wait_started_at: null,
          finished_at: iso(now()),
          updated_at: iso(now()),
        });
        await handlers.onFailed(job, detail).catch(() => {});
      } else {
        // 아직 처리 중. 시도 횟수는 그대로 두고 1분 뒤 이어서 확인한다.
        outcome = "wait";
        detail = result.reason;
        const container = result.container;
        await store.update(job.id, {
          status: "pending",
          next_attempt_at: iso(now() + opt.recheckDelayMs),
          wait_started_at: job.wait_started_at ?? iso(now()),
          ...(container
            ? {
              container_id: container.id,
              container_children: container.children,
              container_created_at: container.createdAt,
            }
            : {}),
          updated_at: iso(now()),
        });
      }
    } catch (e) {
      const message = errorText(e);
      const attempts = job.attempts + 1;
      const decision = failureDecision(attempts, opt.maxAttempts, isPermanent(e));
      detail = message;
      // 실패한 컨테이너는 버린다. 다시 시도할 때 새로 만든다.
      const reset = {
        container_id: null,
        container_children: null,
        container_created_at: null,
        wait_started_at: null,
      };
      if (decision === "retry") {
        outcome = "retry";
        await store.update(job.id, {
          status: "pending",
          attempts,
          last_error: message,
          next_attempt_at: iso(now() + opt.retryDelayMs * attempts),
          ...reset,
          updated_at: iso(now()),
        });
        await handlers.onRetry?.(job, message, attempts, opt.maxAttempts).catch(() => {});
      } else {
        outcome = "failed";
        await store.update(job.id, {
          status: "failed",
          attempts,
          last_error: message,
          ...reset,
          finished_at: iso(now()),
          updated_at: iso(now()),
        });
        await handlers.onFailed(job, message).catch(() => {});
      }
    }

    const hasMore = await store.hasReady().catch(() => false);
    return { ran: true, recovered, job: ref, outcome, detail, hasMore };
  } finally {
    if (timer !== null) clearInterval(timer);
    await store.releaseLock().catch(() => {});
  }
}

// ---------- 메모리 저장소 ----------
// SQL 함수(supabase/publish_queue.sql)와 같은 규칙을 따른다. 테스트용이다.

export class MemoryQueueStore implements QueueStore {
  jobs: PublishJob[] = [];
  lockedUntil = 0;
  private nextId = 1;

  constructor(private now: () => number = Date.now) {}

  enqueue(pageId: string, channel: string, payload: Record<string, unknown>): Promise<boolean> {
    const active = this.jobs.some((job) =>
      job.page_id === pageId && job.channel === channel && (job.status === "pending" || job.status === "processing")
    );
    if (active) return Promise.resolve(false);
    const at = iso(this.now());
    this.jobs.push({
      id: this.nextId++,
      page_id: pageId,
      channel,
      payload,
      status: "pending",
      attempts: 0,
      next_attempt_at: at,
      last_error: null,
      container_id: null,
      container_children: null,
      container_created_at: null,
      wait_started_at: null,
      published_id: null,
      created_at: at,
      updated_at: at,
      started_at: null,
      finished_at: null,
    });
    return Promise.resolve(true);
  }

  claimNext(): Promise<PublishJob | null> {
    const now = this.now();
    const ready = this.jobs
      .filter((job) => job.status === "pending" && Date.parse(job.next_attempt_at) <= now)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    const job = ready[0];
    if (!job) return Promise.resolve(null);
    job.status = "processing";
    job.started_at = iso(now);
    return Promise.resolve({ ...job });
  }

  update(id: number, patch: JobPatch): Promise<void> {
    const job = this.jobs.find((item) => item.id === id);
    if (job) Object.assign(job, patch);
    return Promise.resolve();
  }

  recoverStale(staleSeconds: number, maxAttempts: number): Promise<number> {
    const cutoff = this.now() - staleSeconds * 1000;
    let count = 0;
    for (const job of this.jobs) {
      if (job.status !== "processing" || !job.started_at || Date.parse(job.started_at) >= cutoff) continue;
      job.attempts += 1;
      const failed = job.attempts >= maxAttempts;
      job.status = failed ? "failed" : "pending";
      job.next_attempt_at = iso(this.now());
      job.finished_at = failed ? iso(this.now()) : null;
      job.last_error = (job.last_error ? `${job.last_error}\n` : "") +
        (failed ? "[자동복구] 처리 중 상태로 오래 멈춰 있었고 재시도 한도를 넘어 실패로 확정함" : "[자동복구] 처리 중 상태로 오래 멈춰 있어 다시 대기열로 되돌림");
      count++;
    }
    return Promise.resolve(count);
  }

  tryLock(leaseSeconds: number): Promise<boolean> {
    const now = this.now();
    if (this.lockedUntil > now) return Promise.resolve(false);
    this.lockedUntil = now + leaseSeconds * 1000;
    return Promise.resolve(true);
  }

  renewLock(leaseSeconds: number): Promise<void> {
    this.lockedUntil = this.now() + leaseSeconds * 1000;
    return Promise.resolve();
  }

  releaseLock(): Promise<void> {
    this.lockedUntil = 0;
    return Promise.resolve();
  }

  hasReady(): Promise<boolean> {
    const now = this.now();
    return Promise.resolve(
      this.jobs.some((job) => job.status === "pending" && Date.parse(job.next_attempt_at) <= now),
    );
  }
}
