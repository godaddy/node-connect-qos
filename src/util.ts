import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';

const HOST_NORMALIZE_REGEX = /(^www\.)?([^:]+)(:\d+)?$/;

export function normalizeHost(host: string): string {
  const match = HOST_NORMALIZE_REGEX.exec(host.toLowerCase());
  return match ? match[2] : host;
}

export function resolveHostFromRequest(req: IncomingMessage|Http2ServerRequest): string {
  const authority: string = req.headers[':authority'] as string|undefined;
  return normalizeHost(authority ||
    req.headers.host ||
    'unknown')
  ;
}

export function resolveIpFromRequest(req: IncomingMessage|Http2ServerRequest, behindProxy = false): string {
  // for security reasons, we should never ASSUME the server is behind a proxy
  // and only support `x-forwarded-for` is explicitly enabled
  const forwardedFor: string = behindProxy && req.headers['x-forwarded-for'] as string|undefined;
  return forwardedFor ||
    req?.socket?.remoteAddress ||
    'unknown'
  ;
}

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MAPPED_REGEX = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function resolveSubnetFromIp(ip: string, maskBits: 8|16|24|32 = 24): string {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract the IPv4 portion
  const mappedMatch = IPV4_MAPPED_REGEX.exec(ip);
  const ipv4 = mappedMatch ? mappedMatch[1] : ip;

  // Pure IPv4
  if (IPV4_REGEX.test(ipv4)) {
    const octets = ipv4.split('.');
    return octets.slice(0, maskBits / 8).join('.');
  }

  // Pure IPv6 or anything else — return as-is
  return ip;
}
