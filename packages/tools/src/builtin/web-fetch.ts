import { z } from 'zod';
import { defineTool } from '../base.js';

export const webFetchTool = defineTool({
  name: 'web_fetch',
  description: 'Fetch and return the content of a URL.',
  permission: 'auto',
  inputSchema: z.object({
    url: z.string().describe('URL to fetch'),
    maxLength: z.number().optional().describe('Max response length in characters (default: 10000)'),
  }),
  async execute({ url, maxLength }) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'BrainstormCLI/0.1' },
      });
      if (!response.ok) return { error: `HTTP ${response.status}: ${response.statusText}`, url };
      const text = await response.text();
      const limit = maxLength ?? 10000;
      return {
        content: text.slice(0, limit),
        truncated: text.length > limit,
        contentType: response.headers.get('content-type') ?? 'unknown',
        url,
      };
    } catch (err: any) {
      return { error: err.message, url };
    }
  },
});
