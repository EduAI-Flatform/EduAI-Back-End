const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const dotenv = require('dotenv');
const { verifyProductionCommerceConfig } = require('./verify-production-commerce-config.cjs');
const FLAGS = { topup: 'GDS_WALLET_PRODUCTION_TOPUP_ENABLED', checkout: 'GDS_WALLET_PRODUCTION_CHECKOUT_ENABLED' };
function databaseFingerprint(value) {
  const u = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !u.hostname || u.pathname.length < 2) throw new Error('Wallet production database identity is invalid');
  return createHash('sha256').update(u.hostname.toLowerCase()+':'+(u.port||'5432')+'/'+decodeURIComponent(u.pathname.slice(1))).digest('hex');
}
function setVariable(source, name, value) {
  const regex = new RegExp('^\\s*(?:export\\s+)?'+name+'\\s*=.*(?:\\r?\\n|$)', 'gm');
  return source.replace(regex, '').replace(/\s*$/, '')+'\n'+name+'='+value+'\n';
}
function configureGdsProductionWallet(source, options = {}) {
  const choices = { topup: options.topup || 'preserve', checkout: options.checkout || 'preserve' };
  for (const v of Object.values(choices)) if (!['preserve','enable','disable'].includes(v)) throw new Error('Wallet production action is invalid');
  if (Object.values(choices).every(v => v === 'preserve')) return source;
  let candidate = source;
  for (const [key, name] of Object.entries(FLAGS)) if (choices[key] !== 'preserve') candidate = setVariable(candidate, name, String(choices[key] === 'enable'));
  const env = dotenv.parse(candidate);
  if (Object.values(choices).includes('enable')) {
    if (env.NODE_ENV !== 'production') throw new Error('Wallet activation requires the production runtime');
    // Explicit wallet activation retires the VPS legacy VNPay sandbox classification.
    candidate = setVariable(candidate, 'DEPLOYMENT_CLASS', 'production');
    candidate = setVariable(candidate, 'PAYMENT_DEFAULT_PROVIDER', 'payos');
    const fingerprint = options.uatFingerprint || env.GDS_WALLET_UAT_DATABASE_FINGERPRINT;
    if (!/^[a-f0-9]{64}$/i.test(fingerprint || '') || fingerprint.toLowerCase() === databaseFingerprint(env.DATABASE_URL)) throw new Error('Wallet activation requires a distinct confirmed UAT database identity');
    candidate = setVariable(candidate, 'GDS_WALLET_UAT_DATABASE_FINGERPRINT', fingerprint.toLowerCase());
    verifyProductionCommerceConfig(dotenv.parse(candidate), { log() {} });
  }
  return candidate;
}
function run() {
  const args = process.argv.slice(2);
  const options = {};
  const names = { '--topup': 'topup', '--checkout': 'checkout', '--uat-fingerprint': 'uatFingerprint' };
  for (let i=0;i<args.length;i+=2) {
    const name=names[args[i]];
    if (!name || options[name] !== undefined || args[i+1] === undefined) throw new Error('Wallet production arguments are invalid');
    options[name]=args[i+1];
  }
  const path = '.env';
  const source = fs.readFileSync(path, 'utf8');
  const candidate = configureGdsProductionWallet(source, options);
  if (candidate !== source) {
    const temporary = path+'.wallet-'+randomUUID()+'.tmp';
    try { fs.writeFileSync(temporary, candidate, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, path); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  const env=dotenv.parse(candidate);
  console.log('walletProductionTopupEnabled: '+(env.GDS_WALLET_PRODUCTION_TOPUP_ENABLED === 'true'));
  console.log('walletProductionCheckoutEnabled: '+(env.GDS_WALLET_PRODUCTION_CHECKOUT_ENABLED === 'true'));
  console.log('walletDeploymentClass: '+(['production','uat','development'].includes(env.DEPLOYMENT_CLASS)?env.DEPLOYMENT_CLASS:'default'));
}
if (require.main === module) { try { run(); } catch { console.error('Wallet production configuration failed closed'); process.exitCode=1; } }
module.exports = { configureGdsProductionWallet, databaseFingerprint };
