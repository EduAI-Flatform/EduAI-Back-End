const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.cwd();
assert.equal(process.env.NODE_ENV,'test','NODE_ENV=test required');
assert.ok(process.env.BANK_RECEIPT_OCR_DATA_PATH,'Set the absolute local OCR model directory.');
const sharp = require(require.resolve('sharp',{paths:[root]}));
const { BankReceiptOcrService } = require(path.join(root,'dist/src/modules/payments/bank-transfer-receipt-ocr.service.js'));
process.env.BANK_TRANSFER_SANDBOX_ENABLED='true'; process.env.BANK_RECEIPT_SANDBOX_ENABLED='true';

(async()=>{
 const lines=['SYNTHETIC RECEIPT - DO NOT TRANSFER','Recipient Bank: MB','Recipient Account: 0000000000',
 'Beneficiary Name: EDUAI SANDBOX','Amount: 100000 VND','Transfer Content: EDUAI123456',
 'Transaction Time: 23/10/2026 08:05:00 +07:00','Transaction ID: DEMOTXN123456'];
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="850"><rect width="100%" height="100%" fill="white"/>'+lines.map((line,i)=>'<text x="40" y="'+(70+i*90)+'" font-family="Arial" font-size="38" fill="black">'+line+'</text>').join('')+'</svg>';
 const png=await sharp(Buffer.from(svg)).png().toBuffer();
 const result=await new BankReceiptOcrService({app:{nodeEnv:'test'}}).assess(png);
 assert.equal(result.fields.bankBin,'970422'); assert.equal(result.fields.accountNumber,'0000000000');
 assert.equal(result.fields.amountMinor,'100000'); assert.equal(result.fields.transferContent,'EDUAI123456');
 assert.equal(result.fields.beneficiaryName,'EDUAI SANDBOX'); assert.equal(result.fields.transactionId,'DEMOTXN123456');
 assert.equal(result.fields.occurredAt,'2026-10-23T08:05:00+07:00');
 console.log(JSON.stringify({test:'real local Tesseract synthetic receipt',result:'PASS',confidence:result.confidence,warnings:result.warnings}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
