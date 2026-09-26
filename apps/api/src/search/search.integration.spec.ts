import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { SearchService } from './search.service.js';

const withDb = process.env.DATABASE_URL ? describe : describe.skip;
withDb('SearchService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const hiddenId = randomUUID();
  const adminId = randomUUID();
  const nodeIds: string[] = [];
  const fileIds: string[] = [];
  const groupIds: string[] = [];
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const search = new SearchService(database, authorization);
  async function node(
    name: string,
    type = NodeType.FOLDER,
    visible = true,
    parentId: string | null = null,
  ) {
    const row = await prisma.node.create({
      data: {
        type,
        parentId,
        name,
        normalizedName: `${name.toLowerCase()}-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(row.id);
    if (visible)
      await prisma.permissionEntry.create({
        data: { nodeId: row.id, userId: actorId, role: DocumentRole.VIEWER },
      });
    return row;
  }
  async function contentFile(
    name: string,
    content: string,
    visible = true,
    parentId: string | null = null,
  ) {
    const row = await node(name, NodeType.FILE, visible, parentId);
    const fileId = randomUUID();
    const versionId = randomUUID();
    fileIds.push(fileId);
    await prisma.file.create({ data: { id: fileId, nodeId: row.id } });
    await prisma.fileVersion.create({
      data: {
        id: versionId,
        fileId,
        versionNumber: 1,
        storageKey: `search/${fileId}/${versionId}`,
        originalFilename: name,
        mimeType: 'application/pdf',
        sizeBytes: BigInt(content.length),
        sha256: versionId.replaceAll('-', '').padEnd(64, '0'),
        source: 'UPLOAD',
        createdById: actorId,
      },
    });
    await prisma.file.update({
      where: { id: fileId },
      data: { currentVersionId: versionId, versionCounter: 1 },
    });
    await prisma.$executeRaw`
      INSERT INTO "SearchDocument" ("id", "fileId", "fileVersionId", "contentText", "searchVector")
      VALUES (${randomUUID()}::uuid, ${fileId}::uuid, ${versionId}::uuid, ${content}, to_tsvector('simple', public.search_unaccent(${content})))
    `;
    return { ...row, fileId, versionId };
  }
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `search-${suffix}@x.test`,
          normalizedEmail: `search-${suffix}@x.test`,
          displayName: 'Search',
          status: UserStatus.ACTIVE,
        },
        {
          id: hiddenId,
          email: `hidden-${suffix}@x.test`,
          normalizedEmail: `hidden-${suffix}@x.test`,
          displayName: 'Hidden',
          status: UserStatus.ACTIVE,
        },
        {
          id: adminId,
          email: `admin-${suffix}@x.test`,
          normalizedEmail: `admin-${suffix}@x.test`,
          displayName: 'Admin',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
      ],
    });
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { resourceId: { in: nodeIds } },
    });
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: { in: nodeIds } },
    });
    await prisma.file.updateMany({
      where: { id: { in: fileIds } },
      data: { currentVersionId: null },
    });
    await prisma.fileVersion.deleteMany({ where: { fileId: { in: fileIds } } });
    await prisma.file.deleteMany({ where: { id: { in: fileIds } } });
    await prisma.groupMember.deleteMany({
      where: { groupId: { in: groupIds } },
    });
    await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, hiddenId, adminId] } },
    });
    await prisma.$disconnect();
  });
  it('matches names with relevance, accents, types, ACL filtering, and opaque pagination', async () => {
    const exact = await node('Báo cáo');
    await node('Báo cáo tháng 9');
    await node('Tổng hợp báo cáo');
    const plan = await node('Kế hoạch nhân sự', NodeType.FILE);
    await node('Bao hidden', NodeType.FILE, false);
    await node('Bao public', NodeType.FOLDER, false).then((row) =>
      prisma.node.update({
        where: { id: row.id },
        data: { publicAccess: true },
      }),
    );
    const report = await search.search(actorId, { q: 'bao cao', limit: 2 });
    expect(report.items[0]?.id).toBe(exact.id);
    expect(report.items.map((x) => x.id)).not.toContain(plan.id);
    expect(
      (await search.search(actorId, { q: 'ke hoach nhan su' })).items.map(
        (x) => x.id,
      ),
    ).toContain(plan.id);
    expect(
      (
        await search.search(actorId, {
          q: 'KE HOACH NHAN SU',
          type: NodeType.FILE,
        })
      ).items.map((x) => x.id),
    ).toContain(plan.id);
    expect(
      (await search.search(actorId, { q: 'bao', type: NodeType.FILE })).items,
    ).toHaveLength(0);
    expect(
      report.items.every(
        (x) => !x.name.includes('hidden') && !x.name.includes('public'),
      ),
    ).toBe(true);
    if (report.nextCursor) {
      const page2 = await search.search(actorId, {
        q: 'bao cao',
        limit: 2,
        cursor: report.nextCursor,
      });
      expect(
        page2.items
          .map((x) => x.id)
          .some((id) => report.items.some((first) => first.id === id)),
      ).toBe(false);
    }
  });
  it('matches bulk capability resolution to scalar capability sets', async () => {
    const target = await node(`Parity ${suffix}`);
    const bulk = await authorization.resolveCapabilitiesForNodes(actorId, [
      target.id,
    ]);
    const scalar = await authorization.resolveCapabilities(actorId, target.id);
    expect([...bulk.get(target.id)!.capabilities].sort()).toEqual(
      [...scalar.capabilities].sort(),
    );
    expect(bulk.get(target.id)!.capabilities.has(DocumentCapability.VIEW)).toBe(
      true,
    );
  });

  it('keeps bulk and scalar authorization identical across direct, group, inherited, boundary, and no-bypass cases', async () => {
    const groupId = randomUUID();
    await prisma.group.create({
      data: {
        id: groupId,
        name: `search-group-${suffix}`,
        normalizedName: `search-group-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.groupMember.create({
      data: { groupId, userId: actorId, addedById: actorId },
    });
    const directEditor = await node(`Direct editor ${suffix}`);
    await prisma.permissionEntry.update({
      where: { nodeId_userId: { nodeId: directEditor.id, userId: actorId } },
      data: { role: DocumentRole.EDITOR },
    });
    const groupOwner = await node(
      `Group owner ${suffix}`,
      NodeType.FOLDER,
      false,
    );
    await prisma.permissionEntry.create({
      data: { nodeId: groupOwner.id, groupId, role: DocumentRole.OWNER },
    });
    const inheritedRoot = await node(`Inherited root ${suffix}`);
    const inheritedChild = await prisma.node.create({
      data: {
        parentId: inheritedRoot.id,
        type: NodeType.FILE,
        name: `Inherited child ${suffix}`,
        normalizedName: `inherited-child-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(inheritedChild.id);
    const boundary = await prisma.node.create({
      data: {
        parentId: inheritedRoot.id,
        type: NodeType.FOLDER,
        name: `Boundary ${suffix}`,
        normalizedName: `boundary-${randomUUID()}`,
        inheritPermissions: false,
        createdById: actorId,
      },
    });
    nodeIds.push(boundary.id);
    const boundaryChild = await prisma.node.create({
      data: {
        parentId: boundary.id,
        type: NodeType.FILE,
        name: `Boundary child ${suffix}`,
        normalizedName: `boundary-child-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(boundaryChild.id);
    await prisma.permissionEntry.create({
      data: {
        nodeId: boundaryChild.id,
        userId: actorId,
        role: DocumentRole.VIEWER,
      },
    });
    const noAccess = await node(`No access ${suffix}`, NodeType.FOLDER, false);
    const ids = [
      directEditor.id,
      groupOwner.id,
      inheritedChild.id,
      boundaryChild.id,
      boundary.id,
      noAccess.id,
    ];
    const bulk = await authorization.resolveCapabilitiesForNodes(actorId, ids);
    for (const id of ids) {
      const scalar = await authorization.resolveCapabilities(actorId, id);
      expect([...bulk.get(id)!.capabilities].sort()).toEqual(
        [...scalar.capabilities].sort(),
      );
    }
    expect(bulk.get(boundary.id)!.capabilities).toEqual(new Set());
    expect(
      bulk.get(boundaryChild.id)!.capabilities.has(DocumentCapability.VIEW),
    ).toBe(true);
    await prisma.groupMember.deleteMany({ where: { groupId } });
    await prisma.group.delete({ where: { id: groupId } });
  });

  it('handles prefix, substring, fuzzy, special characters, rename, and trash freshness', async () => {
    const prefix = await node(`Bao prefix ${suffix}`);
    const substring = await node(`Tổng hợp bao suffix ${suffix}`);
    const fuzzy = await node('Kế hoạch nhân sự typo');
    const special = await node(`100% _ quote' slash\\ ${suffix}`);
    const prefixResults = await search.search(actorId, { q: 'bao', limit: 20 });
    expect(
      prefixResults.items.findIndex((item) => item.id === prefix.id),
    ).toBeLessThan(
      prefixResults.items.findIndex((item) => item.id === substring.id),
    );
    expect(
      (await search.search(actorId, { q: 'hop bao' })).items.map(
        (item) => item.id,
      ),
    ).toContain(substring.id);
    expect(
      (await search.search(actorId, { q: 'ke hoah nhan su' })).items.map(
        (item) => item.id,
      ),
    ).toContain(fuzzy.id);
    for (const query of ['%', '_', "quote'", '"', '\\', 'Kế hoạch'])
      await expect(search.search(actorId, { q: query })).resolves.toBeTruthy();
    await prisma.node.update({
      where: { id: special.id },
      data: { name: `Renamed ${suffix}` },
    });
    expect(
      (await search.search(actorId, { q: 'quote' })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(special.id);
    expect(
      (await search.search(actorId, { q: 'renamed' })).items.map(
        (item) => item.id,
      ),
    ).toContain(special.id);
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: prefix.id,
        trashedById: actorId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.node.update({
      where: { id: prefix.id },
      data: { trashOperationId: operation.id },
    });
    expect(
      (await search.search(actorId, { q: 'bao prefix' })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(prefix.id);
    await prisma.node.update({
      where: { id: prefix.id },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.delete({ where: { id: operation.id } });
    expect(
      (await search.search(actorId, { q: 'bao prefix' })).items.map(
        (item) => item.id,
      ),
    ).toContain(prefix.id);
  });

  it('matches current file content with accent-insensitive multi-word FTS and keeps folders name-only', async () => {
    const content = await contentFile(
      'document-001.pdf',
      'Chiến lược sản phẩm quý bốn',
    );
    const folder = await node('content-folder', NodeType.FOLDER);
    expect(
      (await search.search(actorId, { q: 'chien luoc san pham' })).items.map(
        (x) => x.id,
      ),
    ).toContain(content.id);
    expect(
      (await search.search(actorId, { q: 'CHIEN LUOC SAN PHAM' })).items.map(
        (x) => x.id,
      ),
    ).toContain(content.id);
    expect(
      (await search.search(actorId, { q: 'chien luoc beta' })).items.map(
        (x) => x.id,
      ),
    ).not.toContain(content.id);
    expect(
      (
        await search.search(actorId, {
          q: 'chien luoc san pham',
          type: NodeType.FOLDER,
        })
      ).items.map((x) => x.id),
    ).not.toContain(folder.id);
  });

  it('deduplicates name/content matches and ranks names before content-only files', async () => {
    const named = await contentFile(
      `Kế hoạch Aurora nhân sự ${suffix}.pdf`,
      'Kế hoạch Aurora nhân sự',
    );
    const contentOnly = await contentFile(
      'Document.pdf',
      'Kế hoạch Aurora nhân sự',
    );
    const repeated = await contentFile(
      'Other.pdf',
      'Kế hoạch Aurora nhân sự Kế hoạch Aurora nhân sự Kế hoạch Aurora nhân sự',
    );
    const result = await search.search(actorId, {
      q: 'ke hoach aurora nhan su',
      limit: 20,
    });
    const ids = result.items.map((item) => item.id);
    expect(ids[0]).toBe(named.id);
    expect(ids.filter((id) => id === named.id)).toHaveLength(1);
    expect(ids).toContain(contentOnly.id);
    expect(ids).toContain(repeated.id);
    expect(ids.indexOf(repeated.id)).toBeGreaterThan(ids.indexOf(named.id));
    expect(ids.indexOf(repeated.id)).toBeLessThan(ids.indexOf(contentOnly.id));
  });

  it('rejects stale SearchDocument content after a newer version becomes current', async () => {
    const current = await contentFile('versioned.pdf', 'project venus');
    const oldVersionId = randomUUID();
    await prisma.fileVersion.create({
      data: {
        id: oldVersionId,
        fileId: current.fileId,
        versionNumber: 2,
        storageKey: `search/${current.fileId}/${oldVersionId}`,
        originalFilename: 'versioned.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 20n,
        sha256: oldVersionId.replaceAll('-', '').padEnd(64, '0'),
        source: 'UPLOAD',
        createdById: actorId,
      },
    });
    await prisma.file.update({
      where: { id: current.fileId },
      data: { currentVersionId: oldVersionId, versionCounter: 2 },
    });
    expect(
      (await search.search(actorId, { q: 'project venus' })).items.map(
        (x) => x.id,
      ),
    ).not.toContain(current.id);
    expect(
      (await search.search(actorId, { q: 'project mercury' })).items.map(
        (x) => x.id,
      ),
    ).not.toContain(current.id);
  });

  it('paginates mixed content candidates without duplicates', async () => {
    const files = await Promise.all([
      contentFile(`alpha-content-${suffix}.pdf`, 'ngân sách dự án alpha'),
      contentFile(`beta-content-${suffix}.pdf`, 'ngân sách dự án alpha alpha'),
      contentFile(
        `gamma-content-${suffix}.pdf`,
        'ngân sách dự án alpha alpha alpha',
      ),
      contentFile(
        `delta-content-${suffix}.pdf`,
        'ngân sách dự án alpha alpha alpha alpha',
      ),
    ]);
    const first = await search.search(actorId, {
      q: 'ngan sach alpha',
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await search.search(actorId, {
      q: 'ngan sach alpha',
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(2);
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(4);
    expect(new Set(files.map((file) => file.id))).toEqual(
      new Set([...first.items, ...second.items].map((x) => x.id)),
    );
    expect(second.nextCursor).toBeNull();
  });

  it('paginates mixed name and content candidates and ignores hidden content when determining nextCursor', async () => {
    const named = await contentFile(
      `mixed-pagination-${suffix}.pdf`,
      'mixed pagination needle',
    );
    const contentOnly = await contentFile(
      'document-mixed.pdf',
      'mixed pagination needle mixed pagination needle',
    );
    const trailingVisible = await contentFile(
      'document-mixed-visible.pdf',
      'mixed pagination needle mixed pagination needle mixed pagination needle',
    );
    const first = await search.search(actorId, {
      q: 'mixed pagination needle',
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await search.search(actorId, {
      q: 'mixed pagination needle',
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set([named.id, contentOnly.id, trailingVisible.id]),
    );
    expect(second.nextCursor).toBeNull();

    const visibleA = await contentFile('visible-a.pdf', 'hidden cursor needle');
    const visibleB = await contentFile('visible-b.pdf', 'hidden cursor needle');
    await contentFile('hidden-a.pdf', 'hidden cursor needle', false);
    await contentFile('hidden-b.pdf', 'hidden cursor needle', false);
    const visiblePage = await search.search(actorId, {
      q: 'hidden cursor needle',
      limit: 2,
    });
    expect(new Set(visiblePage.items.map((item) => item.id))).toEqual(
      new Set([visibleA.id, visibleB.id]),
    );
    expect(visiblePage.nextCursor).toBeNull();
  });

  it('hides trashed content and restores it when current provenance remains valid', async () => {
    const content = await contentFile('trash-content.pdf', 'restore content needle');
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: content.id,
        trashedById: actorId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.node.update({
      where: { id: content.id },
      data: { trashOperationId: operation.id },
    });
    expect(
      (await search.search(actorId, { q: 'restore content needle' })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(content.id);
    await prisma.node.update({
      where: { id: content.id },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.delete({ where: { id: operation.id } });
    expect(
      (await search.search(actorId, { q: 'restore content needle' })).items.map(
        (item) => item.id,
      ),
    ).toContain(content.id);
  });

  it('uses the bulk ACL resolver for direct, group, inherited, boundary, admin, and public content candidates', async () => {
    const groupId = randomUUID();
    groupIds.push(groupId);
    await prisma.group.create({
      data: {
        id: groupId,
        name: `content-group-${suffix}`,
        normalizedName: `content-group-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.groupMember.create({
      data: { groupId, userId: actorId, addedById: actorId },
    });
    const direct = await contentFile(
      `direct-${suffix}.pdf`,
      'acl direct unique',
    );
    const group = await contentFile(
      `group-${suffix}.pdf`,
      'acl group unique',
      false,
    );
    await prisma.permissionEntry.create({
      data: { nodeId: group.id, groupId, role: DocumentRole.VIEWER },
    });
    const inheritedRoot = await node(`acl-inherited-root-${suffix}`);
    const inherited = await contentFile(
      `inherited-${suffix}.pdf`,
      'acl inherited unique',
      false,
      inheritedRoot.id,
    );
    const boundary = await node(
      `acl-boundary-${suffix}`,
      NodeType.FOLDER,
      false,
      inheritedRoot.id,
    );
    await prisma.node.update({
      where: { id: boundary.id },
      data: { inheritPermissions: false },
    });
    const blocked = await contentFile(
      `boundary-${suffix}.pdf`,
      'acl boundary unique',
      false,
      boundary.id,
    );
    const directChild = await contentFile(
      `boundary-direct-${suffix}.pdf`,
      'acl direct-child unique',
      false,
      boundary.id,
    );
    await prisma.permissionEntry.create({
      data: {
        nodeId: directChild.id,
        userId: actorId,
        role: DocumentRole.VIEWER,
      },
    });
    const adminOnly = await contentFile(
      `admin-only-${suffix}.pdf`,
      'acl admin unique',
      false,
    );
    const publicOnly = await contentFile(
      `public-only-${suffix}.pdf`,
      'acl public unique',
      false,
    );
    await prisma.node.update({
      where: { id: publicOnly.id },
      data: { publicAccess: true },
    });
    const visible = (term: string) =>
      search
        .search(actorId, { q: term })
        .then((result) => result.items.map((item) => item.id));
    expect(await visible('acl direct unique')).toContain(direct.id);
    expect(await visible('acl group unique')).toContain(group.id);
    expect(await visible('acl inherited unique')).toContain(inherited.id);
    expect(await visible('acl boundary unique')).not.toContain(blocked.id);
    expect(await visible('acl direct child unique')).toContain(directChild.id);
    expect(await visible('acl admin unique')).not.toContain(adminOnly.id);
    expect(await visible('acl public unique')).not.toContain(publicOnly.id);
    expect(
      (await search.search(adminId, { q: 'acl admin unique' })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(adminOnly.id);
  });
});
