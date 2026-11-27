'use strict';
/**
 * EC2 instance metadata (IMDSv2), fetched ON the target with curl. Amazon Linux 2023 enforces IMDSv2.
 * Resolves null when the target is not an EC2 instance or the metadata service is unreachable.
 */
const SCRIPT = [
  "T=$(curl -s -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) || exit 3",
  '[ -n "$T" ] || exit 3',
  'for k in instance-id instance-type placement/availability-zone local-ipv4 public-ipv4 ami-id; do',
  '  printf "%s=" "$k"; curl -s -m 2 -H "X-aws-ec2-metadata-token: $T" "http://169.254.169.254/latest/meta-data/$k"; echo',
  'done',
].join('\n');

const SAFE = /^[\w.:\/-]{1,64}$/;

function parseMetadata(text) {
  const m = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) { const v = line.slice(i + 1).trim(); m[line.slice(0, i)] = SAFE.test(v) ? v : null; }
  }
  if (!m['instance-id'] || !/^i-[0-9a-f]+$/.test(m['instance-id'])) return null;
  const az = m['placement/availability-zone'];
  return {
    instanceId: m['instance-id'], instanceType: m['instance-type'], availabilityZone: az,
    region: az ? az.replace(/[a-z]$/, '') : null, localIp: m['local-ipv4'], publicIp: m['public-ipv4'], amiId: m['ami-id'],
  };
}

async function fetchInstanceMetadata(host) {
  try {
    const r = await host.run('sh', ['-c', SCRIPT], { timeout: 12000 });
    return r.ok ? parseMetadata(r.stdout) : null;
  } catch { return null; }
}

module.exports = { fetchInstanceMetadata, parseMetadata };
