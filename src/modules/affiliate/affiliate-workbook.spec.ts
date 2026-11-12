import { affiliateWorkbook } from './affiliate-workbook';
describe('affiliate Excel export', () => {
  it('writes an XLSX package with Unicode text and formula-like names kept as text cells', () => {
    const file = affiliateWorkbook([{ userName: '=HYPERLINK("bad") & Nguyễn', kind: 'general', orderNumber: 'GDS-1',
      orderStatus: 'confirmed', accruedAmountMinor: '9007199254740993000', createdAt: new Date('2026-11-11T00:00:00Z'), policyRevisionId: 'policy-1' }]);
    expect(file.readUInt32LE(0)).toBe(0x04034b50);
    expect(file.readUInt32LE(file.length - 22)).toBe(0x06054b50);
    const xml = file.toString('utf8');
    expect(xml).toContain('[Content_Types].xml');
    expect(xml).toContain('xl/worksheets/sheet1.xml');
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain('=HYPERLINK(&quot;bad&quot;) &amp; Nguyễn');
    expect(xml).toContain('9007199254740993000');
    expect(xml).not.toContain('<f>');
  });
});
