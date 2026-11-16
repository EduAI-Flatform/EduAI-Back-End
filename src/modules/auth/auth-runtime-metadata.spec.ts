import * as fs from 'node:fs';
import { join } from 'node:path';

describe('per-process auth build identity', () => {
  const originalRead = fs.readFileSync;
  const previousMode = process.env.NODE_ENV;
  afterEach(() => { jest.restoreAllMocks(); process.env.NODE_ENV = previousMode; });
  it('keeps the running identity after a deployment replaces metadata on disk', () => {
    let revision = 'a'.repeat(40);
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options: any) =>
      String(file) === join(process.cwd(), 'dist/auth-runtime.json')
        ? JSON.stringify({ tokenVersion: 2, revision }) : originalRead(file, options)) as any);
    let identity: any;
    jest.isolateModules(() => { identity = require('./auth-runtime-metadata').AUTH_RUNTIME_METADATA; });
    revision = 'b'.repeat(40);
    expect(identity).toEqual({ tokenVersion: 2, revision: 'a'.repeat(40) });
    expect(Object.isFrozen(identity)).toBe(true);
  });
  it('fails production startup on legacy or malformed build identity', () => {
    process.env.NODE_ENV = 'production';
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options: any) =>
      String(file) === join(process.cwd(), 'dist/auth-runtime.json')
        ? JSON.stringify({ tokenVersion: 1, revision: 'a'.repeat(40) }) : originalRead(file, options)) as any);
    expect(() => jest.isolateModules(() => require('./auth-runtime-metadata'))).toThrow('AUTH_RUNTIME_METADATA_INVALID');
  });
});
