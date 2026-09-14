import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const { ControlledCustomerAdmission, controlledCustomerAdmissionDigest, CONTROLLED_PHONE_HOLD }=require("../dist/communications/controlled-customer-admission.js");
const { STAGING_PHONE_HOLD }=require("../dist/communications/staging-phone-admission.js");
export async function verifyControlledPhoneAdmission({prisma,tenantId}) {
  const [db]=await prisma.$queryRawUnsafe("SELECT current_database() AS name, inet_server_addr() AS address");
  assert.match(db.name,/^calldesk_org_[0-9a-f]{12}$/);assert.equal(db.address,null);
  const tenant=await prisma.tenantOrganization.findUniqueOrThrow({where:{id:tenantId}});
  const settings=tenant.settings??{};
  const policy={packetId:randomUUID(),tenantId,accountSid:"AC"+randomUUID().replaceAll("-",""),serviceSid:"VA"+randomUUID().replaceAll("-",""),participantHmac:"a".repeat(64),noticeVersion:"synthetic",rateVersion:"not-real-pricing",startsAt:Date.now()-1000,expiresAt:Date.now()+60000,flowUpperBoundMicros:10,accountCeilingMicros:15};
  const scope={tenantId,sessionId:randomUUID(),conversationId:randomUUID()};
  const opt={requested:true,noticeVersion:policy.noticeVersion};
  const approve=async(p,enabled=true)=>prisma.tenantOrganization.update({where:{id:tenantId},data:{settings:{...settings,controlledPhoneApproval:{enabled,digest:controlledCustomerAdmissionDigest(p)}}}});
  const reserve=(p,s=scope,id=randomUUID(),phone=p.participantHmac)=>prisma.$transaction(tx=>new ControlledCustomerAdmission(p).reserve(tx,s,id,phone,opt));
  try {
    await approve(policy);
    await prisma.auditLog.create({data:{tenantId,entityType:"Conversation",entityId:randomUUID(),actorType:"SYSTEM_AI",actorId:"local-test",action:STAGING_PHONE_HOLD,metadata:{version:1,state:"HELD",currency:"USD",reservedMicros:6,accountSid:policy.accountSid,sessionId:randomUUID()}}});
    await assert.rejects(()=>reserve(policy)); // prior liability is not reset
    const p={...policy,accountCeilingMicros:16};await approve(p);
    const ids=[randomUUID(),randomUUID()];
    const outcomes=await Promise.allSettled(ids.map(id=>reserve(p,scope,id)));
    assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
    const id=ids[outcomes.findIndex(r=>r.status==="fulfilled")];
    const check=(s=scope,phone=p.participantHmac)=>prisma.$transaction(tx=>new ControlledCustomerAdmission(p).check(tx,s,id,phone));
    await check();await prisma.$transaction(tx=>new ControlledCustomerAdmission(p).replay(tx,scope,id,p.participantHmac));
    await assert.rejects(()=>check({...scope,sessionId:randomUUID()}));
    await assert.rejects(()=>check(scope,"b".repeat(64)));
    await assert.rejects(()=>reserve(p,{...scope,sessionId:randomUUID(),conversationId:randomUUID()}));
    await approve(p,false);await assert.rejects(()=>check());
    const expired={...p,startsAt:Date.now()-10000,expiresAt:Date.now()-1};await approve(expired);await assert.rejects(()=>reserve(expired));
    const rollback={...policy,packetId:randomUUID(),accountSid:"AC"+randomUUID().replaceAll("-","")};await approve(rollback);
    await assert.rejects(()=>prisma.$transaction(async tx=>{await new ControlledCustomerAdmission(rollback).reserve(tx,scope,randomUUID(),rollback.participantHmac,opt);throw Error("synthetic rollback");}));
    assert.equal(await prisma.auditLog.count({where:{action:CONTROLLED_PHONE_HOLD,metadata:{path:["accountSid"],equals:rollback.accountSid}}}),0);
    assert.equal(await prisma.auditLog.count({where:{action:CONTROLLED_PHONE_HOLD,metadata:{path:["accountSid"],equals:p.accountSid}}}),1);
    return {concurrentReservations:2,heldFlows:1,oldLiabilityCounted:true,restartReplay:true,revocationRefused:true,rollbackAtomic:true,providerCalls:0};
  } finally {await prisma.tenantOrganization.update({where:{id:tenantId},data:{settings}});}
}
