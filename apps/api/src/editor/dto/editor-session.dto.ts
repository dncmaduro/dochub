import { IsIn } from 'class-validator';

export class CreateEditorSessionDto {
  @IsIn(['VIEW', 'EDIT'])
  mode!: 'VIEW' | 'EDIT';
}
