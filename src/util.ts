import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';

const HOST_NORMALIZE_REGEX = /(^www\.)?([^:]+)(:\d+)?$/;

export function normalizeHost(host: string): string {
  return HOST_NORMALIZE_REGEX.exec(host.toLowerCase())[2];
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

// subset of https://github.com/tinovyatkin/is-localhost-ip/blob/master/index.js#L13
const IP_RANGES = [
  // 127.0.0.0 - 127.255.255.255
  /^(:{2}f{4}:)?127(?:\.\d{1,3}){3}$/,
  // 192.168.0.0 - 192.168.255.255
  /^(:{2}f{4}:)?192\.168(?:\.\d{1,3}){2}$/,
  // 172.16.0.0 - 172.31.255.255
  /^(:{2}f{4}:)?(172\.1[6-9]|172\.2\d|172\.3[01])(?:\.\d{1,3}){2}$/,
  // fc00::/7
  /^f[cd][\da-f]{2}(::1$|:[\da-f]{1,4}){1,7}$/,
  // fe80::/10
  /^fe[89ab][\da-f](::1$|:[\da-f]{1,4}){1,7}$/,
];

const IP_TESTER = new RegExp(
  `^(${IP_RANGES.map((re) => re.source).join('|')})$`,
);

export function isLocalAddress(ip: string): boolean {
  return IP_TESTER.test(ip);
}
