'use strict';
const http = require('http');

const HOST = '169.254.169.254';

function request(method, path, headers = {}, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, path, method, headers, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body.trim()) : reject(new Error(`IMDS ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('IMDS timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * EC2 instance metadata via IMDSv2 (token-based; Amazon Linux 2023 enforces it by default).
 * Resolves null when not running on EC2 or when the metadata service is unreachable
 * (e.g. hop limit 1 inside a container).
 */
async function fetchInstanceMetadata() {
  try {
    const token = await request('PUT', '/latest/api/token', { 'X-aws-ec2-metadata-token-ttl-seconds': '60' });
    const get = (p) => request('GET', `/latest/meta-data/${p}`, { 'X-aws-ec2-metadata-token': token }).catch(() => null);
    const [instanceId, instanceType, az, localIp, publicIp, amiId] = await Promise.all([
      get('instance-id'), get('instance-type'), get('placement/availability-zone'), get('local-ipv4'), get('public-ipv4'), get('ami-id'),
    ]);
    if (!instanceId) return null;
    return { instanceId, instanceType, availabilityZone: az, region: az ? az.replace(/[a-z]$/, '') : null, localIp, publicIp, amiId };
  } catch { return null; }
}

/** Looks up metadata once in the background and caches it (metadata is static for an instance's lifetime). */
class InstanceMetadata {
  constructor() { this.value = null; this.done = false; }
  start() {
    fetchInstanceMetadata().then((v) => { this.value = v; this.done = true; });
    return this;
  }
}

module.exports = { InstanceMetadata, fetchInstanceMetadata };
