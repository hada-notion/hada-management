import {
  CONTAINER_TTL_MS,
  ContainerExpired,
  MemoryQueueStore,
  PermanentError,
  QUEUE_DEFAULTS,
  containerStep,
  failureDecision,
  isContainerExpired,
  isPermanent,
  resumableContainer,
  runWorkerOnce,
  waitDecision,
} from "./queue.ts";
import type { JobHandlers, ProcessResult, PublishJob } from "./queue.ts";

function assertEquals(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`);
}

function assert(value: unknown, msg = "assertion failed"): void {
  if (!value) throw new Error(msg);
}

const START = Date.parse("2026-11-11T09:00:00Z");
const MIN = 60_000;

/** 시계를 손으로 돌리는 테스트 환경. 잠금 연장 타이머는 끈다. */
function setup() {
  let clock = START;
  const now = () => clock;
  const store = new MemoryQueueStore(now);
  const advance = (ms: number) => {
    clock += ms;
  };
  const options = { renewIntervalMs: 0 };
  return { store, now, advance, options };
}

type Calls = { processed: PublishJob[]; retries: [string, number][]; failed: string[] };

function handlers(steps: Array<(job: PublishJob, hooks: Parameters<JobHandlers["process"]>[1]) => Promise<ProcessResult>>) {
  const calls: Calls = { processed: [], retries: [], failed: [] };
  let index = 0;
  const h: JobHandlers = {
    process(job, hooks) {
      calls.processed.push(structuredClone(job));
      const step = steps[Math.min(index++, steps.length - 1)];
      return step(job, hooks);
    },
    onRetry(_job, error, attempt) {
      calls.retries.push([error, attempt]);
      return Promise.resolve();
    },
    onFailed(_job, error) {
      calls.failed.push(error);
      return Promise.resolve();
    },
  };
  return { h, calls };
}

const done = () => Promise.resolve<ProcessResult>({ kind: "done" });

// ---------- 접수 ----------

Deno.test("enqueue: 같은 (페이지, 채널)에 살아 있는 줄이 있으면 새로 넣지 않는다", async () => {
  const { store } = setup();
  assertEquals(await store.enqueue("p1", "스레드", {}), true);
  assertEquals(await store.enqueue("p1", "스레드", {}), false, "pending 중복");
  assertEquals(await store.enqueue("p1", "인스타그램", {}), true, "다른 채널은 따로");
  assertEquals(await store.enqueue("p2", "스레드", {}), true, "다른 페이지는 따로");
  assertEquals(store.jobs.length, 3);
});

Deno.test("enqueue: processing 중에도 막고, 끝난(done·failed) 뒤에는 다시 넣을 수 있다", async () => {
  const { store, options, now } = setup();
  await store.enqueue("p1", "스레드", {});
  const claimed = await store.claimNext();
  assertEquals(claimed?.status, "processing");
  assertEquals(await store.enqueue("p1", "스레드", {}), false, "processing 중복");
  await store.update(claimed!.id, { status: "done" });
  assertEquals(await store.enqueue("p1", "스레드", {}), true, "done 뒤 재배포");
  const { h } = handlers([() => Promise.reject(new PermanentError("형식 오류"))]);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[1].status, "failed");
  assertEquals(await store.enqueue("p1", "스레드", {}), true, "failed 뒤 재배포");
});

// ---------- 워커: 한 번에 한 줄, 쌓인 순서대로 ----------

Deno.test("worker: 한 실행은 한 줄만 처리하고, 남은 줄이 있으면 hasMore 로 알린다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "유튜브", {});
  advance(1000);
  await store.enqueue("p1", "인스타그램", {});
  advance(1000);
  await store.enqueue("p1", "스레드", {});
  const { h, calls } = handlers([done]);

  const first = await runWorkerOnce(store, h, options, now);
  assert(first.ran && first.job !== null);
  if (first.ran && first.job) {
    assertEquals(first.job.channel, "유튜브", "먼저 쌓인 것부터");
    assertEquals(first.hasMore, true);
  }
  assertEquals(calls.processed.length, 1, "한 실행 = 한 채널");

  await runWorkerOnce(store, h, options, now);
  const third = await runWorkerOnce(store, h, options, now);
  if (third.ran) assertEquals(third.hasMore, false);
  assertEquals(calls.processed.map((job) => job.channel), ["유튜브", "인스타그램", "스레드"]);
  assertEquals(store.jobs.map((job) => job.status), ["done", "done", "done"]);
});

Deno.test("worker: 다른 실행이 잠금을 잡고 있으면 아무것도 하지 않는다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  assertEquals(await store.tryLock(180), true);
  const { h, calls } = handlers([done]);
  const report = await runWorkerOnce(store, h, options, now);
  assertEquals(report.ran, false);
  assertEquals(calls.processed.length, 0);
  // 리스가 끝나면(실행이 죽어 못 풀었을 때) 저절로 풀린다.
  advance(181_000);
  const after = await runWorkerOnce(store, h, options, now);
  assertEquals(after.ran, true);
  assertEquals(store.lockedUntil, 0, "끝나면 잠금을 푼다");
});

Deno.test("worker: 처리 중 예외가 나도 잠금은 푼다", async () => {
  const { store, options, now } = setup();
  await store.enqueue("p1", "스레드", {});
  const h: JobHandlers = {
    process: () => Promise.reject(new Error("boom")),
    onFailed: () => Promise.reject(new Error("노션 기록 실패")),
    onRetry: () => Promise.reject(new Error("노션 기록 실패")),
  };
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.lockedUntil, 0);
  assertEquals(store.jobs[0].status, "pending", "재시도로 되돌림");
});

// ---------- 영상 처리 대기 재확인 ----------

Deno.test("wait: 컨테이너가 처리 중이면 실패로 치지 않고 container_id 를 남겨 1분 뒤로 미룬다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  const container = { id: "C1", children: [], createdAt: new Date(START).toISOString() };
  const { h, calls } = handlers([
    () => Promise.resolve({ kind: "wait", container }),
    (job) => {
      // 다음 실행은 새로 올리지 않고 저장된 컨테이너를 이어서 확인한다.
      assertEquals(resumableContainer(job, now())?.id, "C1");
      return done();
    },
  ]);

  const first = await runWorkerOnce(store, h, options, now);
  if (first.ran && first.job) assertEquals(first.outcome, "wait");
  const job = store.jobs[0];
  assertEquals(job.status, "pending");
  assertEquals(job.attempts, 0, "처리 대기는 시도 횟수에 넣지 않는다");
  assertEquals(job.container_id, "C1");
  assertEquals(job.next_attempt_at, new Date(START + MIN).toISOString());
  assertEquals(job.wait_started_at, new Date(START).toISOString());

  // 1분이 지나기 전에는 꺼내지 않는다.
  advance(30_000);
  const early = await runWorkerOnce(store, h, options, now);
  if (early.ran) assertEquals(early.job, null);
  assertEquals(calls.processed.length, 1);

  advance(30_000);
  const second = await runWorkerOnce(store, h, options, now);
  if (second.ran && second.job) assertEquals(second.outcome, "done");
  assertEquals(calls.processed[1].container_id, "C1");
  assertEquals(store.jobs[0].status, "done");
});

Deno.test("wait: 여러 번 다시 확인해도 wait_started_at 은 처음 시각을 유지하고 attempts 는 0이다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "인스타그램", {});
  const container = { id: "IG1", children: [], createdAt: new Date(START).toISOString() };
  const { h } = handlers([() => Promise.resolve({ kind: "wait", container })]);
  for (let i = 0; i < 10; i++) {
    await runWorkerOnce(store, h, options, now);
    advance(MIN);
  }
  assertEquals(store.jobs[0].attempts, 0);
  assertEquals(store.jobs[0].wait_started_at, new Date(START).toISOString());
  assertEquals(store.jobs[0].status, "pending");
});

Deno.test("wait: 처리 대기가 30분을 넘으면 실패로 확정하고 이유를 남긴다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  const container = { id: "C1", children: [], createdAt: new Date(START).toISOString() };
  const { h, calls } = handlers([() => Promise.resolve({ kind: "wait", container })]);
  await runWorkerOnce(store, h, options, now);
  for (let i = 0; i < 31 && store.jobs[0].status === "pending"; i++) {
    advance(MIN);
    await runWorkerOnce(store, h, options, now);
  }
  const job = store.jobs[0];
  assertEquals(job.status, "failed");
  assert((job.last_error ?? "").includes("30분"), "이유에 한도가 들어간다");
  assertEquals(job.container_id, null, "다시 누르면 새로 만든다");
  assertEquals(calls.failed.length, 1);
  assertEquals(job.attempts, 0, "대기 한도 초과는 시도 횟수와 별개");
});

Deno.test("wait: 캐러셀 자식 컨테이너도 저장해 이어서 확인한다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  const children = { id: "", children: ["K1", "K2"], createdAt: new Date(START).toISOString() };
  const { h } = handlers([
    () => Promise.resolve({ kind: "wait", container: children }),
    (job) => {
      const resumed = resumableContainer(job, now());
      assertEquals(resumed, children);
      return done();
    },
  ]);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].container_children, ["K1", "K2"]);
  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].status, "done");
});

Deno.test("saveContainer: 새 컨테이너를 만들자마자 남겨, 실행이 잘려도 다음에 이어서 확인한다", async () => {
  const { store, options, now } = setup();
  await store.enqueue("p1", "스레드", {});
  const h: JobHandlers = {
    async process(_job, hooks) {
      await hooks.saveContainer({ id: "C9", children: [], createdAt: new Date(START).toISOString() });
      throw new Error("네트워크 끊김");
    },
    onFailed: () => Promise.resolve(),
  };
  await runWorkerOnce(store, h, options, now);
  // 진짜 실패면 컨테이너를 버린다(다시 시도할 때 새로 만든다).
  assertEquals(store.jobs[0].container_id, null);
  assertEquals(store.jobs[0].attempts, 1);
});

// ---------- 재시도 ----------

Deno.test("retry: 진짜 실패는 3번까지 시도하고, 그래도 실패하면 failed 로 확정해 마지막 오류를 남긴다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  const { h, calls } = handlers([() => Promise.reject(new Error("스레드 API 500: 잠시 뒤 다시"))]);

  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].status, "pending");
  assertEquals(store.jobs[0].attempts, 1);
  assertEquals(store.jobs[0].next_attempt_at, new Date(START + MIN).toISOString(), "1분 뒤");

  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].attempts, 2);
  assertEquals(store.jobs[0].next_attempt_at, new Date(START + 3 * MIN).toISOString(), "2분 뒤");

  advance(MIN);
  const early = await runWorkerOnce(store, h, options, now);
  if (early.ran) assertEquals(early.job, null, "다음 시도 시각 전에는 꺼내지 않는다");

  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  const job = store.jobs[0];
  assertEquals(job.status, "failed");
  assertEquals(job.attempts, 3);
  assertEquals(job.last_error, "스레드 API 500: 잠시 뒤 다시");
  assertEquals(calls.retries.map(([, attempt]) => attempt), [1, 2]);
  assertEquals(calls.failed.length, 1);
});

Deno.test("retry: 실패 뒤 성공하면 done 이 되고 마지막 오류를 비운다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "인스타그램", {});
  const { h } = handlers([() => Promise.reject(new Error("일시 오류")), done]);
  await runWorkerOnce(store, h, options, now);
  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].status, "done");
  assertEquals(store.jobs[0].last_error, null);
});

Deno.test("retry: 다시 시도해도 소용없는 오류(PermanentError)는 바로 failed", async () => {
  const { store, options, now } = setup();
  await store.enqueue("p1", "인스타그램", {});
  const { h, calls } = handlers([() => Promise.reject(new PermanentError("'형식' 값을 확인하세요."))]);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].status, "failed");
  assertEquals(store.jobs[0].attempts, 1);
  assertEquals(calls.retries.length, 0);
  assertEquals(calls.failed, ["'형식' 값을 확인하세요."]);
});

Deno.test("retry: 발행 API 가 성공한 뒤 실패하면 published_id 가 남아 다음 시도가 두 번 올리지 않는다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  let publishCalls = 0;
  const h: JobHandlers = {
    async process(job, hooks) {
      if (!job.published_id) {
        publishCalls++;
        await hooks.markPublished("POST1");
        throw new Error("permalink 조회 실패");
      }
      return { kind: "done" };
    },
    onFailed: () => Promise.resolve(),
  };
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].published_id, "POST1");
  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].status, "done");
  assertEquals(publishCalls, 1);
});

// ---------- 답글(하위 항목) ----------

Deno.test("reply: 본글을 올리면 컨테이너 칸이 비고, 답글 컨테이너가 처리 중이면 같은 줄에 남아 이어서 확인한다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  // 본글 대기 한 번 → 본글 발행 → 답글 컨테이너 대기
  const root = { id: "ROOT", children: [], createdAt: new Date(START).toISOString() };
  const h: JobHandlers = {
    async process(job, hooks) {
      if (!job.published_id && !job.container_id) {
        await hooks.saveContainer(root);
        return { kind: "wait", container: root };
      }
      if (!job.published_id) {
        await hooks.markPublished("POST1");
        assertEquals(job.container_id, null, "본글 컨테이너는 다 썼다");
        const reply = { id: "REPLY1", children: [], createdAt: new Date(now()).toISOString() };
        await hooks.saveContainer(reply);
        return { kind: "wait", container: reply };
      }
      // 다음 실행: 남은 컨테이너는 답글 것이다.
      assertEquals(resumableContainer(job, now())?.id, "REPLY1");
      await hooks.clearContainer();
      return { kind: "done" };
    },
    onFailed: () => Promise.resolve(),
  };
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].wait_started_at, new Date(START).toISOString());
  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  const mid = store.jobs[0];
  assertEquals(mid.status, "pending");
  assertEquals(mid.published_id, "POST1");
  assertEquals(mid.container_id, "REPLY1");
  assertEquals(mid.wait_started_at, new Date(START + MIN).toISOString(), "답글 대기는 30분 한도를 새로 센다");
  assertEquals(mid.attempts, 0);
  advance(MIN);
  await runWorkerOnce(store, h, options, now);
  assertEquals(store.jobs[0].status, "done");
  assertEquals(store.jobs[0].container_id, null);
});

// ---------- 멈춘 줄 복구 ----------

Deno.test("recover: processing 으로 15분 넘게 멈춘 줄은 pending 으로 되돌리고 한 번의 시도로 센다", async () => {
  const { store, options, now, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  await store.claimNext(); // 실행이 이 줄을 잡은 채 죽었다.
  await store.update(1, { container_id: "C1", container_created_at: new Date(START).toISOString() });

  advance(14 * MIN);
  assertEquals(await store.recoverStale(QUEUE_DEFAULTS.staleSeconds, 3), 0, "15분 전에는 그대로");

  advance(2 * MIN);
  const { h, calls } = handlers([done]);
  const report = await runWorkerOnce(store, h, options, now);
  if (report.ran) assertEquals(report.recovered, 1);
  assertEquals(calls.processed.length, 1, "되돌린 줄을 같은 실행이 처리한다");
  assertEquals(calls.processed[0].attempts, 1);
  assertEquals(calls.processed[0].container_id, "C1", "컨테이너는 남겨 이어서 확인한다");
  assert((calls.processed[0].last_error ?? "").includes("[자동복구]"));
  assertEquals(store.jobs[0].status, "done");
});

Deno.test("recover: 재시도 한도를 넘긴 멈춘 줄은 failed 로 확정한다", async () => {
  const { store, advance } = setup();
  await store.enqueue("p1", "스레드", {});
  await store.update(1, { attempts: 2 });
  await store.claimNext();
  advance(16 * MIN);
  assertEquals(await store.recoverStale(900, 3), 1);
  assertEquals(store.jobs[0].status, "failed");
  assertEquals(store.jobs[0].attempts, 3);
  assert(store.jobs[0].finished_at !== null);
});

// ---------- 순수 판단 ----------

Deno.test("containerStep: 메타 컨테이너 상태를 다음 할 일로 바꾼다", () => {
  assertEquals(containerStep("FINISHED"), "ready");
  assertEquals(containerStep("published"), "ready");
  assertEquals(containerStep("IN_PROGRESS"), "wait");
  assertEquals(containerStep(""), "wait");
  assertEquals(containerStep("ERROR"), "error");
  assertEquals(containerStep("EXPIRED"), "expired");
});

Deno.test("resumableContainer: 만든 지 23시간이 넘었거나 없으면 새로 만든다", () => {
  const base: PublishJob = {
    id: 1,
    page_id: "p",
    channel: "스레드",
    payload: {},
    status: "processing",
    attempts: 0,
    next_attempt_at: "",
    last_error: null,
    container_id: "C1",
    container_children: null,
    container_created_at: new Date(START).toISOString(),
    wait_started_at: null,
    published_id: null,
    created_at: "",
    updated_at: "",
    started_at: null,
    finished_at: null,
  };
  assertEquals(resumableContainer(base, START + MIN), { id: "C1", children: [], createdAt: base.container_created_at });
  assertEquals(resumableContainer(base, START + CONTAINER_TTL_MS), null, "만료 직전이면 새로");
  assertEquals(resumableContainer({ ...base, container_id: null }, START), null);
  assertEquals(resumableContainer({ ...base, container_created_at: null }, START), null);
});

Deno.test("failureDecision / waitDecision", () => {
  assertEquals(failureDecision(1, 3, false), "retry");
  assertEquals(failureDecision(2, 3, false), "retry");
  assertEquals(failureDecision(3, 3, false), "failed");
  assertEquals(failureDecision(1, 3, true), "failed");
  assertEquals(waitDecision(null, START, 30 * MIN), "wait");
  assertEquals(waitDecision(new Date(START).toISOString(), START + 29 * MIN, 30 * MIN), "wait");
  assertEquals(waitDecision(new Date(START).toISOString(), START + 30 * MIN, 30 * MIN), "timeout");
});

Deno.test("오류 표시: PermanentError·ContainerExpired 는 모듈을 넘어와도 알아본다", () => {
  assert(isPermanent(new PermanentError("x")));
  assert(!isPermanent(new Error("x")));
  assert(isContainerExpired(new ContainerExpired("x")));
  assert(!isContainerExpired(new Error("x")));
});
