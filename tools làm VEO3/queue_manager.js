const { Semaphore, RateLimiter } = require('./concurrency');
const { EventEmitter } = require('events');

class QueueManager extends EventEmitter {
  constructor(apiClient, tokenManager, options = {}) {
    super();
    this.api = apiClient;
    this.tokenManager = tokenManager;

    // Configurable limits
    this.maxGenerations = options.maxGenerations || 7;
    this.rateLimitMs = options.rateLimitMs || 4000;

    // Concurrency components
    this.generationSemaphore = new Semaphore(this.maxGenerations);
    this.rateLimiter = new RateLimiter(this.rateLimitMs);

    // State queues
    this.pendingJobs = [];
    this.pollingJobs = [];
    this.completedJobs = [];
    this.failedJobs = [];

    // Background loop handles
    this._generationLoopRunning = false;
    this._pollingLoopRunning = false;
  }

  /**
   * Enqueue a new text-to-image/video generation task
   */
  enqueueGeneration(prompt, type = 'image', apiOptions = {}) {
    const job = {
      id: `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      prompt,
      type,
      options: apiOptions,
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0
    };

    this.pendingJobs.push(job);
    this.emit('job:added', job);
    this._startGenerationLoop();
    return job.id;
  }

  /**
   * Internal Background Loop — Pवासी requests to Google
   */
  async _startGenerationLoop() {
    if (this._generationLoopRunning) return;
    this._generationLoopRunning = true;

    try {
      while (this.pendingJobs.length > 0) {
        // Pop oldest job
        const job = this.pendingJobs.shift();
        job.status = 'processing';
        this.emit('job:processing', job);

        this._processJobAsync(job).catch(err => {
          console.error(`[Queue] Unhandled async generation error for ${job.id}:`, err);
        });
      }
    } finally {
      this._generationLoopRunning = false;
    }
  }

  async _processJobAsync(job) {
    try {
      // 1. Wait for an open slot in the pipeline (max 7 active)
      await this.generationSemaphore.acquire();
      try {
        // 2. Hard Rate Limiter: wait 4 seconds since the last dispatch
        await this.rateLimiter.throttle();

        job.attempts++;
        this.emit('job:dispatching', job);

        // 3. Fire the API (which internally calls tokenManager and gotScraping)
        let result;
        if (job.type === 'image') {
          result = await this.api.generateImage(job.prompt, job.options);
        } else {
          result = await this.api.generateVideo(job.prompt, job.options);
        }

        // If returned successfully, move to Polling
        job.status = 'polling';
        job.mediaIds = typeof result === 'object' && result.media ? [result.media.mediaId] : [];
        this.pollingJobs.push(job);
        this.emit('job:polling', job);

        if (!this._pollingLoopRunning) this._startPollingLoop();

      } finally {
        // Release the slot so the next background job can begin
        this.generationSemaphore.release();
      }
    } catch (err) {
      if (err.message.includes('403') || err.message.includes('UNUSUAL_ACTIVITY')) {
        console.warn(`[Queue] Job ${job.id} hit a 403 on attempt ${job.attempts}.`);
        // If we want retry logic, push it back
        if (job.attempts < 3) {
          job.status = 'pending';
          this.pendingJobs.unshift(job); // prioritize
          this._startGenerationLoop();
        } else {
          job.status = 'error';
          job.error = err.message;
          this.failedJobs.push(job);
          this.emit('job:failed', job);
        }
      } else {
        job.status = 'error';
        job.error = err.message;
        this.failedJobs.push(job);
        this.emit('job:failed', job);
      }
    }
  }

  /**
   * Continuously polls active media generation endpoints.
   */
  async _startPollingLoop() {
    if (this._pollingLoopRunning) return;
    this._pollingLoopRunning = true;

    try {
      while (this.pollingJobs.length > 0) {
        // Example: batched polling
        // For now, sequentially poll for simplicity (upgrade to batch polling in future)
        for (let i = this.pollingJobs.length - 1; i >= 0; i--) {
          const job = this.pollingJobs[i];
          // In actual integration, call api.pollMedia(job.mediaIds)
          // For now, mock completion check
          if (true /* mock: check if done */) {
            job.status = 'completed';
            this.completedJobs.push(job);
            this.pollingJobs.splice(i, 1);
            this.emit('job:completed', job);
          }
        }
        await new Promise(r => setTimeout(r, 10000)); // Poll every 10 seconds
      }
    } finally {
      this._pollingLoopRunning = false;
    }
  }
}

module.exports = QueueManager;
