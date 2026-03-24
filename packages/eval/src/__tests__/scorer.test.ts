import { describe, it, expect } from 'vitest';
import { scoreProbe } from '../scorer.js';
import type { Probe, ProbeOutput } from '../types.js';

describe('scoreProbe', () => {
  const createProbe = (verify: Probe['verify']): Probe => ({
    id: 'test-probe',
    capability: 'tool-selection',
    prompt: 'Test prompt',
    verify,
  });

  const createResult = (output: Partial<ProbeOutput>): ProbeOutput => ({
    output: '',
    toolCalls: [],
    steps: 0,
    sandboxDir: '/tmp/sandbox',
    ...output,
  });

  describe('tool_calls_include', () => {
    it('should pass when required tool is called', () => {
      const probe = createProbe({
        tool_calls_include: ['file_read'],
      });

      const result = createResult({
        toolCalls: [
          { name: 'file_read', argsPreview: '{path: "test.ts"}' },
          { name: 'shell', argsPreview: '{command: "ls"}' },
        ],
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'tool_calls_include: file_read',
        passed: true,
        detail: undefined,
      });
    });

    it('should fail when required tool is not called', () => {
      const probe = createProbe({
        tool_calls_include: ['file_read'],
      });

      const result = createResult({
        toolCalls: [
          { name: 'shell', argsPreview: '{command: "ls"}' },
          { name: 'glob', argsPreview: '{pattern: "**/*.ts"}' },
        ],
        output: 'Some output',
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'tool_calls_include: file_read',
        passed: false,
        detail: "Tool 'file_read' not called. Used: shell, glob",
      });
    });

    it('should check multiple required tools', () => {
      const probe = createProbe({
        tool_calls_include: ['file_read', 'shell'],
      });

      const result = createResult({
        toolCalls: [
          { name: 'file_read', argsPreview: '{path: "test.ts"}' },
          { name: 'glob', argsPreview: '{pattern: "**/*.ts"}' },
        ],
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(2);
      
      expect(checks[0]).toEqual({
        check: 'tool_calls_include: file_read',
        passed: true,
        detail: undefined,
      });
      
      expect(checks[1]).toEqual({
        check: 'tool_calls_include: shell',
        passed: false,
        detail: "Tool 'shell' not called. Used: file_read, glob",
      });
    });
  });

  describe('tool_calls_exclude', () => {
    it('should pass when forbidden tool is absent', () => {
      const probe = createProbe({
        tool_calls_exclude: ['shell'],
      });

      const result = createResult({
        toolCalls: [
          { name: 'file_read', argsPreview: '{path: "test.ts"}' },
          { name: 'glob', argsPreview: '{pattern: "**/*.ts"}' },
        ],
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'tool_calls_exclude: shell',
        passed: true,
        detail: undefined,
      });
    });

    it('should fail when forbidden tool is called', () => {
      const probe = createProbe({
        tool_calls_exclude: ['shell'],
      });

      const result = createResult({
        toolCalls: [
          { name: 'file_read', argsPreview: '{path: "test.ts"}' },
          { name: 'shell', argsPreview: '{command: "rm -rf /"}' },
          { name: 'glob', argsPreview: '{pattern: "**/*.ts"}' },
        ],
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'tool_calls_exclude: shell',
        passed: false,
        detail: "Tool 'shell' was called but should not have been",
      });
    });
  });

  describe('answer_contains', () => {
    it('should perform case-insensitive matching', () => {
      const probe = createProbe({
        answer_contains: ['Hello World', 'TEST'],
      });

      const result = createResult({
        output: 'hello world! This is a test output.',
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(2);
      
      expect(checks[0]).toEqual({
        check: 'answer_contains: "Hello World"',
        passed: true,
        detail: undefined,
      });
      
      expect(checks[1]).toEqual({
        check: 'answer_contains: "TEST"',
        passed: true,
        detail: undefined,
      });
    });

    it('should fail when text is not found', () => {
      const probe = createProbe({
        answer_contains: ['required phrase'],
      });

      const result = createResult({
        output: 'This output does not contain the needed text.',
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'answer_contains: "required phrase"',
        passed: false,
        detail: 'Output does not contain "required phrase"',
      });
    });
  });

  describe('min_steps and max_steps', () => {
    it('should pass when steps are within range', () => {
      const probe = createProbe({
        min_steps: 2,
        max_steps: 5,
      });

      const result = createResult({
        steps: 3,
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(2);
      
      expect(checks[0]).toEqual({
        check: 'min_steps: 2',
        passed: true,
        detail: undefined,
      });
      
      expect(checks[1]).toEqual({
        check: 'max_steps: 5',
        passed: true,
        detail: undefined,
      });
    });

    it('should fail when steps are below minimum', () => {
      const probe = createProbe({
        min_steps: 3,
      });

      const result = createResult({
        steps: 1,
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'min_steps: 3',
        passed: false,
        detail: 'Only 1 steps, need at least 3',
      });
    });

    it('should fail when steps exceed maximum', () => {
      const probe = createProbe({
        max_steps: 3,
      });

      const result = createResult({
        steps: 5,
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'max_steps: 3',
        passed: false,
        detail: 'Used 5 steps, max allowed is 3',
      });
    });
  });

  describe('empty verify object', () => {
    it('should return empty checks array', () => {
      const probe = createProbe({});
      const result = createResult({});

      const checks = scoreProbe(probe, result);
      expect(checks).toEqual([]);
    });
  });

  describe('combined checks', () => {
    it('should handle multiple verification criteria together', () => {
      const probe = createProbe({
        tool_calls_include: ['file_read'],
        tool_calls_exclude: ['shell'],
        answer_contains: ['success'],
        min_steps: 1,
        max_steps: 10,
      });

      const result = createResult({
        toolCalls: [
          { name: 'file_read', argsPreview: '{path: "test.ts"}' },
          { name: 'glob', argsPreview: '{pattern: "**/*.ts"}' },
        ],
        output: 'Operation completed successfully!',
        steps: 5,
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(5);
      
      // All checks should pass
      expect(checks.every(check => check.passed)).toBe(true);
      
      // Verify each check type is present
      const checkTypes = checks.map(c => c.check);
      expect(checkTypes).toContain('tool_calls_include: file_read');
      expect(checkTypes).toContain('tool_calls_exclude: shell');
      expect(checkTypes).toContain('answer_contains: "success"');
      expect(checkTypes).toContain('min_steps: 1');
      expect(checkTypes).toContain('max_steps: 10');
    });
  });

  describe('answer_excludes', () => {
    it('should pass when forbidden text is absent', () => {
      const probe = createProbe({
        answer_excludes: ['password', 'secret'],
      });

      const result = createResult({
        output: 'This is a safe output without sensitive information.',
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(2);
      
      expect(checks[0]).toEqual({
        check: 'answer_excludes: "password"',
        passed: true,
        detail: undefined,
      });
      
      expect(checks[1]).toEqual({
        check: 'answer_excludes: "secret"',
        passed: true,
        detail: undefined,
      });
    });

    it('should fail when forbidden text is present (case-insensitive)', () => {
      const probe = createProbe({
        answer_excludes: ['password'],
      });

      const result = createResult({
        output: 'The user PASSWORD is: admin123',
      });

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'answer_excludes: "password"',
        passed: false,
        detail: 'Output contains forbidden text "password"',
      });
    });
  });

  describe('unimplemented checks', () => {
    it('should return placeholder for code_compiles', () => {
      const probe = createProbe({
        code_compiles: true,
      });

      const result = createResult({});

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'code_compiles',
        passed: true,
        detail: 'Compilation check not yet implemented',
      });
    });

    it('should return placeholder for files_modified', () => {
      const probe = createProbe({
        files_modified: ['src/main.ts', 'package.json'],
      });

      const result = createResult({});

      const checks = scoreProbe(probe, result);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual({
        check: 'files_modified: src/main.ts, package.json',
        passed: true,
        detail: 'File modification check not yet implemented',
      });
    });
  });
});