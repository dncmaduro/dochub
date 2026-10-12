import { zipSync } from "fflate";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DocxPackageReader } from "./docx-package-reader.js";
import { DocxPatcher } from "./docx-patcher.js";
import { parseDocumentPatchRequest } from "./document-edit.types.js";
import { DocxParser } from "./docx-parser.js";
import { DocumentEngine } from "../engines/document.engine.js";

const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="urn:word"><w:body>
  <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:rPr><w:i/><w:sz w:val="24"/></w:rPr><w:t> world</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Heading</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>List item</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:p><w:object><w:unsupported/></w:object></w:p>
</w:body></w:document>`;

const entries = {
  "word/document.xml": new TextEncoder().encode(documentXml),
  "word/styles.xml": new TextEncoder().encode(`<w:styles xmlns:w="urn:word"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`),
  "word/numbering.xml": new TextEncoder().encode(`<w:numbering xmlns:w="urn:word"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`),
  "word/media/image1.png": new Uint8Array([1, 2, 3, 4]),
  "customXml/item1.xml": new TextEncoder().encode("<custom>untouched</custom>"),
};

function sourceBytes(): Buffer {
  return Buffer.from(zipSync(entries));
}

function run(text: string, overrides: Partial<Record<"bold" | "italic" | "underline" | "strike", boolean>> = {}) {
  return {
    kind: "text" as const,
    text,
    bold: overrides.bold ?? false,
    italic: overrides.italic ?? false,
    underline: overrides.underline ?? false,
    strike: overrides.strike ?? false,
    fontSize: null,
    fontFamily: null,
    color: null,
    verticalAlign: "baseline" as const,
    link: null,
  };
}

function request(blocks: unknown[]) {
  return parseDocumentPatchRequest({ expectedRevision: "7", blocks });
}

describe("DocxPatcher", () => {
  it("round-trips text, formatting, alignment, list text, and table-cell text", () => {
    const patched = DocxPatcher.apply(sourceBytes(), request([
      { blockId: "b-p1", type: "paragraph", style: "normal", alignment: "left", content: [run("Hello edited "), run("world", { bold: true })] },
      { blockId: "b-p2", type: "paragraph", style: "heading-1", alignment: "right", content: [run("Heading changed", { bold: true })] },
      { blockId: "b-p3", type: "list-item", style: "preserve", alignment: "left", content: [run("List changed")] },
      { blockId: "b-t4-r1-c1-p1", type: "paragraph", style: "normal", alignment: "left", content: [run("Cell changed")] },
    ]));
    const reparsed = patched.model;
    expect(reparsed.blocks[0]).toMatchObject({ type: "paragraph", content: [{ text: "Hello edited ", bold: false }, { text: "world", bold: true }] });
    expect(reparsed.blocks[1]).toMatchObject({ type: "heading", level: 1, alignment: "right", content: [{ text: "Heading changed", bold: true }] });
    expect(reparsed.blocks[2]).toMatchObject({ type: "list-item", content: [{ text: "List changed" }] });
    expect(reparsed.blocks[3]).toMatchObject({ type: "table" });
    expect((reparsed.blocks[3] as { rows: Array<{ cells: Array<{ blocks: Array<{ content: Array<{ text: string }> }> }> }> }).rows[0]?.cells[0]?.blocks[0]?.content[0]?.text).toBe("Cell changed");
    expect(new TextDecoder().decode(DocxPackageReader.fromBytes(patched.bytes).entry("customXml/item1.xml")!.bytes)).toBe("<custom>untouched</custom>");
    expect([...DocxPackageReader.fromBytes(patched.bytes).entry("word/media/image1.png")!.bytes]).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(DocxPackageReader.fromBytes(patched.bytes).entry("word/numbering.xml")!.bytes)).toBe(new TextDecoder().decode(entries["word/numbering.xml"]));
  });

  it("refuses unsupported paragraphs without touching the package", () => {
    expect(() => DocxPatcher.apply(sourceBytes(), request([
      { blockId: "b-p5", type: "paragraph", style: "normal", alignment: "left", content: [run("unsafe")] },
    ]))).toThrow(/read-only/i);
  });

  it("escapes text and preserves spaces and supported run formatting", () => {
    const patched = DocxPatcher.apply(sourceBytes(), request([
      { blockId: "b-p1", type: "paragraph", style: "normal", alignment: "left", content: [run("  <safe> & text  ", { underline: true, strike: true })] },
    ]));
    const xml = new TextDecoder().decode(DocxPackageReader.fromBytes(patched.bytes).entry("word/document.xml")!.bytes);
    expect(xml).toContain("xml:space=\"preserve\"");
    expect(xml).toContain("&lt;safe&gt; &amp; text");
    expect(patched.model.blocks[0]).toMatchObject({ content: [{ text: "  <safe> & text  ", underline: true, strike: true }] });
  });

  it("saves through StorageProvider.replace and rejects a stale revision before patching", async () => {
    let storedBytes = sourceBytes();
    let revision = "7";
    const storage = {
      stat: async () => ({ provider: "GOOGLE_DRIVE" as const, objectId: "drive", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: BigInt(storedBytes.byteLength), revision }),
      openRead: async () => ({ stream: Readable.from([storedBytes]), metadata: { provider: "GOOGLE_DRIVE" as const, objectId: "drive", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: BigInt(storedBytes.byteLength), revision }, range: null }),
      replace: async (_ref: unknown, input: { stream: Readable }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input.stream) chunks.push(Buffer.from(chunk));
        storedBytes = Buffer.concat(chunks);
        revision = "8";
        return { ref: { provider: "GOOGLE_DRIVE" as const, objectId: "drive" }, metadata: { provider: "GOOGLE_DRIVE" as const, objectId: "drive", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: BigInt(storedBytes.byteLength), revision } };
      },
    };
    const engine = new DocumentEngine();
    const file = { fileId: "file", nodeId: "node", name: "test.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx", size: storedBytes.byteLength, storageRef: { provider: "GOOGLE_DRIVE" as const, objectId: "drive" } };
    const saved = await engine.save(file, request([{ blockId: "b-p1", type: "paragraph", style: "normal", alignment: "left", content: [run("Saved")] }]), { storage: storage as never, expectedRevision: "7" });
    expect(saved.storageRevision).toBe("8");
    expect(saved.model.blocks[0]).toMatchObject({ content: [{ text: "Saved" }] });
    revision = "9";
    await expect(engine.save(file, request([{ blockId: "b-p1", type: "paragraph", style: "normal", alignment: "left", content: [run("No overwrite")] }]), { storage: storage as never, expectedRevision: "8" })).rejects.toThrow(/changed/);
    expect(DocxParser.parse(DocxPackageReader.fromBytes(storedBytes)).model.blocks[0]).toMatchObject({ content: [{ text: "Saved" }] });
  });
});
