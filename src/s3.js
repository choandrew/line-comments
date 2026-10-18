// @ts-check
// Minimal path-style S3 client, enough for S3-compatible stores (SeaweedFS, MinIO, AWS). Requests are
// SigV4-signed when credentials are given and anonymous otherwise.
const crypto = require('crypto');

/**
 * @typedef {{ accessKeyId: string, secretAccessKey: string }} Credentials
 * @typedef {{ endpoint: string, region: string, bucket: string, credentials?: Credentials }} S3Config
 */

/** A non-2xx answer; `status` lets callers tell "needs a key" (403) from other failures. */
class S3Error extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

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
  const res = await fetch(`${origin.origin}${pathname}${qs ? `?${qs}` : ''}`, {
    method,
    headers: cfg.credentials ? sign(cfg.credentials, cfg.region, origin.host, method, pathname, qs, body) : {},
    body: method === 'PUT' ? body : undefined,
  });
  if (!res.ok) {
    const code = /<Code>([^<]*)<\/Code>/.exec(await res.text())?.[1] ?? '';
    throw new S3Error(`S3 ${method} ${cfg.bucket}/${key}: HTTP ${res.status} ${code}`.trim(), res.status);
  }
  return res;
}

/**
 * SigV4 headers for one request.
 * @param {Credentials} creds @param {string} region @param {string} host @param {string} method
 * @param {string} pathname @param {string} qs @param {string} body @returns {Record<string, string>}
 */
function sign(creds, region, host, method, pathname, qs, body) {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payload = sha256(body);
  const signed = { host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
  const names = Object.keys(signed).join(';');
  const canonical = [
    method,
    pathname,
    qs,
    Object.entries(signed).map(([k, v]) => `${k}:${v}\n`).join(''),
    names,
    payload,
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = ['aws4_request', 's3', region, day].reduceRight((k, part) => hmac(k, part), Buffer.from(`AWS4${creds.secretAccessKey}`));
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    'x-amz-content-sha256': payload,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
  };
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

module.exports = { S3Error, list, get, put, del };
