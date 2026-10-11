// Private, persistent object storage. Records hold an object key, never a public URL.
// Media is served only through authorized API routes.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function createStorage(config) {
  const m = config.media;
  if (m.driver === 's3') {
    let s3;
    try {
      s3 = await import('@aws-sdk/client-s3');
    } catch {
      throw new Error('MEDIA_DRIVER=s3 requires the @aws-sdk/client-s3 package (npm i @aws-sdk/client-s3)');
    }
    const client = new s3.S3Client({
      region: m.s3.region,
      endpoint: m.s3.endpoint,
      forcePathStyle: Boolean(m.s3.endpoint),
      credentials: m.s3.accessKeyId ? { accessKeyId: m.s3.accessKeyId, secretAccessKey: m.s3.secretAccessKey } : undefined,
    });
    return {
      driver: 's3',
      async put(key, buf, contentType) {
        await client.send(new s3.PutObjectCommand({ Bucket: m.s3.bucket, Key: key, Body: buf, ContentType: contentType, ServerSideEncryption: m.s3.endpoint ? undefined : 'AES256' }));
      },
      async get(key) {
        const res = await client.send(new s3.GetObjectCommand({ Bucket: m.s3.bucket, Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
      },
    };
  }
  if (m.driver === 'memory') {
    const store = new Map();
    return { driver: 'memory', put: async (k, b) => void store.set(k, Buffer.from(b)), get: async (k) => store.get(k) };
  }
  const root = path.resolve(m.localDir);
  const safe = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('invalid storage key');
    return p;
  };
  return {
    driver: 'local',
    async put(key, buf) {
      const p = safe(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, buf, { mode: 0o600 });
    },
    get: (key) => readFile(safe(key)),
  };
}
