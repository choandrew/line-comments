// @ts-check
// Minimal path-style S3 client with SigV4 signing, enough for S3-compatible stores (SeaweedFS, MinIO, AWS).
const crypto = require('crypto');

/**
 * @typedef {{ endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string }} S3Config
 */

/** @param {string} data */
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
/** @param {crypto.BinaryLike} key @param {string} data */
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// SigV4 wants RFC 3986 encoding; encodeURIComponent leaves !'()* unescaped.
/** @param {string} s */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** @param {string} s */
const unxml = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[/** @type {'amp'} */ (e)]);

/**
 * @param {S3Config} cfg @param {'GET' | 'PUT' | 'DELETE'} method @param {string} key
 * @param {Record<string, string>} [query] @param {string} [body]
 */
async function request(cfg, method, key, query = {}, body = '') {
  const origin = new URL(cfg.endpoint);
  const pathname = `/${enc(cfg.bucket)}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payload = sha256(body);
  const signed = { host: origin.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
  const names = Object.keys(signed).join(';');
  const canonical = [
    method,
    pathname,
    qs,
    Object.entries(signed).map(([k, v]) => `${k}:${v}\n`).join(''),
    names,
    payload,
  ].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key4 = ['aws4_request', 's3', cfg.region, day].reduceRight((k, part) => hmac(k, part), Buffer.from(`AWS4${cfg.secretAccessKey}`));
  const signature = crypto.createHmac('sha256', key4).update(toSign).digest('hex');
  const res = await fetch(`${origin.origin}${pathname}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      'x-amz-content-sha256': payload,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
    },
    body: method === 'PUT' ? body : undefined,
  });
  if (!res.ok) {
    const code = /<Code>([^<]*)<\/Code>/.exec(await res.text())?.[1] ?? '';
    throw new Error(`S3 ${method} ${cfg.bucket}/${key}: HTTP ${res.status} ${code}`.trim());
  }
  return res;
}

/** Every key under `prefix` with its ETag. @param {S3Config} cfg @param {string} prefix */
async function list(cfg, prefix) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @type {string | undefined} */
  let token;
  do {
    /** @type {Record<string, string>} */
    const query = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const xml = await (await request(cfg, 'GET', '', query)).text();
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(item)?.[1];
      const etag = /<ETag>([^<]*)<\/ETag>/.exec(item)?.[1];
      if (key === undefined || etag === undefined) throw new Error(`S3 list ${cfg.bucket}/${prefix}: entry without Key or ETag`);
      out.set(unxml(key), unxml(etag));
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? unxml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '')
      : undefined;
    if (token === '') throw new Error(`S3 list ${cfg.bucket}/${prefix}: truncated without a continuation token`);
  } while (token);
  return out;
}

/** @param {S3Config} cfg @param {string} key */
const get = async (cfg, key) => (await request(cfg, 'GET', key)).text();
/** @param {S3Config} cfg @param {string} key @param {string} text */
const put = async (cfg, key, text) => void (await request(cfg, 'PUT', key, {}, text));
/** @param {S3Config} cfg @param {string} key */
const del = async (cfg, key) => void (await request(cfg, 'DELETE', key));

module.exports = { list, get, put, del };
