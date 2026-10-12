export type PresentationAlignment = 'left' | 'center' | 'right' | 'justified';

export interface PresentationTextRun {
  id: string;
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fontFamily: string | null;
  fontSize: number | null;
  color: string | null;
  link: { href: string } | null;
}

export interface PresentationParagraph {
  id: string;
  runs: PresentationTextRun[];
  alignment: PresentationAlignment;
  bullet: { kind: 'bullet' | 'number'; value: string | null; level: number } | null;
}

export interface PresentationEditableCapabilities {
  text: boolean;
  move: boolean;
  resize: boolean;
}

export interface PresentationElementBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  editable: PresentationEditableCapabilities;
  placeholderType?: string | null;
  hyperlink?: { href: string } | null;
}

export interface PresentationTextElement extends PresentationElementBase {
  type: 'text';
  shapeType: string;
  paragraphs: PresentationParagraph[];
  fillColor?: string | null;
  borderColor?: string | null;
  borderWidth?: number | null;
  readonlyReason?: string;
}

export interface PresentationImageElement extends PresentationElementBase {
  type: 'image';
  assetId: string;
  src?: string;
  crop?: { left: number; top: number; right: number; bottom: number } | null;
  readonlyReason?: string;
}

export interface PresentationShapeElement extends PresentationElementBase {
  type: 'shape';
  shapeType: string;
  fillColor: string | null;
  borderColor: string | null;
  borderWidth: number | null;
  readonlyReason?: string;
}

export interface PresentationGroupElement extends PresentationElementBase {
  type: 'group';
  children: PresentationElement[];
  readonlyReason: string;
}

export interface PresentationUnsupportedElement extends PresentationElementBase {
  type: 'unsupported';
  label: string;
  readonlyReason: string;
}

export type PresentationElement =
  | PresentationTextElement
  | PresentationImageElement
  | PresentationShapeElement
  | PresentationGroupElement
  | PresentationUnsupportedElement;

export interface PresentationSlideDescriptor {
  id: string;
  index: number;
  name: string | null;
  hidden: boolean;
  width: number;
  height: number;
  thumbnailCapability: boolean;
}

export interface PresentationSlideModel {
  version: 1;
  id: string;
  index: number;
  width: number;
  height: number;
  background: string | null;
  elements: PresentationElement[];
  unsupportedFeatures: string[];
}

export interface PresentationModel {
  version: 1;
  id: string;
  width: number;
  height: number;
  slides: PresentationSlideDescriptor[];
  activeSlideId: string;
  editable: boolean;
  storageRevision?: string;
  hasUnsupportedContent?: boolean;
}
