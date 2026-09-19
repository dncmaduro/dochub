import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  MoveNodeDto,
  NodeIdParamDto,
  NodeListQueryDto,
  RenameNodeDto,
} from './dto/node.dto.js';
import { NodesService } from './nodes.service.js';

@Controller('nodes')
@UseGuards(AccessTokenGuard)
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Get('root')
  listRoot(
    @CurrentAuth() auth: AuthPrincipal,
    @Query() query: NodeListQueryDto,
  ) {
    return this.nodes.listRoot(auth.userId, query);
  }

  @Get(':nodeId/children')
  listChildren(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeIdParamDto,
    @Query() query: NodeListQueryDto,
  ) {
    return this.nodes.listChildren(auth.userId, params.nodeId, query);
  }

  @Get(':nodeId/breadcrumb')
  breadcrumb(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeIdParamDto,
  ) {
    return this.nodes.breadcrumb(auth.userId, params.nodeId);
  }

  @Get(':nodeId')
  get(@CurrentAuth() auth: AuthPrincipal, @Param() params: NodeIdParamDto) {
    return this.nodes.getNode(auth.userId, params.nodeId);
  }

  @Patch(':nodeId')
  rename(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeIdParamDto,
    @Body() dto: RenameNodeDto,
  ) {
    return this.nodes.renameNode(auth.userId, params.nodeId, dto);
  }

  @Post(':nodeId/move')
  move(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeIdParamDto,
    @Body() dto: MoveNodeDto,
  ) {
    return this.nodes.moveNode(auth.userId, params.nodeId, dto);
  }
}
