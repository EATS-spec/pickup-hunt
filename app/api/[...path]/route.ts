import { env } from 'cloudflare:workers';
import { handleAPI } from '../../../lib/api.mjs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => handleAPI(request,env);
export const POST = (request: Request) => handleAPI(request,env);
