import fs from 'node:fs';

export default {
  name: 'read_file',
  description: 'Read a file from the filesystem. Supports reading specific line ranges with offset and limit.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative path to the file' },
      offset: { type: 'number', description: 'Start reading from this line number (0-based, default 0)' },
      limit: { type: 'number', description: 'Maximum number of lines to read (default: 200)' },
    },
    required: ['path'],
  },
  async execute(args) {
    const { path: filePath, offset = 0, limit = 200 } = args;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;
      const start = Math.max(0, Math.min(offset, totalLines));
      const slice = lines.slice(start, start + limit);
      const header = `[Lines ${start}-${start + slice.length} of ${totalLines} total]`;
      return { result: header + '\n' + slice.join('\n') };
    } catch (err) {
      return { result: `ERROR: ${err.message}` };
    }
  },
};
