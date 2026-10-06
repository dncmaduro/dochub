import { IsIn, IsOptional } from 'class-validator';

export class CreateEditorSessionDto {
  @IsOptional()
  @IsIn(['VIEW', 'EDIT'])
  mode?: 'VIEW' | 'EDIT';
}
