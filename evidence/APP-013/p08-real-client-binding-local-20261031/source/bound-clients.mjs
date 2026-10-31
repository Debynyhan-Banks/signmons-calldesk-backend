import {gate, need, planHash} from '../../p08-coordinator-auth-local-20261031/source/authority.mjs';
import {database, adapters} from '../../p08-coordinator-auth-local-20261031/source/client.mjs';

export const PREFLIGHT_SQL = 'SELECT current_database() AS database,current_user AS username,(SELECT status::text FROM "TenantOrganization" WHERE id=$1::uuid) AS status';
const keys = (value, expected) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');

/** Explicit injected transports only. This module has no native credentials, pg or fetch defaults. */
export async function boundClients(cap, {binding, secret, ownerAuth, dbFactory, fetcher,
  sessionProbe, now = Date.now} = {}) {
  const c = gate(cap, true), p = c.p, plan = c.plan;
  need(keys(binding, 'operationId,planSha256,project,tenantId,jobId,targetId,database') &&
    binding.operationId === p.operationId && binding.planSha256 === planHash(plan) &&
    binding.project === plan.project && binding.tenantId === p.target.tenantId &&
    binding.jobId === p.jobId && binding.targetId === p.target.id &&
    keys(binding.database, 'host,port,database,user') &&
    typeof binding.database.host === 'string' && binding.database.host.length > 0 &&
    Number.isInteger(binding.database.port) && binding.database.port > 0 &&
    binding.database.port <= 65535 &&
    typeof binding.database.database === 'string' && binding.database.database.length > 0 &&
    typeof binding.database.user === 'string' && binding.database.user.length > 0,
    'PRIVATE_BINDING_SCOPE');
  need(keys(secret, 'password') && typeof secret.password === 'string' && secret.password.length > 0 &&
    [ownerAuth, dbFactory, fetcher, sessionProbe, now].every(x => typeof x === 'function'),
    'INJECTED_CLIENTS_REQUIRED');
  let db, token = '', closed = false;
  const sessionName = 'p08-auth-' + p.operationId;
  try {
    const owner = await ownerAuth({project: plan.project, principal: plan.ownerPrincipal});
    gate(cap, true);
    need(keys(owner, 'principal,impersonationOverride,credentialOverride,accessToken') &&
      owner.principal === plan.ownerPrincipal && owner.impersonationOverride === false &&
      owner.credentialOverride === false && typeof owner.accessToken === 'string' &&
      owner.accessToken.length >= 20 && !/\s/.test(owner.accessToken), 'OWNER_AUTHORITY_DRIFT');
    token = owner.accessToken;
    db = await dbFactory({...binding.database}, secret.password, sessionName);
    need(db && ['connect', 'query', 'end'].every(name => typeof db[name] === 'function'),
      'DATABASE_CLIENT_REQUIRED');
    await db.connect(); gate(cap, true);
    need(db.connection?.stream?.encrypted === true &&
      db.connection?.stream?.authorized === true, 'TLS_REQUIRED');
    const pre = await db.query(PREFLIGHT_SQL, [p.target.tenantId]); gate(cap, true);
    need(pre?.rows?.length === 1 && pre.rows[0]?.database === binding.database.database &&
      pre.rows[0]?.username === binding.database.user && pre.rows[0]?.status === 'ACTIVE',
      'DATABASE_PREFLIGHT');
    const api = adapters(cap, {accessToken: token, fetcher, now});
    token = '';
    return {...api, db: database(db, p.target, cleanup => gate(cap, cleanup)),
      async close() {
        need(!closed, 'SESSION_CLOSEOUT_RESERVED');
        closed = true;
        api.clear(); secret.password = '';
        let endFailed = false;
        try { await db.end(); } catch { endFailed = true; }
        gate(cap, true);
        const count = await sessionProbe(sessionName, {...binding.database});
        gate(cap, true);
        need(!endFailed && Number.isInteger(count) && count === 0, 'SESSIONS_REMAIN');
        return true;
      },
      clear() {api.clear(); token = ''; secret.password = '';},
    };
  } catch (error) {
    token = ''; secret.password = '';
    if (db) {
      try {
        await db.end();
        const count = await sessionProbe(sessionName, {...binding.database});
        need(Number.isInteger(count) && count === 0, 'DATABASE_SESSION_UNCONFIRMED');
      } catch {
        throw Object.assign(Error('DATABASE_SESSION_UNCONFIRMED'),
          {code: 'DATABASE_SESSION_UNCONFIRMED'});
      }
    }
    throw error;
  }
}

export function native() {throw Object.assign(Error('P08_REAL_CLIENT_BINDING_NATIVE_DISABLED'),
  {code: 'P08_REAL_CLIENT_BINDING_NATIVE_DISABLED'});}
