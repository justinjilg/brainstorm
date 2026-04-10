import { describe, it, expect } from "vitest";
import {
  getToolOutputTrust,
  getToolTrustThreshold,
  createTrustWindow,
  recordToolTrust,
  checkToolTrust,
} from "../trust-labels";
import { sanitizeContent, extractText } from "../content-sanitizer";
import { scanForCredentials, redactCredentials } from "../secret-scanner";

describe("trust-labels", () => {
  describe("getToolOutputTrust", () => {
    it("should return 0.2 for untrusted output tools", () => {
      expect(getToolOutputTrust("web_fetch")).toBe(0.2);
      expect(getToolOutputTrust("web_search")).toBe(0.2);
    });

    it("should return 0.5 for semi-trusted tools", () => {
      expect(getToolOutputTrust("git_log")).toBe(0.5);
      expect(getToolOutputTrust("git_diff")).toBe(0.5);
    });

    it("should return 0.7 for moderate trust tools", () => {
      expect(getToolOutputTrust("file_read")).toBe(0.7);
      expect(getToolOutputTrust("glob")).toBe(0.7);
      expect(getToolOutputTrust("grep")).toBe(0.7);
      expect(getToolOutputTrust("list_dir")).toBe(0.7);
      expect(getToolOutputTrust("git_status")).toBe(0.7);
    });

    it("should return 0.5 for default tools", () => {
      expect(getToolOutputTrust("some_new_tool")).toBe(0.5);
    });
  });

  describe("getToolTrustThreshold", () => {
    it("should return the correct threshold for high-risk tools", () => {
      expect(getToolTrustThreshold("shell")).toBe(0.5);
      expect(getToolTrustThreshold("file_write")).toBe(0.5);
      expect(getToolTrustThreshold("git_commit")).toBe(0.5);
    });

    it("should return the correct threshold for God Mode tools", () => {
      expect(getToolTrustThreshold("agent_run_tool")).toBe(0.7);
      expect(getToolTrustThreshold("agent_kill_switch")).toBe(0.9);
    });

    it("should return the correct threshold for memory tools", () => {
      expect(getToolTrustThreshold("memory")).toBe(0.4);
    });

    it("should return null for tools without a specific threshold", () => {
      expect(getToolTrustThreshold("web_fetch")).toBeNull();
      expect(getToolTrustThreshold("some_safe_tool")).toBeNull();
    });
  });

  describe("sanitizeContent", () => {
    it("should remove script tags", () => {
      const raw = '<div><script>alert("xss")</script>hello</div>';
      const result = sanitizeContent(raw);
      expect(result.content).toBe("<div>hello</div>");
      expect(result.strippedCount).toBe(1);
      expect(result.strippedCategories).toContain("dangerous-tags");
      expect(result.modified).toBe(true);
    });

    it("should remove style tags", () => {
      const raw = "<div><style>body{color:red}</style>hello</div>";
      const result = sanitizeContent(raw);
      expect(result.content).toBe("<div>hello</div>");
    });

    it("should remove event handlers", () => {
      const raw = '<img src="x" onerror="alert(1)">';
      const result = sanitizeContent(raw);
      expect(result.content).toBe('<img src="x">');
      expect(result.strippedCategories).toContain("event-handlers");
    });

    it("should remove dangerous URLs", () => {
      const raw = '<a href="javascript:alert(1)">click</a>';
      const result = sanitizeContent(raw);
      expect(result.content).toBe("<a>click</a>");
      expect(result.strippedCategories).toContain("dangerous-urls");
    });

    it("should remove HTML comments", () => {
      const raw = "<!-- secret instructions --><div>hello</div>";
      const result = sanitizeContent(raw);
      expect(result.content).toBe("<div>hello</div>");
      expect(result.strippedCategories).toContain("html-comments");
    });

    it("should handle complex mixed content", () => {
      const raw = `
          <div onload="foo()">
            <script>alert('malicious')</script>
            <p>
              Hello <!-- comment --> World
              <a href="javascript:void(0)">Click Me</a>
              <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">
            </p>
          </div>
        `;
      const result = sanitizeContent(raw);
      expect(result.content).not.toContain("onload");
      expect(result.content).not.toContain("<script>");
      expect(result.content).not.toContain("javascript:");
      expect(result.content).not.toContain("<!--");
      expect(result.strippedCount).toBeGreaterThan(0);
      expect(result.modified).toBe(true);
    });
  });

  describe("redactCredentials", () => {
    it("should redact AWS Access Keys", () => {
      const text = "My key is AKIAIOSFODNN7EXAMPLE and secret.";
      expect(redactCredentials(text)).toBe("My key is [REDACTED] and secret.");
    });

    it("should redact GitHub Tokens", () => {
      const text = "My token is ghp_abcdefghijklmnopqrstuvwxyz0123456789.";
      expect(redactCredentials(text)).toBe("My token is [REDACTED].");
    });

    it("should redact OpenAI Keys", () => {
      const text =
        "My OpenAI key: sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.";
      expect(redactCredentials(text)).toBe("My OpenAI key: [REDACTED].");
    });

    it("should redact Google/Gemini API Keys", () => {
      const text = "API_KEY=AIzaB3stK3yEver0123456789abcdefghij"; // 39 chars
      expect(redactCredentials(text)).toBe("API_KEY=[REDACTED]");
    });

    it("should redact generic credentials", () => {
      const text = "password=supersecrettoken";
      expect(redactCredentials(text)).toBe("password=[REDACTED]");
    });

    it("should handle multiple redactions in one text", () => {
      const text =
        "AWS_KEY=AKIAV4P2Y5G2H1J3K4L5 OpenAI_KEY=sk-testapikeyvalue1234567890abcdef Github_TOKEN=ghp_testgithubtoken1234567890abcdefghi";
      expect(redactCredentials(text)).toBe(
        "AWS_KEY=[REDACTED] OpenAI_KEY=[REDACTED] Github_TOKEN=[REDACTED]",
      );
    });

    it("should not redact safe text", () => {
      const text = "This is a safe string with no credentials.";
      expect(redactCredentials(text)).toBe(text);
    });
  });
});
