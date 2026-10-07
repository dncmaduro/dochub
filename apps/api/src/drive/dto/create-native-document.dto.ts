import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum NativeDocumentKind {
  DOCUMENT = 'DOCUMENT',
  SPREADSHEET = 'SPREADSHEET',
  PRESENTATION = 'PRESENTATION',
}

export enum NativeDocumentLocale {
  EN = 'en',
  VI = 'vi',
}

export class CreateNativeDocumentDto {
  @IsEnum(NativeDocumentKind)
  kind!: NativeDocumentKind;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsEnum(NativeDocumentLocale)
  locale?: NativeDocumentLocale;
}
