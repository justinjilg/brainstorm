import { z } from "zod";
import { defineTool } from "../base.js";
import { getBrowserHeaders } from "./web-fetch.js";

export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the web for information. Returns search result snippets.",
  permission: "auto",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
  }),
  async execute({ query }) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      // Share the rotating anti-fingerprinting headers with web_fetch.
      // Pre-fix this sent `User-Agent: BrainstormCLI/0.1` — the EXACT
      // static UA that web-fetch.ts's comment calls out as
      // "identified as a fingerprinting vector in the Agent Traps
      // analysis." DuckDuckGo (and any other site that profiles
      // agent traffic) could fingerprint-and-throttle Brainstorm
      // queries from this one string alone, while web_fetch stayed
      // invisible. Unifying under getBrowserHeaders closes the gap.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: getBrowserHeaders(),
      });
      const html = await response.text();

      // Extract snippets from DuckDuckGo HTML results
      const results: Array<{ title: string; snippet: string }> = [];
      const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const titlePattern = /class="result__a"[^>]*>([^<]*)<\/a>/g;

      const titles: string[] = [];
      let m;
      while ((m = titlePattern.exec(html)) !== null && titles.length < 5) {
        titles.push(m[1].trim());
      }

      const snippets: string[] = [];
      while ((m = snippetPattern.exec(html)) !== null && snippets.length < 5) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }

      for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
        results.push({ title: titles[i], snippet: snippets[i] });
      }

      return { results, query };
    } catch (err: any) {
      return { error: err.message, query };
    }
  },
});
