import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentRole, NodeType, prisma, UserStatus } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { TrashService } from './trash.service.js';

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;
describeWithDatabase('TrashService integration', () => {
  const suffix = randomUUID(), actorId = randomUUID(), nodeIds: string[] = [];
  const database = { prisma } as unknown as DatabaseService;
  const service = new TrashService(database, new DocumentAuthorizationService(database), { retentionDays: 30 });
  beforeAll(async () => { await prisma.user.create({ data:{id:actorId,email:`trash-${suffix}@example.test`,normalizedEmail:`trash-${suffix}@example.test`,displayName:'Trash owner',status:UserStatus.ACTIVE} }); });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where:{ actorId } });
    await prisma.node.updateMany({ where:{id:{in:nodeIds}},data:{trashOperationId:null} });
    await prisma.trashOperation.deleteMany({ where:{trashedById:actorId} });
    await prisma.permissionEntry.deleteMany({where:{nodeId:{in:nodeIds}}});
    const rows=await prisma.node.findMany({where:{id:{in:nodeIds}},select:{id:true,parentId:true}});
    const parents=new Map(rows.map(row=>[row.id,row.parentId]));
    const depth=(id:string):number=>{const parent=parents.get(id);return parent&&parents.has(parent)?depth(parent)+1:0;};
    for(const row of rows.sort((a,b)=>depth(b.id)-depth(a.id))) await prisma.node.deleteMany({where:{id:row.id}});
    await prisma.user.delete({where:{id:actorId}}); await prisma.$disconnect();
  });
  async function node(parentId:string|null,name:string,type:NodeType=NodeType.FOLDER) {
    const record=await prisma.node.create({data:{parentId,type,name,normalizedName:`${name}-${randomUUID()}`,createdById:actorId}});
    nodeIds.push(record.id); return record;
  }
  it('trashes an active subtree once and preserves active-name reuse', async () => {
    const root=await node(null,'root'), child=await node(root.id,'child'), leaf=await node(child.id,'leaf',NodeType.FILE);
    await prisma.permissionEntry.create({data:{nodeId:root.id,userId:actorId,role:DocumentRole.OWNER}});
    const result=await service.trash(actorId,root.id);
    expect(result.affectedNodeCount).toBe(3);
    expect(await prisma.node.findMany({where:{id:{in:[root.id,child.id,leaf.id]}},select:{trashOperationId:true}})).toEqual(expect.arrayContaining([{trashOperationId:result.operation.id}]));
    const replacement=await prisma.node.create({data:{parentId:null,type:NodeType.FOLDER,name:'root',normalizedName:`root-${randomUUID()}`,createdById:actorId}});
    nodeIds.push(replacement.id);
    await expect(service.trash(actorId,root.id)).rejects.toMatchObject({status:404});
  });
  it('keeps an older nested trash operation and counts only newly tagged nodes', async () => {
    const a=await node(null,'a'), b=await node(a.id,'b'), c=await node(b.id,'c');
    await prisma.permissionEntry.create({data:{nodeId:a.id,userId:actorId,role:DocumentRole.OWNER}});
    const old=await service.trash(actorId,c.id);
    const newer=await service.trash(actorId,a.id);
    expect(newer.affectedNodeCount).toBe(2);
    expect((await prisma.node.findUniqueOrThrow({where:{id:c.id}})).trashOperationId).toBe(old.operation.id);
  });
  it('allows only one concurrent effective trash operation', async () => {
    const root=await node(null,'concurrent'), child=await node(root.id,'concurrent-child');
    await prisma.permissionEntry.create({data:{nodeId:root.id,userId:actorId,role:DocumentRole.OWNER}});
    const results=await Promise.allSettled([service.trash(actorId,root.id),service.trash(actorId,root.id)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const nodes=await prisma.node.findMany({where:{id:{in:[root.id,child.id]}},select:{trashOperationId:true}});
    expect(new Set(nodes.map(n=>n.trashOperationId))).toHaveLength(1);
  });
});
