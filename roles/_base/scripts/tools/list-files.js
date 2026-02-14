import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'list_files',
  description: 'List files and directories at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: current directory)' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
    },
  },
  async execute(args) {
    const { path: dirPath = '.', recursive = false } = args;
    try {
      if (recursive) {
        const result = listRecursive(dirPath, '');
        return { result: result.join('\n') || '(empty directory)' };
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const result = entries.map(e => e.isDirectory() ? e.name + '/' : e.name);
      return { result: result.join('\n') || '(empty directory)' };
    } catch (err) {
      return { result: `ERROR: ${err.message}` };
    }
  },
};

function listRecursive(dir, prefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      result.push(rel + '/');
      result.push(...listRecursive(path.join(dir, entry.name), rel));
    } else {
      result.push(rel);
    }
  }
  return result;
}
