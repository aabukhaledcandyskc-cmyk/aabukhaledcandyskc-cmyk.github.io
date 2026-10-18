// Turns an SheetJS workbook into the same array-of-rows the CSV parser produces.
// Real date cells become DD/MM/YYYY text so they go through the same strict date parser.
export function rowsFromWorkbook(XLSX, data) {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const pad = (n) => String(n).padStart(2, '0');
  return rows.map((r) => r.map((c) => {
    if (c instanceof Date) return `${pad(c.getUTCDate())}/${pad(c.getUTCMonth() + 1)}/${c.getUTCFullYear()}`;
    return typeof c === 'number' ? String(c) : String(c ?? '');
  }));
}

export function workbookFromRows(XLSX, header, rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}
