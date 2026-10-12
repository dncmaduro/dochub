import { zipSync } from 'fflate';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PresentationEngine, PPTX_MIME_TYPE } from '../engines/presentation.engine.js';
import { parsePresentationPatchRequest } from './presentation-edit.types.js';
import { PptxPackageReader } from './pptx-package-reader.js';
import { PptxParser } from './pptx-parser.js';
import { PptxPatcher } from './pptx-patcher.js';

const presentationXml = `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="5143500"/><p:sldIdLst><p:sldId id="300" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
const presentationRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/><Relationship Id="rId3" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>`;
const layoutRels = `<Relationships><Relationship Id="rId1" Target="../slideMasters/slideMaster1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"/></Relationships>`;
const masterRels = `<Relationships><Relationship Id="rId1" Target="../theme/theme1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"/></Relationships>`;
const slide1Rels = `<Relationships><Relationship Id="rIdLayout" Target="../slideLayouts/slideLayout1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"/><Relationship Id="rIdImage" Target="../media/image1.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/><Relationship Id="rIdChart" Target="../charts/chart1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"/></Relationships>`;
const slide2Rels = `<Relationships><Relationship Id="rIdLayout" Target="../slideLayouts/slideLayout1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"/></Relationships>`;
const themeXml = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>`;
const layoutXml = `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:off x="500000" y="400000"/><a:ext cx="8000000" cy="700000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`;
const masterXml = `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`;
const titleShape = (text: string, id = '2') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" rot="60000"><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="roundRect"/><a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="FFEECC"/></a:solidFill></p:spPr><p:txBody><a:bodyPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><a:lstStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:pPr algn="ctr"/><a:r><a:rPr b="1" sz="2400"><a:latin typeface="Aptos"/><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const image = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdImage"/><a:stretch xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:off x="1000000" y="1700000"/><a:ext cx="1200000" cy="900000"/></a:xfrm><a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"/></p:spPr></p:pic>`;
const unsupportedChart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" x="3000000" y="1800000"/><a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" cx="2000000" cy="1300000"/></p:xfrm><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`;
function fixture(): Buffer {
  const slide = (body: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld><p:transition spd="slow"/><p:timing><p:tnLst/></p:timing></p:sld>`;
  return Buffer.from(zipSync({
    'ppt/presentation.xml': new TextEncoder().encode(presentationXml),
    'ppt/_rels/presentation.xml.rels': new TextEncoder().encode(presentationRels),
    'ppt/slides/slide1.xml': new TextEncoder().encode(slide(titleShape('First slide') + image + unsupportedChart)),
    'ppt/slides/slide2.xml': new TextEncoder().encode(slide(titleShape('Second slide'))),
    'ppt/slides/_rels/slide1.xml.rels': new TextEncoder().encode(slide1Rels),
    'ppt/slides/_rels/slide2.xml.rels': new TextEncoder().encode(slide2Rels),
    'ppt/slideLayouts/slideLayout1.xml': new TextEncoder().encode(layoutXml),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': new TextEncoder().encode(layoutRels),
    'ppt/slideMasters/slideMaster1.xml': new TextEncoder().encode(masterXml),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': new TextEncoder().encode(masterRels),
    'ppt/theme/theme1.xml': new TextEncoder().encode(themeXml),
    'ppt/media/image1.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    'ppt/charts/chart1.xml': new TextEncoder().encode('<chart preserved="yes"/>'),
    'ppt/notesSlides/notesSlide1.xml': new TextEncoder().encode('<notes preserved="yes"/>'),
    'ppt/customXml/item1.xml': new TextEncoder().encode('<custom preserved="yes"/>'),
  }));
}
function file() { return { fileId: 'file', nodeId: 'node', name: 'deck.pptx', mimeType: PPTX_MIME_TYPE, extension: '.pptx', size: 10, storageRef: { provider: 'GOOGLE_DRIVE' as const, objectId: 'drive' } }; }

describe('PresentationEngine', () => {
  it('parses presentation order, dimensions, semantic text, image assets and unsupported content', () => {
    const parser = new PptxParser(PptxPackageReader.fromBytes(fixture()));
    const parsed = parser.parseManifest('r1');
    expect(parsed.model.slides.map((slide) => slide.id)).toEqual(['slide-300', 'slide-256']);
    expect(parsed.model.width).toBe(9144000);
    const slide = parser.slide('slide-300', (assetId) => `/assets/${assetId}`);
    expect(slide.elements.map((element) => element.type)).toEqual(['text', 'image', 'unsupported']);
    expect(slide.elements[0]).toMatchObject({ id: 'element-slide-300-2', rotation: 1, paragraphs: [{ alignment: 'center', runs: [{ text: 'First slide', bold: true, fontSize: 24 }] }] });
    expect(slide.elements[1]).toMatchObject({ type: 'image', assetId: 'asset-slide-300-rIdImage', src: '/assets/asset-slide-300-rIdImage' });
    expect(slide.elements[2]).toMatchObject({ type: 'unsupported', label: 'Chart', editable: { text: false, move: false, resize: false } });
  });

  it('patches text and geometry while preserving unrelated package entries', () => {
    const source = fixture();
    const request = parsePresentationPatchRequest({ expectedRevision: 'r1', slides: [{ slideId: 'slide-300', elements: [{ elementId: 'element-slide-300-2', textState: { paragraphs: [{ alignment: 'left', runs: [{ text: 'Saved', bold: true }] }] }, geometry: { x: 1200000, width: 8000000 } }] }] });
    const patched = PptxPatcher.apply(source, request).bytes;
    const saved = PptxPackageReader.fromBytes(patched);
    expect(new TextDecoder().decode(saved.entry('ppt/slideLayouts/slideLayout1.xml')!.bytes)).toBe(layoutXml);
    expect(new TextDecoder().decode(saved.entry('ppt/theme/theme1.xml')!.bytes)).toBe(themeXml);
    expect(new TextDecoder().decode(saved.entry('ppt/charts/chart1.xml')!.bytes)).toBe('<chart preserved="yes"/>');
    expect(new TextDecoder().decode(saved.entry('ppt/media/image1.png')!.bytes)).toEqual(new TextDecoder().decode(new Uint8Array([137, 80, 78, 71, 1, 2, 3])));
    const reparsed = new PptxParser(saved).slide('slide-300');
    expect(reparsed.elements[0]).toMatchObject({ x: 1200000, width: 8000000, paragraphs: [{ runs: [{ text: 'Saved', bold: true }] }] });
    expect(reparsed.elements[1].type).toBe('image');
    expect(reparsed.elements[2].type).toBe('unsupported');
  });

  it('uses native PPTX and leaves legacy PPT on PDF fallback', async () => {
    const engine = new PresentationEngine();
    await expect(engine.openPreview(file())).resolves.toMatchObject({ kind: 'presentation' });
    expect(engine.capabilities(file()).edit).toBe(true);
    const ppt = { ...file(), name: 'deck.ppt', extension: '.ppt', mimeType: 'application/vnd.ms-powerpoint' };
    await expect(engine.openPreview(ppt)).resolves.toMatchObject({ kind: 'pdf' });
    expect(engine.capabilities(ppt).edit).toBe(false);
  });

  it('saves through StorageProvider and reparses the authoritative package', async () => {
    const source = fixture();
    let current = source;
    const storage = {
      stat: vi.fn().mockResolvedValue({ revision: 'r1', sizeBytes: BigInt(source.byteLength) }),
      openRead: vi.fn().mockImplementation(async () => ({ stream: Readable.from([current]), metadata: { revision: 'r1', sizeBytes: BigInt(current.byteLength), mimeType: PPTX_MIME_TYPE }, range: null })),
      replace: vi.fn().mockImplementation(async (_ref: unknown, input: { stream: Readable }) => { const chunks: Buffer[] = []; for await (const chunk of input.stream) chunks.push(Buffer.from(chunk)); current = Buffer.concat(chunks); return { metadata: { revision: 'r2', sizeBytes: BigInt(current.byteLength), mimeType: PPTX_MIME_TYPE }, ref: { provider: 'GOOGLE_DRIVE', objectId: 'drive' } }; }),
    };
    const result = await new PresentationEngine().save(file(), { expectedRevision: 'r1', slides: [{ slideId: 'slide-300', elements: [{ elementId: 'element-slide-300-2', geometry: { x: 1400000 } }] }] }, { storage: storage as never, expectedRevision: 'r1' });
    expect(result.storageRevision).toBe('r2');
    expect(result.model.storageRevision).toBe('r2');
    expect(storage.replace).toHaveBeenCalledOnce();
    expect(new PptxParser(PptxPackageReader.fromBytes(current)).slide('slide-300').elements[0]).toMatchObject({ x: 1400000 });
  });

  it('rejects a stale revision before reading or replacing the package', async () => {
    const storage = { stat: vi.fn().mockResolvedValue({ revision: 'r2', sizeBytes: 1n }), openRead: vi.fn(), replace: vi.fn() };
    await expect(new PresentationEngine().save(file(), { expectedRevision: 'r1', slides: [] }, { storage: storage as never, expectedRevision: 'r1' })).rejects.toThrow('changed');
    expect(storage.openRead).not.toHaveBeenCalled();
    expect(storage.replace).not.toHaveBeenCalled();
  });
});
