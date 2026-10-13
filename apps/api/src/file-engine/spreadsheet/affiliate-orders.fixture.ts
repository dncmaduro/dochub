import { zipSync } from 'fflate';

const encoder = new TextEncoder();

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <x:bookViews><x:workbookView activeTab="1"/></x:bookViews>
  <x:sheets>
    <x:sheet name="Affiliate Orders" sheetId="7" r:id="rSheetOrders"/>
    <x:sheet name="Summary" sheetId="3" r:id="rSheetSummary"/>
  </x:sheets>
  <x:definedNames>
    <x:definedName name="OrdersRange">'Affiliate Orders'!$A$1:$F$1000000</x:definedName>
    <x:definedName name="_xlnm.Print_Area" localSheetId="0">'Affiliate Orders'!$A$1:$F$20</x:definedName>
  </x:definedNames>
  <x:calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</x:workbook>`;

const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rSheetOrders" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/orders.xml"/>
  <Relationship Id="rSheetSummary" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="../xl/worksheets/summary.xml"/>
  <Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="/xl/styles.xml"/>
  <Relationship Id="rUnknown" Type="http://schemas.example.test/unknown" Target="/xl/unknown.xml"/>
</Relationships>`;

const packageRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rOfficeDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/orders.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/summary.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/tables/orders.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>
  <Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="177" formatCode="[$-en-US]#,##0.00;[Red]-#,##0.00"/></numFmts>
  <fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color theme="1"/><sz val="12"/><name val="Aptos Display"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="177" fontId="0" fillId="2" borderId="1" xfId="0" applyNumberFormat="1"><alignment horizontal="right" wrapText="1"/></xf>
    <xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleMedium9"/>
</styleSheet>`;

const ordersXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <x:dimension ref="A1:XFD1048576"/>
  <x:sheetViews><x:sheetView workbookViewId="0" showGridLines="1"><x:pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/><x:selection pane="bottomRight" activeCell="B2" sqref="B2"/></x:sheetView></x:sheetViews>
  <x:sheetFormatPr defaultRowHeight="15"/>
  <x:sheetData>
    <x:row r="1" ht="20" customHeight="1"><x:c r="A1" t="inlineStr" s="2"><x:is><x:r><x:rPr><x:b/></x:rPr><x:t>Order ID</x:t></x:r></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Affiliate</x:t></x:is></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Order date</x:t></x:is></x:c><x:c r="D1" t="inlineStr"><x:is><x:t>Amount</x:t></x:is></x:c><x:c r="E1" t="inlineStr"><x:is><x:t>Status</x:t></x:is></x:c></x:row>
    <x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>AO-1001</x:t></x:is></x:c><x:c r="B2" t="inlineStr"><x:is><x:t>Northwind</x:t></x:is></x:c><x:c r="C2" t="d"><x:v>2026-01-15T00:00:00Z</x:v></x:c><x:c r="D2" s="1"><x:v>1250.5</x:v></x:c><x:c r="E2" t="str"><x:v>paid</x:v></x:c></x:row>
    <x:row r="4" hidden="1"><x:c r="A4" t="inlineStr"><x:is><x:t>Hidden note</x:t></x:is></x:c><x:c r="C4" t="b"><x:v>1</x:v></x:c><x:c r="D4" t="e"><x:v>#N/A</x:v></x:c></x:row>
    <x:row r="5"><x:c r="A5" t="inlineStr"><x:is><x:t xml:space="preserve"> sparse </x:t></x:is></x:c><x:c r="C5"/><x:c r="E5" s="99" t="futureType"><x:v>read-only fallback</x:v></x:c></x:row>
    <x:row r="1000000"><x:c r="F1000000"><x:f>SUM(D2:D999999)</x:f></x:c></x:row>
  </x:sheetData>
  <x:autoFilter ref="A1:E1000000"/>
  <x:mergeCells count="1"><x:mergeCell ref="A1:B1"/></x:mergeCells>
  <x:hyperlinks><x:hyperlink ref="A2" r:id="rLink"/></x:hyperlinks>
  <x:tableParts count="1"><x:tablePart r:id="rTable"/></x:tableParts>
</x:worksheet>`;

const summaryXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Affiliate order summary</t></is></c></row><row r="3"><c r="B3"><f>COUNTA('Affiliate Orders'!A2:A999999)</f></c></row></sheetData></worksheet>`;

export function affiliateOrdersFixture(): Buffer {
  return Buffer.from(zipSync({
    '[Content_Types].xml': encoder.encode(contentTypesXml),
    '_rels/.rels': encoder.encode(packageRelsXml),
    'xl/workbook.xml': encoder.encode(workbookXml),
    'xl/_rels/workbook.xml.rels': encoder.encode(workbookRelsXml),
    'xl/styles.xml': encoder.encode(stylesXml),
    'xl/worksheets/orders.xml': encoder.encode(ordersXml),
    'xl/worksheets/summary.xml': encoder.encode(summaryXml),
    'xl/worksheets/_rels/orders.xml.rels': encoder.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/orders.xml"/><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/orders" TargetMode="External"/></Relationships>'),
    'xl/tables/orders.xml': encoder.encode('<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="AffiliateOrders" displayName="AffiliateOrders" ref="A1:E999999"><autoFilter ref="A1:E999999"/></table>'),
    'xl/theme/theme1.xml': encoder.encode('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements/></a:theme>'),
  }));
}
