import { describe, it, expect } from 'vitest';
import { filterResponse, createStreamFilter } from '../agent/response-filter';

describe('response-filter', () => {
  describe('filterResponse', () => {
    it('strips leading filler: Sure!', () => {
      const result = filterResponse('Sure! Here is the answer.');
      expect(result).toBe('Here is the answer.');
    });

    it('strips leading filler: Of course!', () => {
      const result = filterResponse('Of course! Let me help you.');
      expect(result).toBe('Let me help you.');
    });

    it('strips leading filler: Absolutely!', () => {
      const result = filterResponse('Absolutely! Here is what you need.');
      expect(result).toBe('Here is what you need.');
    });

    it('strips leading filler: I\'d be happy to help', () => {
      const result = filterResponse('I\'d be happy to help. Here is the solution.');
      expect(result).toBe('Here is the solution.');
    });

    it('strips trailing summaries', () => {
      const response = 'Here is the detailed answer.\n\nTo summarize, this is important.';
      const result = filterResponse(response);
      expect(result).toBe('Here is the detailed answer.');
    });

    it('strips trailing summaries with "In summary,"', () => {
      const response = 'Content here.\n\nIn summary, key points are X, Y, and Z.';
      const result = filterResponse(response);
      expect(result).toBe('Content here.');
    });

    it('strips trailing summaries with "To recap,"', () => {
      const response = 'Full explanation.\n\nTo recap, remember these things.';
      const result = filterResponse(response);
      expect(result).toBe('Full explanation.');
    });

    it('preserves content without filler', () => {
      const response = 'This is a clean response with no filler.';
      const result = filterResponse(response);
      expect(result).toBe('This is a clean response with no filler.');
    });

    it('handles case-insensitive matching for filler', () => {
      const result = filterResponse('SURE! Here is the answer.');
      expect(result).toBe('Here is the answer.');
    });

    it('handles case-insensitive matching for trailing summaries', () => {
      const response = 'Content.\n\nIN SUMMARY, here it is.';
      const result = filterResponse(response);
      expect(result).toBe('Content.');
    });

    it('strips multiple filler patterns if present', () => {
      const result = filterResponse('Absolutely! I\'d be happy to help. Here is the answer.');
      expect(result).toBe('Here is the answer.');
    });

    it('handles whitespace after filler correctly', () => {
      const result = filterResponse('Great question!    Here is the answer.');
      expect(result).toBe('Here is the answer.');
    });
  });

  describe('createStreamFilter', () => {
    it('buffers content under 80 characters without emitting', () => {
      const filter = createStreamFilter();
      const output1 = filter.filter('Sure! This is ');
      expect(output1).toBe('');
      const output2 = filter.filter('a short message.');
      expect(output2).toBe('');
    });

    it('emits filtered content once buffer threshold is reached', () => {
      const filter = createStreamFilter();
      filter.filter('Sure! ');
      // This delta brings total to >= 80 chars, triggers flush
      const output = filter.filter(
        'This is a longer message that exceeds the buffer threshold and keeps going.'
      );
      // Output should contain the filtered buffer (filler stripped)
      expect(output).not.toContain('Sure!');
      expect(output).toContain('This is a longer');
    });

    it('strips filler when buffer reaches threshold', () => {
      const filter = createStreamFilter();
      filter.filter('Absolutely! ');
      const output = filter.filter('Here is content that makes it long enough to emit now and keeps going.');
      expect(output).not.toContain('Absolutely!');
      expect(output).toContain('Here is content');
    });

    it('flush works for short content without exceeding threshold', () => {
      const filter = createStreamFilter();
      filter.filter('Sure! Short text.');
      const output = filter.flush();
      expect(output).toBe('Short text.');
    });

    it('flush returns empty string if already flushed', () => {
      const filter = createStreamFilter();
      // Trigger flush by reaching threshold
      filter.filter('Sure! ');
      filter.filter('This content is long enough to trigger threshold and will flush immediately.');
      // Now flush should return empty because already flushed
      const output = filter.flush();
      expect(output).toBe('');
    });

    it('allows normal deltas after threshold is reached', () => {
      const filter = createStreamFilter();
      // Fill buffer to trigger threshold
      filter.filter('Sure! ');
      filter.filter('This is enough content to pass eighty characters threshold and keep going forward.');
      // Now send more content - should pass through unfiltered
      const output = filter.filter(' More content.');
      expect(output).toBe(' More content.');
    });

    it('handles empty deltas gracefully', () => {
      const filter = createStreamFilter();
      const output1 = filter.filter('');
      expect(output1).toBe('');
      const output2 = filter.filter('Sure! Here is some content that exceeds the buffer limit and keeps going longer.');
      expect(output2).not.toContain('Sure!');
      expect(output2).toContain('Here is some');
    });

    it('buffers multiple small deltas until threshold', () => {
      const filter = createStreamFilter();
      filter.filter('S');
      filter.filter('u');
      filter.filter('r');
      filter.filter('e');
      filter.filter('! ');
      // Each call should return empty string while under threshold
      const output = filter.filter(
        'This content makes the buffer exceed eighty characters total length and continues further.'
      );
      expect(output).not.toContain('Sure!');
      expect(output).toContain('This content');
    });

    it('preserves content that does not match filler patterns', () => {
      const filter = createStreamFilter();
      const output = filter.filter(
        'This is a normal response without any filler that exceeds eighty characters total.'
      );
      expect(output).toBe(
        'This is a normal response without any filler that exceeds eighty characters total.'
      );
    });

    it('handles content with multiple filler patterns in buffer', () => {
      const filter = createStreamFilter();
      filter.filter('Sure! I\'d be happy to help. ');
      const output = filter.filter(
        'Here is the actual content you requested immediately available now.'
      );
      expect(output).not.toContain('Sure!');
      expect(output).not.toContain('I\'d be happy to help');
      expect(output).toContain('Here is the actual');
    });

    it('strips trailing whitespace from filler correctly', () => {
      const filter = createStreamFilter();
      filter.filter('Great question!   ');
      const output = filter.filter(
        'Here is the answer that exceeds the eighty character buffer threshold.'
      );
      expect(output).not.toContain('Great question!');
      expect(output).toMatch(/^Here is the answer/);
    });
  });
});
