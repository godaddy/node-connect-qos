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

export type SubnetMaskBits = 20|21|22|23|24|25|26|27|28|29|30;

export function resolveSubnetFromIp(ip: string, maskBits: SubnetMaskBits = 24): string {
  if (maskBits < 20 || maskBits > 30) throw new Error(`maskBits ${maskBits} must be between 20 and 30`);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract the IPv4 portion
  const mappedMatch = IPV4_MAPPED_REGEX.exec(ip);
  const ipv4 = mappedMatch ? mappedMatch[1] : ip;

  // Pure IPv4 — apply bit mask and return full 4-octet network address
  if (IPV4_REGEX.test(ipv4)) {
    return ipv4.split('.').map((octet, i) => {
      const bitsBeforeOctet = i * 8;
      if (maskBits >= bitsBeforeOctet + 8) return Number(octet);  // fully network bits
      if (maskBits <= bitsBeforeOctet) return 0;                   // fully host bits
      return Number(octet) & ((0xFF << (8 - (maskBits - bitsBeforeOctet))) & 0xFF);
    }).join('.');
  }

  // Pure IPv6 or anything else — return as-is
  return ip;
}
