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
 * PDFs return a text note (full PDF parsing deferred to future PR).
 */
export function readMultimodalFile(filePath: string): MultimodalContent | null {
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
    return {
      type: 'text',
      text: '[PDF file detected. Full PDF parsing will be available in a future update. For now, use a tool to extract text from the PDF.]',
    };
  }

  // Regular text file
  const content = readFileSync(filePath, 'utf-8');
  return { type: 'text', text: content };
}

/**
 * Check if a model supports vision (for routing decisions).
 */
export function requiresVisionModel(contents: MultimodalContent[]): boolean {
  return contents.some((c) => c.type === 'image');
}
