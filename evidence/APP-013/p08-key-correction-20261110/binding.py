"""Source-bound active candidate pins; adoption requires a reviewed receipt/source commit."""
import json,re,uuid
from pathlib import Path
HERE=Path(__file__).resolve().parent
STRIPE='signmons-staging-stripe-secret-key'
LEGACY='signmons-calldesk-staging-app013p07atomic1'
def validate(value):
 if not isinstance(value,dict) or set(value)!={'state','candidate','stripeVersion','correctionOperationId','correctionReceiptSha256'}:raise ValueError('CANDIDATE_BINDING_SHAPE')
 if value['state']=='LEGACY':
  if value!={'state':'LEGACY','candidate':LEGACY,'stripeVersion':'1','correctionOperationId':None,'correctionReceiptSha256':None}:raise ValueError('LEGACY_PIN_DRIFT')
 elif value['state']=='CORRECTED':
  op=value['correctionOperationId']
  if str(uuid.UUID(op))!=op or value['candidate']!='signmons-calldesk-staging-p07key'+op.replace('-','')[:12] or not re.fullmatch('[1-9][0-9]{0,8}',value['stripeVersion']) or int(value['stripeVersion'])<=1 or not re.fullmatch('[a-f0-9]{64}',value['correctionReceiptSha256'] or ''):raise ValueError('CORRECTED_PIN_DRIFT')
 else:raise ValueError('CANDIDATE_BINDING_STATE')
 return dict(value)
def current():return validate(json.loads((HERE/'candidate.json').read_text()))
def version(secret,cfg=None):return (cfg or current())['stripeVersion'] if secret==STRIPE else '1'
def resource_pins(restore,cfg=None):
 cfg=validate(cfg or current());secrets=tuple(s for s in restore.SECRETS if s!=STRIPE)
 if cfg['state']=='CORRECTED':secrets+=(STRIPE,)
 return {'candidate':cfg['candidate'],'image':restore.IMAGE,'normalRevision':restore.NORMAL,'identity':restore.IDENTITY,'secretVersions':{s:version(s,cfg) for s in secrets}}
def apply_restore(restore,cfg=None):
 """Configure a fresh loaded historical module in memory; never edit its pinned source."""
 cfg=validate(cfg or current())
 if hasattr(restore,'_candidate_config'):
  if restore._candidate_config!=cfg:raise ValueError('CANDIDATE_REBIND_REFUSED')
  return restore
 restore._candidate_config=cfg;restore.CANDIDATE=cfg['candidate']
 restore.SECRETS=tuple(s for s in restore.SECRETS if s!=STRIPE)+((STRIPE,) if cfg['state']=='CORRECTED' else ())
 restore.POLICIES=tuple(dict.fromkeys((*restore.SECRETS,STRIPE)))
 original_operations=restore.operations
 def operations(p):
  rows=original_operations(p)
  if cfg['state']=='CORRECTED':
   stripe=('version',STRIPE);rows=[stripe]+[row for row in rows if row!=stripe]
  return rows
 restore.operations=operations
 original=restore.command
 def command(p,kind,name,enable):
  if kind=='version' and name==STRIPE:
   restore.need(cfg['state']=='CORRECTED','FOREIGN_SECRET')
   return ['secrets','versions','enable' if enable else 'disable',cfg['stripeVersion'],'--secret='+STRIPE,'--project=signmons','--quiet']
  return original(p,kind,name,enable)
 restore.command=command
 prior=restore.NativeAdapter.readback
 def readback(self,kind,name,enabled,p,deadline):
  if kind=='version' and name==STRIPE:
   restore.need(cfg['state']=='CORRECTED','FOREIGN_SECRET')
   return self.cloud(['secrets','versions','describe',cfg['stripeVersion'],'--secret='+STRIPE,'--project=signmons','--format=json(state)'],deadline).get('state')==('ENABLED' if enabled else 'DISABLED')
  return prior(self,kind,name,enabled,p,deadline)
 restore.NativeAdapter.readback=readback
 return restore
