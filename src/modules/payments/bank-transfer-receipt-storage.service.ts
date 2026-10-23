import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/** Isolated local storage only. There is deliberately no public URL or production fallback. */
@Injectable()
export class BankReceiptStorageService {
  constructor(private readonly config: AppConfigService) {}
  private root() {
    if (!['development','test'].includes(this.config.app.nodeEnv) || process.env.BANK_RECEIPT_SANDBOX_ENABLED !== 'true') {
      throw new ServiceUnavailableException('RECEIPT_SANDBOX_DISABLED');
    }
    const root = process.env.BANK_RECEIPT_STORAGE_ROOT ?? join(tmpdir(), 'eduai-receipt-sandbox-'+createHash('sha256').update(userInfo().username).digest('hex').slice(0,16));
    const fromApp = relative(resolve(process.cwd()), resolve(root));
    if (!isAbsolute(root) || !fromApp || (!fromApp.startsWith('..'+sep) && fromApp !== '..' && !isAbsolute(fromApp))) {
      throw new ServiceUnavailableException('RECEIPT_STORAGE_NOT_PRIVATE');
    }
    return resolve(root);
  }
  private path(id: string) {
    const root=this.root();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new NotFoundException('RECEIPT_IMAGE_UNAVAILABLE');
    return {root,path:join(root,id.toLowerCase()+'.png')};
  }
  private async rejectSymlinkAncestors(root:string) {
    for(let cursor=root;;cursor=dirname(cursor)) {
      try {if((await lstat(cursor)).isSymbolicLink())throw new ServiceUnavailableException('RECEIPT_STORAGE_NOT_PRIVATE');}
      catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(dirname(cursor)===cursor)break;
    }
  }
  private async verifyPrivateRoot(root:string) {
    await this.rejectSymlinkAncestors(root);
    const stat=await lstat(root);
    if(!stat.isDirectory() || (process.getuid && (stat.uid!==process.getuid() || (stat.mode & 0o077)!==0))) {
      throw new ServiceUnavailableException('RECEIPT_STORAGE_NOT_PRIVATE');
    }
  }
  private async ensurePrivateRoot(root:string) {
    await this.rejectSymlinkAncestors(root);
    await mkdir(root,{recursive:true,mode:0o700});
    const stat=await lstat(root);
    if(process.getuid && stat.uid!==process.getuid())throw new ServiceUnavailableException('RECEIPT_STORAGE_NOT_PRIVATE');
    if(process.getuid)await chmod(root,0o700);
    await this.verifyPrivateRoot(root);
  }
  async put(id:string, buffer:Buffer):Promise<void> {
    const {root,path}=this.path(id);
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 12*1024*1024) throw new ServiceUnavailableException('RECEIPT_STORAGE_INVALID');
    await this.ensurePrivateRoot(root);
    try {
      const handle=await open(path,'wx',0o600);
      try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ServiceUnavailableException('RECEIPT_STORAGE_UNAVAILABLE');
      const previous=await this.read(id);
      if (createHash('sha256').update(previous).digest('hex') !== createHash('sha256').update(buffer).digest('hex')) {
        throw new ConflictException('RECEIPT_STORAGE_CONFLICT');
      }
    }
  }
  async read(id:string):Promise<Buffer> {
    const {root,path}=this.path(id);
    try {
      await this.verifyPrivateRoot(root); const rootStat=await lstat(root); const stat=await lstat(path);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 12*1024*1024) throw new Error('private file required');
      const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { return await handle.readFile(); } finally { await handle.close(); }
    } catch { throw new NotFoundException('RECEIPT_IMAGE_UNAVAILABLE'); }
  }
  async remove(id:string):Promise<void> {
    const {root,path}=this.path(id);
    try {
      await this.verifyPrivateRoot(root);
      const stat=await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('private root required');
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ServiceUnavailableException('RECEIPT_STORAGE_UNAVAILABLE');
    }
  }
}
