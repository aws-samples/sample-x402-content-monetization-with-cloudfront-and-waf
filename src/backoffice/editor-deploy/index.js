// @ts-check
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const s3 = new S3Client({});
const cf = new CloudFrontClient({});
const BUCKET = process.env.BUCKET;
const CF_DISTRIBUTION_ID = process.env.CF_DISTRIBUTION_ID;
const STACK_NAME = process.env.STACK_NAME || '';
const DEPLOY_REGION = process.env.DEPLOY_REGION || 'us-east-1';
const WAF_WEB_ACL_ID = process.env.WAF_WEB_ACL_ID || '';
// Inline MIME map — this file is deployed as a standalone Lambda (Makefile copies only index.js)
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const DEFAULT_MIME_TYPE = 'application/octet-stream';

// Alphanumeric, hyphens, and dots only — rejects any injection characters
const SAFE_CONFIG_VALUE = /^[a-zA-Z0-9._-]*$/;

function validateEnvVars() {
  if (!BUCKET) throw new Error('Missing required environment variable: BUCKET');
  if (!CF_DISTRIBUTION_ID) throw new Error('Missing required environment variable: CF_DISTRIBUTION_ID');
}

function validateConfigValue(name, value) {
  if (!SAFE_CONFIG_VALUE.test(value)) {
    throw new Error(`Environment variable ${name} contains invalid characters: ${value}`);
  }
}

function send(event, context, status) {
  const body = JSON.stringify({
    Status: status, Reason: context.logStreamName, PhysicalResourceId: context.logStreamName,
    StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId, Data: {},
  });
  const parsed = url.parse(event.ResponseURL);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: parsed.hostname, port: 443, path: parsed.path, method: 'PUT', headers: { 'content-type': '', 'content-length': body.length } }, resolve);
    req.on('error', reject); req.write(body); req.end();
  });
}

function assertSafePath(resolvedPath, baseDir) {
  const normalizedBase = path.resolve(baseDir) + path.sep; // nosemgrep: path-join-resolve-traversal
  const normalizedPath = path.resolve(resolvedPath); // nosemgrep: path-join-resolve-traversal
  if (!normalizedPath.startsWith(normalizedBase) && normalizedPath !== path.resolve(baseDir)) { // nosemgrep: path-join-resolve-traversal
    throw new Error(`Path traversal detected: ${resolvedPath} is outside ${baseDir}`);
  }
}

async function uploadDir(dir, prefix) {
  assertSafePath(dir, dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name); // nosemgrep: path-join-resolve-traversal — validated by assertSafePath below
    assertSafePath(full, dir);
    const key = prefix + entry.name;
    if (entry.isDirectory()) {
      await uploadDir(full, key + '/');
    } else {
      const ext = path.extname(entry.name);
      let body = fs.readFileSync(full);

      // Inject stack config into index.html so the editor knows the stack name and region
      if (entry.name === 'index.html') {
        validateConfigValue('STACK_NAME', STACK_NAME);
        validateConfigValue('DEPLOY_REGION', DEPLOY_REGION);
        validateConfigValue('WAF_WEB_ACL_ID', WAF_WEB_ACL_ID);
        validateConfigValue('CF_DISTRIBUTION_ID', CF_DISTRIBUTION_ID || '');
        const configScript = `<script>window.__X402_STACK_CONFIG__=${JSON.stringify({ stackName: STACK_NAME, region: DEPLOY_REGION, wafWebAclId: WAF_WEB_ACL_ID, cfDistributionId: CF_DISTRIBUTION_ID })};</script>`;
        body = Buffer.from(body.toString('utf-8').replace('</head>', configScript + '</head>'));
      }

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: body,
        ContentType: MIME_TYPES[ext] || DEFAULT_MIME_TYPE,
        CacheControl: ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      }));
    }
  }
}

async function deletePrefix(prefix) {
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const obj of res.Contents || []) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    }
    token = res.NextContinuationToken;
  } while (token);
}

exports.handler = async (event, context) => {
  console.log(JSON.stringify({ message: 'CFN event received', requestType: event.RequestType }));
  try {
    if (event.RequestType === 'Delete') {
      // Skip editor deletion — CloudFormation sends Delete on custom resource
      // replacement (e.g., Lambda version change), which would wipe editor assets
      // that the new Create/Update is about to re-upload.
      console.log(JSON.stringify({ message: 'Skipping editor deletion on Delete event' }));
    } else {
      validateEnvVars();
      await deletePrefix('editor/');
      const assetsDir = path.join(__dirname, 'editor-assets');
      await uploadDir(assetsDir, 'editor/');
      if (CF_DISTRIBUTION_ID) {
        await cf.send(new CreateInvalidationCommand({
          DistributionId: CF_DISTRIBUTION_ID,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: { Quantity: 1, Items: ['/editor/*'] },
          },
        }));
      }
    }
    await send(event, context, 'SUCCESS');
  } catch (e) {
    console.error(JSON.stringify({ message: 'Editor deploy failed', error: e.message || String(e) }));
    await send(event, context, 'FAILED');
  }
};
