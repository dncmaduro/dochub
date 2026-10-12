import { zipSync } from "fflate";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FileFormatUnsupportedError } from "../file-engine.errors.js";
import { DocumentEngine } from "../engines/document.engine.js";
import { DocxPackageError, DocxPackageReader } from "./docx-package-reader.js";
import { DocxParser } from "./docx-parser.js";

const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="urn:word" xmlns:r="urn:rel" xmlns:wp="urn:wp" xmlns:a="urn:a">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="336699"/></w:rPr><w:t>Title</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:rPr><w:i/><w:u w:val="single"/><w:sz w:val="24"/></w:rPr><w:t>world</w:t></w:r><w:hyperlink r:id="rLink"><w:r><w:t> link</w:t></w:r></w:hyperlink><w:r><w:tab/><w:t>tab</w:t><w:br/><w:t>line</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>One</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested</w:t></w:r></w:p>
    <w:tbl><w:tblGrid><w:gridCol w:w="1440"/><w:gridCol w:w="2880"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:fill="eeeeee"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" descr="A picture"/><a:graphic><a:graphicData><a:blip r:embed="rImage"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:p>
    <w:p><w:object><w:someFeature/></w:object></w:p>
  </w:body>
</w:document>`;

const entries = {
  "word/document.xml": new TextEncoder().encode(documentXml),
  "word/styles.xml": new TextEncoder().encode(`<w:styles xmlns:w="urn:word"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
  "word/numbering.xml": new TextEncoder().encode(`<w:numbering xmlns:w="urn:word"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`),
  "word/_rels/document.xml.rels": new TextEncoder().encode(`<Relationships xmlns="urn:rel"><Relationship Id="rLink" Type="hyperlink" Target="https://example.test/docs" TargetMode="External"/><Relationship Id="rImage" Type="image" Target="media/image1.png"/></Relationships>`),
  "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
};

function fixture(overrides: Record<string, Uint8Array> = {}) {
  return DocxPackageReader.fromBytes(zipSync({ ...entries, ...overrides }));
}

describe("DocxParser", () => {
  it("parses ordered paragraphs, formatting, headings, lists, tables, images, and safe links", () => {
    const parsed = DocxParser.parse(fixture(), (assetId) => `/assets/${assetId}`);
    expect(parsed.model.blocks.map((block) => block.type)).toEqual([
      "heading", "paragraph", "list-item", "list-item", "table", "image", "paragraph",
    ]);
    const heading = parsed.model.blocks[0];
    expect(heading).toMatchObject({ type: "heading", level: 1, alignment: "center" });
    const paragraph = parsed.model.blocks[1];
    expect(paragraph).toMatchObject({ type: "paragraph", content: [
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world", bold: false, italic: true, underline: true, fontSize: 12 },
      { kind: "text", text: " link", link: { href: "https://example.test/docs" } },
      { kind: "text", text: "\ttab\nline" },
    ] });
    expect(parsed.model.blocks[2]).toMatchObject({ type: "list-item", ordered: true, level: 0, marker: "%1." });
    expect(parsed.model.blocks[3]).toMatchObject({ type: "list-item", ordered: false, level: 1 });
    expect(parsed.model.blocks[4]).toMatchObject({ type: "table" });
    expect((parsed.model.blocks[4] as { rows: Array<{ cells: Array<{ backgroundColor: string | null }> }> }).rows[0]?.cells[0]).toMatchObject({ backgroundColor: "#eeeeee" });
    expect(parsed.model.blocks[5]).toMatchObject({ type: "image", assetId: "asset-1", src: "/assets/asset-1", widthPx: 96, heightPx: 48 });
    expect(parsed.assets.get("asset-1")?.mimeType).toBe("image/png");
    expect(parsed.model.blocks[6]).toMatchObject({ type: "paragraph", content: [] });
  });

  it("rejects traversal and oversized ZIP entries before extraction", () => {
    expect(() => DocxPackageReader.fromBytes(zipSync({ "../escape": new Uint8Array([1]), ...entries }))).toThrow(DocxPackageError);
    expect(() => DocxPackageReader.fromBytes(zipSync({ "word/document.xml": new Uint8Array(26 * 1024 * 1024) }))).toThrow(/entry limit/i);
  });

  it("omits unsafe hyperlink schemes and tolerates malformed relationships", () => {
    const rels = new TextEncoder().encode(`<Relationships><Relationship Id="rLink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`);
    const parsed = DocxParser.parse(fixture({ "word/_rels/document.xml.rels": rels }));
    const paragraph = parsed.model.blocks[1];
    expect(paragraph).toMatchObject({ type: "paragraph" });
    expect((paragraph as { content: Array<{ link: unknown }> }).content[2]?.link).toBeNull();
  });

  it("reports malformed XML as an expected document failure", () => {
    expect(() => DocxParser.parse(fixture({ "word/document.xml": new TextEncoder().encode("<w:document>") }))).toThrow(DocxPackageError);
  });

  it("does not expand external XML entities", () => {
    const externalEntity = documentXml
      .replace("<w:document", "<!DOCTYPE w:document [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><w:document")
      .replace(">Title</w:t>", ">&xxe;</w:t>");
    expect(() => DocxParser.parse(fixture({ "word/document.xml": new TextEncoder().encode(externalEntity) }))).toThrow(DocxPackageError);
  });
});

describe("DocumentEngine", () => {
  it("uses trusted DOC/DOCX MIME types before filename extensions", async () => {
    const engine = new DocumentEngine();
    await expect(engine.openPreview({ fileId: "file", nodeId: "node", name: "report.docx", mimeType: "application/msword", extension: ".docx", size: 0, storageRef: null })).resolves.toMatchObject({ kind: "pdf" });
    await expect(engine.openPreview({ fileId: "file", nodeId: "node", name: "report.doc", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".doc", size: 0, storageRef: null })).resolves.toMatchObject({ kind: "document" });
  });

  it("uses StorageProvider.openRead for native DOCX models and does not require LibreOffice", async () => {
    const bytes = zipSync(entries);
    const storage = {
      openRead: async () => ({ stream: Readable.from([bytes]), metadata: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: BigInt(bytes.byteLength) }, range: null }),
    };
    const engine = new DocumentEngine();
    const model = await engine.openModel({ fileId: "file", nodeId: "node", name: "test.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx", size: bytes.byteLength, storageRef: { provider: "GOOGLE_DRIVE", objectId: "drive-file" } }, { storage: storage as never });
    expect(model.blocks[0]).toMatchObject({ type: "heading" });
    await expect(engine.openContent({ fileId: "file", nodeId: "node", name: "test.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx", size: bytes.byteLength, storageRef: { provider: "GOOGLE_DRIVE", objectId: "drive-file" } }, { storage: storage as never, openLibreOfficePreview: async () => { throw new Error("should not be called"); } })).resolves.toMatchObject({ mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  });

  it("keeps legacy DOC on the LibreOffice path", async () => {
    const converted = { stream: Readable.from([]), mimeType: "application/pdf", sizeBytes: 1n, range: null };
    await expect(new DocumentEngine().openContent({ fileId: "file", nodeId: "node", name: "test.doc", mimeType: "application/msword", extension: ".doc", size: 0, storageRef: null }, { storage: {} as never, openLibreOfficePreview: async () => converted })).resolves.toBe(converted);
    await expect(new DocumentEngine().openModel({ fileId: "file", nodeId: "node", name: "test.doc", mimeType: "application/msword", extension: ".doc", size: 0, storageRef: null }, { storage: {} as never })).rejects.toBeInstanceOf(FileFormatUnsupportedError);
  });
});
