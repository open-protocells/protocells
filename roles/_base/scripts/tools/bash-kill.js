
if (!globalThis.__bashJobs) globalThis.__bashJobs = new Map();
const jobs = globalThis.__bashJobs;

export default {
  name: 'bash_kill',
  description: 'Kill a running background bash job by its job ID. Returns the output captured so far.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The job ID returned by bash when it went async' },
    },
    required: ['id'],
  },
  async execute(args) {
    const { id } = args;
    const job = jobs.get(id);
    if (!job) {
      return { result: 'No running job with id: ' + id + '. It may have already completed.' };
    }
    try {
      job.child.kill('SIGTERM');
      // Give it a moment, then force kill if needed
      setTimeout(() => { try { job.child.kill('SIGKILL'); } catch {} }, 2000);
    } catch (err) {
      return { result: 'Failed to kill job ' + id + ': ' + err.message };
    }
    return { result: 'Job ' + id + ' killed. Output was being streamed to: ' + job.outputPath };
  },
};
