import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { UserStatus } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';

const PREVIEW_AUDIENCE = 'dochub-preview';
const PREVIEW_TTL_SECONDS = 300;
const PREVIEW_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'text/plain']);

type PreviewToken = { typ: 'preview'; sid: string; sub: string; nid: string; vid: string };

@Injectable()
export class PreviewService {
  constructor(private readonly database: DatabaseService, private readonly authorization: DocumentAuthorizationService, private readonly jwt: JwtService) {}

  async create(userId: string, nodeId: string) {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.VIEW)) throw new NotFoundException('Node not found');
    const node = await this.database.prisma.node.findFirst({ where: { id: nodeId, trashOperationId: null }, select: { id: true, name: true, file: { select: { currentVersion: { select: { id: true, mimeType: true, sizeBytes: true } } } } } });
    const version = node?.file?.currentVersion;
    if (!node || !version) throw new NotFoundException('Node not found');
    if (!PREVIEW_MIME_TYPES.has(version.mimeType.toLowerCase())) return null;
    const sessionId = randomUUID();
    const token = await this.jwt.signAsync<PreviewToken>({ typ: 'preview', sid: sessionId, sub: userId, nid: node.id, vid: version.id }, { expiresIn: PREVIEW_TTL_SECONDS, audience: PREVIEW_AUDIENCE });
    return { sessionId, nodeId: node.id, token, contentUrl: `/preview/${sessionId}/content`, expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(), mimeType: version.mimeType, filename: node.name, size: version.sizeBytes.toString() };
  }

  async verify(sessionId: string, token: string | undefined) {
    if (!token) throw new UnauthorizedException('Preview session is invalid');
    let preview: PreviewToken;
    try { preview = await this.jwt.verifyAsync<PreviewToken>(token, { audience: PREVIEW_AUDIENCE }); } catch { throw new UnauthorizedException('Preview session is invalid'); }
    if (preview.typ !== 'preview' || preview.sid !== sessionId) throw new UnauthorizedException('Preview session is invalid');
    const user = await this.database.prisma.user.findUnique({ where: { id: preview.sub }, select: { status: true } });
    if (user?.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Preview session is invalid');
    const capabilities = await this.authorization.resolveCapabilities(preview.sub, preview.nid);
    if (!capabilities.capabilities.has(DocumentCapability.VIEW)) throw new ForbiddenException('Preview access was revoked');
    const node = await this.database.prisma.node.findFirst({ where: { id: preview.nid, trashOperationId: null, file: { versions: { some: { id: preview.vid } } } }, select: { id: true } });
    if (!node) throw new NotFoundException('Preview is unavailable');
    return preview;
  }

  cookieName(sessionId: string) { return `dochub_preview_${sessionId}`; }
}
