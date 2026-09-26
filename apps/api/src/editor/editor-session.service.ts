import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  EditorActorType,
  EditorMode,
  EditorSessionStatus,
  NodeType,
  UserStatus,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { EDITOR_CONFIG, type EditorConfig } from './editor.config.js';
import { fileExtension, officeDocumentType } from './editor.types.js';

interface FetchCapability {
  aud: 'onlyoffice-file-fetch';
  sessionId: string;
  fileVersionId: string;
  purpose: 'onlyoffice-file-fetch';
}

@Injectable()
export class EditorSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly jwt: JwtService,
    @Inject(EDITOR_CONFIG) private readonly config: EditorConfig | undefined,
  ) {}

  static documentKey(versionId: string): string {
    return `oo-${createHash('sha256').update(`dochub-file-version:${versionId}`).digest('base64url')}`;
  }

  async create(actorUserId: string, nodeId: string) {
    const config = this.requireConfig();
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        type: true,
        file: {
          select: {
            id: true,
            currentVersionId: true,
            currentVersion: {
              select: { id: true, originalFilename: true, extension: true },
            },
          },
        },
      },
    });
    if (!node) throw new NotFoundException('Node not found');
    const capabilities = await this.authorization.resolveCapabilities(actorUserId, node.id);
    if (!capabilities.capabilities.has(DocumentCapability.VIEW))
      throw new NotFoundException('Node not found');
    if (!capabilities.capabilities.has(DocumentCapability.PREVIEW))
      throw new ForbiddenException('You do not have the required document capability');
    if (node.type !== NodeType.FILE) throw new ConflictException('Node is not a file');
    if (!node.file?.currentVersionId || !node.file.currentVersion)
      throw new ServiceUnavailableException('File is unavailable');
    const version = node.file.currentVersion;
    const extension = fileExtension(version.originalFilename, version.extension);
    const documentType = officeDocumentType(extension);
    if (!documentType)
      throw new UnsupportedMediaTypeException('ONLYOFFICE supports Office documents only');
    const actor = await this.database.prisma.user.findFirst({
      where: { id: actorUserId, status: UserStatus.ACTIVE },
      select: { id: true, displayName: true },
    });
    if (!actor) throw new NotFoundException('Node not found');
    const session = await this.database.prisma.editorSession.create({
      data: {
        fileId: node.file.id,
        baseVersionId: version.id,
        documentKey: EditorSessionService.documentKey(version.id),
        actorType: EditorActorType.USER,
        userId: actor.id,
        mode: EditorMode.VIEW,
        status: EditorSessionStatus.ACTIVE,
      },
      select: { id: true, mode: true, status: true, baseVersionId: true, documentKey: true },
    });
    const fetchToken = await this.signFetchToken(session.id, version.id, config);
    const documentUrl = new URL(`editor-sessions/${session.id}/content`, config.internalApiUrl);
    documentUrl.searchParams.set('token', fetchToken);
    const permissions = {
      edit: false,
      comment: false,
      review: false,
      fillForms: false,
      modifyFilter: false,
      download: capabilities.capabilities.has(DocumentCapability.DOWNLOAD),
      print: capabilities.capabilities.has(DocumentCapability.DOWNLOAD),
    };
    const unsignedConfig = {
      documentType,
      document: {
        fileType: extension,
        key: session.documentKey,
        title: version.originalFilename,
        url: documentUrl.toString(),
        permissions,
      },
      editorConfig: {
        mode: 'view' as const,
        user: { id: actor.id, name: actor.displayName },
      },
    };
    const token = await this.jwt.signAsync(unsignedConfig, {
      secret: config.jwtSecret,
      algorithm: 'HS256',
    });
    return {
      session: { id: session.id, mode: session.mode, status: session.status, expiresAt: null },
      documentServer: {
        apiUrl: new URL('web-apps/apps/api/documents/api.js', config.publicUrl).toString(),
      },
      config: { ...unsignedConfig, token },
    };
  }

  async close(actorUserId: string, sessionId: string) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: { id: sessionId, userId: actorUserId, actorType: EditorActorType.USER },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    if (session.status === EditorSessionStatus.ACTIVE)
      return this.database.prisma.editorSession.update({
        where: { id: session.id },
        data: { status: EditorSessionStatus.CLOSED, closedAt: new Date() },
        select: { id: true, status: true, mode: true, closedAt: true },
      });
    return session;
  }

  async authorizeFetch(requestedSessionId: string, token: string) {
    const config = this.requireConfig();
    let capability: FetchCapability;
    try {
      capability = await this.jwt.verifyAsync<FetchCapability>(token, {
        secret: config.fetchTokenSecret,
        algorithms: ['HS256'],
        audience: 'onlyoffice-file-fetch',
      });
    } catch {
      throw new NotFoundException('Editor resource not found');
    }
    if (
      capability.sessionId !== requestedSessionId ||
      capability.purpose !== 'onlyoffice-file-fetch' ||
      typeof capability.sessionId !== 'string' ||
      typeof capability.fileVersionId !== 'string'
    )
      throw new NotFoundException('Editor resource not found');
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: capability.sessionId,
        baseVersionId: capability.fileVersionId,
        actorType: EditorActorType.USER,
        mode: EditorMode.VIEW,
        status: EditorSessionStatus.ACTIVE,
      },
      select: {
        id: true,
        fileId: true,
        baseVersionId: true,
        userId: true,
        file: { select: { nodeId: true, node: { select: { trashOperationId: true } } } },
        baseVersion: { select: { id: true, fileId: true } },
        user: { select: { status: true } },
      },
    });
    if (
      !session ||
      !session.userId ||
      !session.user ||
      session.user.status !== UserStatus.ACTIVE ||
      session.baseVersion.fileId !== session.fileId ||
      session.file.node.trashOperationId !== null
    )
      throw new NotFoundException('Editor resource not found');
    const capabilities = await this.authorization.resolveCapabilities(
      session.userId,
      session.file.nodeId,
    );
    if (
      !capabilities.capabilities.has(DocumentCapability.VIEW) ||
      !capabilities.capabilities.has(DocumentCapability.PREVIEW)
    )
      throw new NotFoundException('Editor resource not found');
    return { nodeId: session.file.nodeId, versionId: session.baseVersionId };
  }

  private async signFetchToken(sessionId: string, fileVersionId: string, config: EditorConfig): Promise<string> {
    return this.jwt.signAsync<FetchCapability>(
      { aud: 'onlyoffice-file-fetch', sessionId, fileVersionId, purpose: 'onlyoffice-file-fetch' },
      { secret: config.fetchTokenSecret, algorithm: 'HS256', expiresIn: config.fetchTokenTtlSeconds },
    );
  }

  private requireConfig(): EditorConfig {
    if (!this.config)
      throw new ServiceUnavailableException('ONLYOFFICE is not configured');
    return this.config;
  }
}
