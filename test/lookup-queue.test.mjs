// The rate-limited queue, and the token bucket underneath it. `now` and `sleep`
// are injected throughout so the bucket's arithmetic is exercised without
// waiting out real seconds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLookupQueue } from '../lib/lookup-queue.js';

// A clock the test drives, and a sleep that advances it. Anything waiting wakes
// in the order it went to sleep, which is close enough to the real thing for
// arithmetic that only ever asks how much time has passed.
function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms) => {
      at += ms;
      await null;
    },
    advance: (ms) => {
      at += ms;
    }
  };
}

// A job that records what happened to it. `stale` and `answered` default to the
// ordinary case: the card is still on screen and nothing else has answered it.
function job(key, overrides = {}) {
  const record = {
    key,
    settled: [],
    failed: [],
    stale: () => false,
    answered: () => false,
    ...overrides
  };
  record.settle = (result) => record.settled.push(result);
  record.fail = (error) => record.failed.push(error);
  return record;
}

// Lets the queue's workers run to completion.
async function settle() {
  for (let i = 0; i < 200; i += 1) await null;
}

test('a job runs and is settled with what the work returned', async () => {
  const timer = clock();
  const queue = createLookupQueue({ run: async ({ key }) => `ran ${key}`, ...timer });

  const one = job(1);
  queue.request(one);
  await settle();

  assert.deepEqual(one.settled, ['ran 1']);
  assert.deepEqual(one.failed, []);
  assert.equal(queue.size, 0);
});

test('a job that throws is failed with the error', async () => {
  const timer = clock();
  const boom = new Error('nope');
  const queue = createLookupQueue({
    run: async () => {
      throw boom;
    },
    ...timer
  });

  const one = job(1);
  queue.request(one);
  await settle();

  assert.deepEqual(one.settled, []);
  assert.deepEqual(one.failed, [boom]);
});

// The same episode can sit on two tabs at once. Whichever card is looked at
// first does the asking; the second repoints the job already queued.
test('two asks for one key make one request, and the newer job gets it', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({
    concurrency: 1,
    run: async () => {
      runs += 1;
      return 'answer';
    },
    ...timer
  });

  const first = job(1);
  const second = job(1);
  const third = job(2);
  queue.request(first);
  queue.request(second);
  queue.request(third);
  await settle();

  assert.equal(runs, 2, 'one request per key, not per ask');
  assert.deepEqual(first.settled, [], 'the older job is no longer the one waiting');
  assert.deepEqual(second.settled, ['answer']);
  assert.deepEqual(third.settled, ['answer']);
});

// A key can be asked for again once the first ask has been answered.
test('a key can be requested again after it settles', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({ run: async () => ++runs, ...timer });

  queue.request(job(1));
  await settle();
  queue.request(job(1));
  await settle();

  assert.equal(runs, 2);
});

// The list re-rendered past this card and nothing took its place.
test('a stale job is dropped without spending a request', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({ run: async () => ++runs, ...timer });

  const gone = job(1, { stale: () => true });
  queue.request(gone);
  await settle();

  assert.equal(runs, 0);
  assert.deepEqual(gone.settled, []);
  assert.deepEqual(gone.failed, []);
});

// The answer arrived by other means while the job sat in the queue; the caller
// has already used it, so the queue just lets the job go.
test('an answered job is dropped without spending a request', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({ run: async () => ++runs, ...timer });

  const known = job(1, { answered: () => true });
  queue.request(known);
  await settle();

  assert.equal(runs, 0);
  assert.deepEqual(known.settled, []);
});

// A burst inside the allowance is as welcome as a trickle, so the bucket lets a
// screenful go out together rather than one fixed gap at a time.
test('a burst inside the bucket goes out without waiting', async () => {
  const timer = clock();
  const queue = createLookupQueue({
    bucketSize: 20,
    refillMs: 500,
    concurrency: 4,
    run: async () => 'ok',
    ...timer
  });

  const jobs = Array.from({ length: 20 }, (unused, i) => job(i));
  for (const one of jobs) queue.request(one);
  await settle();

  assert.ok(jobs.every((one) => one.settled.length === 1), 'every job should have run');
  assert.equal(timer.now(), 0, 'nothing inside the bucket should have had to wait');
});

// Past the bucket, the queue slows to the sustained refill rate rather than
// spending an allowance it does not have.
test('a list longer than the bucket waits for its refills', async () => {
  const timer = clock();
  const queue = createLookupQueue({
    bucketSize: 3,
    refillMs: 500,
    concurrency: 1,
    run: async () => 'ok',
    ...timer
  });

  for (let i = 0; i < 5; i += 1) queue.request(job(i));
  await settle();

  // Three went out free; the last two each cost a refill.
  assert.equal(timer.now(), 1000);
});

test('the bucket refills over time, and never past its size', async () => {
  const timer = clock();
  const queue = createLookupQueue({
    bucketSize: 2,
    refillMs: 500,
    concurrency: 1,
    run: async () => 'ok',
    ...timer
  });

  queue.request(job(1));
  queue.request(job(2));
  await settle();
  assert.equal(timer.now(), 0);

  // Long enough to have earned far more tokens than the bucket can hold.
  timer.advance(60_000);
  for (let i = 3; i <= 5; i += 1) queue.request(job(i));
  await settle();

  // Two came from the refilled bucket; the third had to wait one more refill.
  assert.equal(timer.now(), 60_500);
});

// A 429 means the bucket guessed wrong. The window is the problem, not this
// job, so stand down and try it again.
test('a retryable failure stands the queue down and runs the job again', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({
    concurrency: 1,
    backoffMs: 10_000,
    maxRetries: 2,
    isRetryable: (error) => error.retry === true,
    run: async () => {
      runs += 1;
      if (runs === 1) throw Object.assign(new Error('429'), { retry: true });
      return 'ok';
    },
    ...timer
  });

  const one = job(1);
  queue.request(one);
  await settle();

  assert.equal(runs, 2);
  assert.deepEqual(one.settled, ['ok']);
  assert.ok(timer.now() >= 10_000, 'the queue should have waited out the window');
});

test('retries are bounded, and the job then fails like any other', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({
    concurrency: 1,
    backoffMs: 1,
    maxRetries: 2,
    isRetryable: () => true,
    run: async () => {
      runs += 1;
      throw new Error('always');
    },
    ...timer
  });

  const one = job(1);
  queue.request(one);
  await settle();

  assert.equal(runs, 3, 'the first attempt plus maxRetries');
  assert.equal(one.failed.length, 1);
});

// A failure the caller does not call retryable is this job's own, and is
// reported at once rather than waited out.
test('a failure that is not retryable is not retried', async () => {
  const timer = clock();
  let runs = 0;
  const queue = createLookupQueue({
    isRetryable: () => false,
    run: async () => {
      runs += 1;
      throw new Error('404');
    },
    ...timer
  });

  queue.request(job(1));
  await settle();

  assert.equal(runs, 1);
  assert.equal(timer.now(), 0, 'nothing should have stood down over it');
});

test('no more than `concurrency` jobs are in flight at once', async () => {
  const timer = clock();
  let running = 0;
  let peak = 0;
  const queue = createLookupQueue({
    concurrency: 4,
    bucketSize: 100,
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await null;
      running -= 1;
      return 'ok';
    },
    ...timer
  });

  for (let i = 0; i < 20; i += 1) queue.request(job(i));
  await settle();

  assert.equal(peak, 4);
});

// settle() is the caller's code. Whatever it does with the answer, the job has
// already been settled -- it must not then also be reported as a failure.
test('a job is never both settled and failed', async () => {
  const timer = clock();
  let failed = 0;
  const queue = createLookupQueue({
    isRetryable: () => true,
    run: async () => 'ok',
    ...timer
  });

  queue.request({
    key: 1,
    stale: () => false,
    answered: () => false,
    settle: () => {
      throw new Error('the caller came apart');
    },
    fail: () => {
      failed += 1;
    }
  });
  await settle();

  assert.equal(failed, 0);
});

// One worker coming apart must not take the queue with it.
test('the queue carries on after a job settles badly', async () => {
  const timer = clock();
  const queue = createLookupQueue({ concurrency: 1, run: async () => 'ok', ...timer });

  queue.request({
    key: 1,
    stale: () => false,
    answered: () => false,
    settle: () => {
      throw new Error('boom');
    },
    fail: () => {}
  });
  const next = job(2);
  queue.request(next);
  await settle();

  assert.deepEqual(next.settled, ['ok']);
});
