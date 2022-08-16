import { IncomingMessage } from 'http';
import { Http2ServerRequest } from 'http2';

export function resolveHostFromRequest(req: IncomingMessage|Http2ServerRequest): string {
  const authority: string = req.headers[':authority'] as string|undefined;
  return authority ||
    req.headers.host ||
    'unknown'
  ;
}

export function resolveIpFromRequest(req: IncomingMessage|Http2ServerRequest): string {
  const forwardedFor: string = req.headers['x-forwarded-for'] as string|undefined;
  return forwardedFor ||
    req?.socket?.remoteAddress ||
    'unknown'
  ;
}
