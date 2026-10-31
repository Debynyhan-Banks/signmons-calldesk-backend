import {readFileSync, writeFileSync, renameSync} from 'node:fs';
import {gate, need, exactApp, exactIdentity} from './authority.mjs';

const safeCode = e => ['INTERRUPTED', 'OPERATION_DEADLINE', 'CLOCK_ROLLBACK',
  'APPLICATION_DRIFT', 'IDENTITY_DRIFT', 'CLAIMS_DRIFT', 'ACTIVATION_CONFLICT',
  'SIGN_EXCHANGE_REFUSED', 'EXACT_TOKEN_REQUIRED'].includes(e?.code)
  ? e.code : 'ADAPTER_REFUSED_OR_UNKNOWN';

/** A child operation in the coordinator's existing journal; never starts another journal. */
export class CoordinatorAuthSequence {
  constructor(cap, clients) {
    const c = gate(cap, true);
    need(clients && ['db', 'fb'].every(k => clients[k]) &&
      ['issue', 'authenticate', 'dropToken', 'clear', 'close'].every(k => typeof clients[k] === 'function') &&
      ['get', 'activate', 'disable'].every(k => typeof clients.db[k] === 'function') &&
      ['get', 'enable', 'disable', 'revoke'].every(k => typeof clients.fb[k] === 'function'), 'CLIENT_CONTRACT');
    this.cap = cap;
    this.clients = clients;
    this.path = c.journalPath;
    this.target = c.p.target;
    this.state = null;
  }

  journal() {
    gate(this.cap, true);
    const j = JSON.parse(readFileSync(this.path, 'utf8'));
    need(j.operationId && j.planSha256 && j.authAttempted === true, 'JOURNAL_OWNERSHIP');
    return j;
  }

  save(changes) {
    const j = this.journal();
    const previous = j.authClient;
    need((this.state === null && previous === undefined) ||
      (previous?.version === this.state?.version && previous?.operationId === this.state?.operationId),
    'JOURNAL_CONCURRENT_DRIFT');
    const next = {operationId: j.operationId, ...this.state, ...changes,
      version: (this.state?.version ?? 0) + 1};
    j.authClient = next;
    const temporary = this.path + '.auth-next';
    writeFileSync(temporary, JSON.stringify(j), {mode: 0o600, flag: 'wx'});
    renameSync(temporary, this.path);
    this.state = next;
  }

  load() {
    const j = this.journal();
    need(j.authClient?.operationId === j.operationId &&
      Number.isInteger(j.authClient.version) && j.authClient.version > 0,
    'AUTH_JOURNAL_REQUIRED');
    this.state = j.authClient;
  }

  async step(fn, cleanup = false) {
    gate(this.cap, cleanup);
    const value = await fn();
    gate(this.cap, cleanup);
    return value;
  }

  async run() {
    gate(this.cap);
    this.save({phase: 'START', activationIntent: false, firebaseEnableIntent: false,
      tokenIssueIntent: false, authenticated: false, closeoutAttempted: false,
      activatedVersion: null, disabledVersion: null, residuals: []});
    let token = '';
    try {
      const before = exactApp(await this.step(() => this.clients.db.get()), this.target, 'DISABLED');
      exactIdentity(await this.step(() => this.clients.fb.get()), this.target, true);
      need(typeof before.updatedAt === 'string' && before.updatedAt, 'APP_VERSION');
      this.save({phase: 'ACTIVATE_INTENT', activationIntent: true});
      const active = exactApp(await this.step(() => this.clients.db.activate(before.updatedAt)), this.target, 'ACTIVE');
      need(typeof active.updatedAt === 'string' && active.updatedAt, 'APP_VERSION');
      this.save({phase: 'ACTIVATED', activatedVersion: active.updatedAt});
      this.save({phase: 'ENABLE_INTENT', firebaseEnableIntent: true});
      await this.step(() => this.clients.fb.enable());
      exactIdentity(await this.step(() => this.clients.fb.get()), this.target, false);
      this.save({phase: 'TOKEN_INTENT', tokenIssueIntent: true});
      token = await this.step(() => this.clients.issue());
      need(typeof token === 'string' && token, 'TOKEN_MISSING');
      await this.step(() => this.clients.authenticate(token));
      this.save({phase: 'AUTHENTICATED', authenticated: true});
    } catch (error) {
      this.save({phase: 'STOPPED', failureStage: this.state.phase, failureCode: safeCode(error)});
    } finally {
      token = '';
      this.clients.dropToken();
    }
    return this.closeout();
  }

  async closeout(independent = false) {
    if (independent) this.load();
    need(this.state && !this.state.closeoutAttempted, 'CLOSEOUT_RESERVED');
    this.save({phase: 'CLOSEOUT_INTENT', closeoutAttempted: true});
    const residuals = [];
    const attempt = async (label, fn) => {
      try { return await this.step(fn, true); }
      catch { residuals.push(label); return null; }
    };
    let app = null;
    if (this.state.activationIntent) {
      app = await attempt('APP_READBACK', () => this.clients.db.get());
      if (app) {
        try { exactApp(app, this.target, app.status); }
        catch { residuals.push('APP_DRIFT'); app = null; }
      }
    }
    if (this.state.firebaseEnableIntent || this.state.activationIntent) {
      await attempt('FIREBASE_DISABLE', () => this.clients.fb.disable());
      const since = Date.now();
      await attempt('FIREBASE_REVOKE', () => this.clients.fb.revoke());
      await attempt('FIREBASE_READBACK', async () => {
        const user = exactIdentity(await this.clients.fb.get(), this.target, true);
        need(Math.floor(Date.parse(user.tokensValidAfterTime) / 1000) >= Math.floor(since / 1000),
          'REVOCATION_READBACK');
      });
    }
    if (app?.status === 'ACTIVE') {
      if (!this.state.activatedVersion || app.updatedAt !== this.state.activatedVersion) {
        residuals.push('ACTIVATION_OUTCOME_UNKNOWN');
      } else {
        const closed = await attempt('APP_DISABLE', () => this.clients.db.disable(this.state.activatedVersion));
        if (closed) {
          try { exactApp(closed, this.target, 'DISABLED'); this.save({disabledVersion: closed.updatedAt}); }
          catch { residuals.push('APP_DISABLE_READBACK'); }
        }
      }
    } else if (app?.status === 'DISABLED') {
      try {
        exactApp(app, this.target, 'DISABLED');
        if (this.state.activatedVersion && app.updatedAt !== this.state.disabledVersion)
          residuals.push('APP_DISABLED_VERSION_UNKNOWN');
      }
      catch { residuals.push('APP_DISABLED_DRIFT'); }
    }
    if (this.state.activationIntent && (!app || !this.state.activatedVersion))
      residuals.push('ACTIVATION_OUTCOME_UNKNOWN');
    if (this.state.firebaseEnableIntent && this.state.failureStage === 'ENABLE_INTENT')
      residuals.push('ENABLE_OUTCOME_UNKNOWN');
    await attempt('SESSION_CLOSEOUT', () => this.clients.close());
    this.clients.clear();
    const status = residuals.length ? 'P08_COORDINATOR_AUTH_CONTAINMENT_UNCONFIRMED' :
      this.state.authenticated ? 'P08_COORDINATOR_AUTHENTICATED_AND_CLOSED' :
        'P08_COORDINATOR_AUTH_STOPPED_AND_CLOSED';
    this.save({phase: 'CLOSEOUT_FINISHED', residuals: [...new Set(residuals)].sort(),
      status, sessionClosed: !residuals.includes('SESSION_CLOSEOUT')});
    return {status, authenticated: this.state.authenticated,
      residuals: this.state.residuals, sessionClosed: this.state.sessionClosed,
      liveAuthorization: false, authProofReady: false};
  }
}

export function native() { throw Object.assign(Error('P08_COORDINATOR_AUTH_SEQUENCE_NATIVE_DISABLED'),
  {code: 'P08_COORDINATOR_AUTH_SEQUENCE_NATIVE_DISABLED'}); }
