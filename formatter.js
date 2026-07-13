/**
 * WhatsApp Message Formatter Helper
 * Mengonversi format Markdown standar ke format markup asli (native) WhatsApp.
 */

/**
 * Memisahkan sel-sel baris tabel markdown berdasarkan karakter '|'.
 * 
 * @param {string} row
 * @returns {string[]}
 */
function splitCells(row) {
  const cells = row.split('|').map(c => c.trim());
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/**
 * Menyusun buffer baris tabel menjadi format list teratur WhatsApp.
 * 
 * @param {string[]} rows
 * @returns {string}
 */
function processTableBuffer(rows) {
  let separatorIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = splitCells(rows[i]);
    const isSeparator = cells.length > 0 && cells.every(c => /^[::\-]+$/.test(c));
    if (isSeparator) {
      separatorIdx = i;
      break;
    }
  }

  // Jika tidak ditemukan pemisah (separator) tabel yang valid, kembalikan apa adanya
  if (separatorIdx === -1) {
    return rows.join('\n');
  }

  // Baris header terletak tepat di atas baris pemisah
  let headerIdx = separatorIdx - 1;
  if (headerIdx < 0) {
    return rows.join('\n');
  }

  const headers = splitCells(rows[headerIdx]);
  const dataRows = [];
  const prependLines = [];

  for (let i = 0; i < headerIdx; i++) {
    prependLines.push(rows[i]);
  }

  for (let i = separatorIdx + 1; i < rows.length; i++) {
    const cells = splitCells(rows[i]);
    dataRows.push(cells);
  }

  const formattedRows = dataRows.map(row => {
    const parts = [];
    for (let i = 0; i < headers.length; i++) {
      const headerName = headers[i] || `Kolom ${i + 1}`;
      const cellValue = row[i] || '-';
      parts.push(`*${headerName}:* ${cellValue}`);
    }
    return `• ${parts.join(', ')}`;
  });

  return [...prependLines, ...formattedRows].join('\n');
}

/**
 * Mengonversi tabel Markdown (| Kolom 1 | Kolom 2 |) menjadi daftar poin-poin tebal.
 * Hal ini dilakukan agar data tabular nyaman dibaca di layar HP yang sempit.
 * 
 * @param {string} text
 * @returns {string}
 */
function parseMarkdownTables(text) {
  const lines = text.split('\n');
  const result = [];
  let tableBuffer = [];

  for (let i = 0; i < lines.length; i++) {
    let rawLine = lines[i];
    let trimmed = rawLine.trim();
    let cleaned = trimmed;
    
    // Perbaikan toleransi: bersihkan spasi/tanda titik setelah pipe terakhir (misal: "| - |." -> "| - |")
    if (cleaned.includes('|')) {
      cleaned = cleaned.replace(/\|\s*\.?\s*$/, '|');
      // Jika baris diawali '|' namun tidak diakhiri '|', tambahkan penutup otomatis
      if (cleaned.startsWith('|') && !cleaned.endsWith('|')) {
        cleaned = cleaned + '|';
      }
    }

    const isTableRow = cleaned.startsWith('|') && cleaned.endsWith('|') && cleaned.length > 1;

    if (isTableRow) {
      tableBuffer.push(cleaned);
    } else {
      if (tableBuffer.length > 0) {
        result.push(processTableBuffer(tableBuffer));
        tableBuffer = [];
      }
      result.push(rawLine);
    }
  }

  if (tableBuffer.length > 0) {
    result.push(processTableBuffer(tableBuffer));
  }

  return result.join('\n');
}

/**
 * Mengonversi teks Markdown ke format Markup WhatsApp.
 * 
 * @param {string} text
 * @returns {string}
 */
function formatToWhatsApp(text) {
  if (typeof text !== 'string') return '';

  let formatted = text;

  // 1. Ubah Markdown Headers (# Judul) menjadi WhatsApp Bold (*Judul*)
  formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 2. Ubah Markdown Bold (**teks**) menjadi WhatsApp Bold (*teks*)
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // 3. Ubah Markdown Strikethrough (~~teks~~) menjadi WhatsApp Strikethrough (~teks~)
  formatted = formatted.replace(/~~(.*?)~~/g, '~$1~');

  // 4. Ubah Tabel Markdown menjadi bullet list
  formatted = parseMarkdownTables(formatted);

  return formatted;
}

module.exports = {
  formatToWhatsApp,
  parseMarkdownTables
};
