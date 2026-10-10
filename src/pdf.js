const { HttpError } = require('./errors');

const CHUNK_SIZE = 1200; // characters per searchable chunk
const CHUNK_OVERLAP = 200;

function isPdf(buffer) {
  // Real PDFs contain "%PDF-" within the first 1 KB.
  return buffer.subarray(0, 1024).includes('%PDF-');
}

// Returns [{ page, text }] for every page (1-based page numbers).
async function extractPages(buffer, maxPages) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new HttpError(400, 'This PDF is password protected. Remove the password and try again.');
    throw new HttpError(400, "That file isn't a readable PDF.");
  }

  try {
    if (doc.numPages > maxPages) {
      throw new HttpError(400, `That PDF has ${doc.numPages} pages. The limit is ${maxPages}.`);
    }

    const pages = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (item.str || '') + (item.hasEOL ? '\n' : ' '))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      pages.push({ page: number, text });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

// Splits each page into overlapping chunks, so every chunk keeps an exact page number for citations.
function chunkPages(pages) {
  const chunks = [];
  for (const { page, text } of pages) {
    if (text.length < 20) continue; // blank or image-only page
    for (let start = 0; start < text.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
      chunks.push({ page, text: text.slice(start, start + CHUNK_SIZE) });
      if (start + CHUNK_SIZE >= text.length) break;
    }
  }
  return chunks;
}

module.exports = { isPdf, extractPages, chunkPages };
