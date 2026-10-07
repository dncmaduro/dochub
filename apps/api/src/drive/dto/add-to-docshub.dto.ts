import { IsOptional, IsUUID } from 'class-validator';

export class AddToDocsHubDto {
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
