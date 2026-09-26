import { IsIn } from 'class-validator';

export class CreateEditorSessionDto {
  @IsIn(['VIEW'])
  mode!: 'VIEW';
}
