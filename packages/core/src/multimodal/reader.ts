import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

export interface MultimodalContent {
  type: 'image' | 'text';
  mimeType?: string;
  data?: string; // base64 for images
  text?: string; // for text content
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const PDF_EXTENSION = '.pdf';

/**
 * Check if a file path is an image that can be sent to a vision model.
 */
export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Check if a file is a PDF.
 */
export function isPdfFile(filePath: string): boolean {
  return extname(filePath).toLowerCase() === PDF_EXTENSION;
}

/**
 * Read a file and return multimodal content.
 * Images are base64-encoded for vision model consumption.
 * PDFs are parsed to extract text content.
 */
export async function readMultimodalFile(filePath: string, pages?: string): Promise<MultimodalContent | null> {
  if (!existsSync(filePath)) return null;

  const ext = extname(filePath).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    const data = readFileSync(filePath);
    const mimeType = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ext === '.svg' ? 'image/svg+xml'
      : 'application/octet-stream';

    return {
      type: 'image',
      mimeType,
      data: data.toString('base64'),
    };
  }

  if (ext === PDF_EXTENSION) {
    return readPdfFile(filePath, pages);
  }

  // Regular text file
  const content = readFileSync(filePath, 'utf-8');
  return { type: 'text', text: content };
}

/**
 * Extract text from a PDF file.
 * Optionally filter to specific pages (e.g., "1-5", "3", "10-20").
 */
async function readPdfFile(filePath: string, pages?: string): Promise<MultimodalContent> {
  try {
    const pdfParseModule: any = await import('pdf-parse');
    const pdfParse = pdfParseModule.default ?? pdfParseModule;
    const buffer = readFileSync(filePath);
    const data = await pdfParse(buffer);

    let text = data.text;

    // If pages specified, extract only those page ranges
    if (pages && data.numpages > 1) {
      const pageTexts = splitByPages(text, data.numpages);
      const selectedPages = parsePageRange(pages, data.numpages);
      text = selectedPages
        .map((p) => pageTexts[p - 1] ?? '')
        .filter(Boolean)
        .join('\n\n--- Page break ---\n\n');
    }

    // Truncate extremely long PDFs (> 100k chars)
    if (text.length > 100_000) {
      text = text.slice(0, 100_000) + `\n\n[PDF truncated — ${text.length.toLocaleString()} chars total, showing first 100,000]`;
    }

    return {
      type: 'text',
      text: `[PDF: ${data.numpages} pages]\n\n${text}`,
    };
  } catch (err: any) {
    return {
      type: 'text',
      text: `[PDF parsing failed: ${err.message}. Try using a shell tool to extract text with pdftotext.]`,
    };
  }
}

/** Rough page splitting by form feed characters or equal segments. */
function splitByPages(text: string, numPages: number): string[] {
  // Try form feed characters first (many PDFs use these)
  const ffPages = text.split('\f');
  if (ffPages.length >= numPages) return ffPages;

  // Fall back to equal-length segments
  const charsPerPage = Math.ceil(text.length / numPages);
  const pages: string[] = [];
  for (let i = 0; i < numPages; i++) {
    pages.push(text.slice(i * charsPerPage, (i + 1) * charsPerPage));
  }
  return pages;
}

/** Parse page range string: "1-5", "3", "1,3,5-7" */
function parsePageRange(pages: string, max: number): number[] {
  const result = new Set<number>();
  for (const part of pages.split(',')) {
    const range = part.trim().split('-');
    if (range.length === 2) {
      const start = Math.max(1, parseInt(range[0], 10) || 1);
      const end = Math.min(max, parseInt(range[1], 10) || max);
      for (let i = start; i <= end; i++) result.add(i);
    } else {
      const page = parseInt(part.trim(), 10);
      if (page >= 1 && page <= max) result.add(page);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

/**
 * Check if a model supports vision (for routing decisions).
 */
export function requiresVisionModel(contents: MultimodalContent[]): boolean {
  return contents.some((c) => c.type === 'image');
}
