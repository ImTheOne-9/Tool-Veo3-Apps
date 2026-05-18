/**
 * Concurrency primitives to strictly manage API dispatch throughput.
 * Helps evade 'UNUSUAL_ACTIVITY' by pacing requests and capping in-flight load.
 */

class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      nextResolve();
    } else {
      this.current--;
    }
  }
}

class RateLimiter {
  constructor(minDelayMs) {
    this.minDelayMs = minDelayMs;
    this.lastDispatchedAt = 0;
    this._lock = new Semaphore(1); // Ensure requests queue serially for the timestamp check
  }

  /**
   * Blocks until minDelayMs has elapsed since the last throttle() returned.
   */
  async throttle() {
    await this._lock.acquire();
    try {
      const now = Date.now();
      const nextAvailableTime = this.lastDispatchedAt + this.minDelayMs;
      const waitTime = nextAvailableTime - now;

      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      this.lastDispatchedAt = Date.now();
    } finally {
      this._lock.release();
    }
  }
}

module.exports = { Semaphore, RateLimiter };
