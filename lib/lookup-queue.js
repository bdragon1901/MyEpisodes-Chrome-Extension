// A rate-limited work queue, and the token bucket underneath it.
//
// This exists because TVmaze asks for no more than about 20 requests every 10
// seconds but says nothing about how they should be spread: a burst inside the
// allowance is as welcome as a trickle. So the queue spends from a bucket of 20
// that refills at one token every 500ms. A typical day's dozen-odd lookups go
// out together and land together, and only a list long enough to drain the
// bucket slows to the sustained rate -- where a fixed gap between requests made
// even a short day trickle in for seconds.
//
// A job is:
//
//   key        what two callers wanting the same work agree on
//   stale()    true when nothing is waiting for this any more
//   answered() true when the answer arrived by other means -- the caller has
//              already used it, and the queue drops the job without spending a
//              request on it
//   settle(result) / fail(error)   the outcome, exactly one of them, once
//
// `now` and `sleep` are injectable so the bucket's arithmetic can be tested
// without waiting out real seconds.

export function createLookupQueue({
  run,
  concurrency = 4,
  bucketSize = 20,
  refillMs = 500,
  backoffMs = 10_000,
  maxRetries = 2,
  isRetryable = () => false,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const queue = [];
  // key -> the entry queued for it, so a second caller repoints the work
  // already queued instead of asking for the same thing again.
  const pending = new Map();
  let workers = 0;
  let tokens = bucketSize;
  let lastRefill = now();
  let stalledUntil = 0;

  function request(job) {
    const queued = pending.get(job.key);
    if (queued) {
      // Whoever asked first does the asking. The newer job is the one still
      // being waited on, so it takes over -- keeping the attempts the older one
      // has already spent, which is what stops a repointed job retrying for
      // ever.
      queued.job = job;
      return;
    }

    const entry = { job, attempts: 0 };
    pending.set(job.key, entry);
    queue.push(entry);
    drain();
  }

  function drain() {
    while (workers < concurrency && queue.length) {
      workers += 1;
      worker()
        // A job's own failure is reported through fail(); anything reaching
        // here is the queue itself coming apart, and is not worth taking the
        // caller down over.
        .catch(() => {})
        .finally(() => {
          workers -= 1;
          // A worker that stopped with jobs still queued has left them with
          // nobody to run them. Only reachable if something above came apart,
          // but the cost of being wrong is a queue that silently stops.
          if (queue.length) drain();
        });
    }
  }

  // A job's callbacks are the caller's code, and a queue that stopped because
  // one of them threw would take every job behind it down too. So they are
  // called at arm's length: a predicate that throws reads as false, and a
  // settle or fail that throws is the caller's problem, not the next job's.
  function ask(predicate) {
    try {
      return predicate();
    } catch {
      return false;
    }
  }

  function tell(notify) {
    try {
      notify();
    } catch {
      // The job is settled either way.
    }
  }

  async function worker() {
    while (queue.length) {
      const waiting = stalledUntil - now();
      if (waiting > 0) await sleep(waiting);

      const entry = queue.shift();
      if (!entry) continue;

      if (finished(entry)) continue;

      await takeToken();

      // Holding a token can mean waiting, and the caller may have moved on
      // while this job held one. Hand it back rather than spending it.
      if (finished(entry)) {
        tokens = Math.min(bucketSize, tokens + 1);
        continue;
      }

      let result;
      try {
        result = await run(entry.job);
      } catch (error) {
        if (isRetryable(error) && entry.attempts < maxRetries) {
          // The window is the problem, not this job. Empty the bucket, hold
          // every worker off, and put the job back rather than losing it.
          stalledUntil = now() + backoffMs;
          tokens = 0;
          lastRefill = stalledUntil;
          entry.attempts += 1;
          queue.push(entry);
        } else {
          pending.delete(entry.job.key);
          tell(() => entry.job.fail(error));
        }
        continue;
      }

      // Outside the try: what settle() does with the answer is the caller's
      // business, and a job must never be both settled and failed.
      pending.delete(entry.job.key);
      tell(() => entry.job.settle(result));
    }
  }

  // Both ways a job stops being worth a request. Checked before a token is
  // spent and again after one is held, since either can become true in between.
  function finished(entry) {
    if (ask(() => entry.job.stale()) || ask(() => entry.job.answered())) {
      pending.delete(entry.job.key);
      return true;
    }
    return false;
  }

  // Hands back one token, waiting for the next refill if the bucket is empty.
  async function takeToken() {
    for (;;) {
      const at = now();
      const gained = Math.floor((at - lastRefill) / refillMs);
      if (gained > 0) {
        tokens = Math.min(bucketSize, tokens + gained);
        lastRefill += gained * refillMs;
      }

      if (tokens > 0) {
        tokens -= 1;
        return;
      }

      await sleep(Math.max(1, refillMs - (at - lastRefill)));
    }
  }

  return {
    request,
    // What is queued but not yet run. For tests and for anything that wants to
    // know whether the queue has caught up.
    get size() {
      return queue.length;
    }
  };
}
