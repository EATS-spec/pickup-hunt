import { env } from 'cloudflare:workers';
import { handleMCP } from '../../lib/api.mjs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleMCP(request,env);
