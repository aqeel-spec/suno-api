import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const personaId = url.searchParams.get('id');
      const page = url.searchParams.get('page');

      if (personaId == null) {
        return new NextResponse(JSON.stringify({ error: 'Missing parameter id' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const pageNumber = page ? parseInt(page) : 1;
      const personaInfo = await (await sunoApi()).getPersonaPaginated(personaId, pageNumber);

      return new NextResponse(JSON.stringify(personaInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: unknown) {
      console.error('Error fetching persona:', error);

      const maybeResponse = typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { status?: number; data?: unknown } }).response
        : undefined;
      const status = maybeResponse?.status && maybeResponse.status >= 400 && maybeResponse.status < 600
        ? maybeResponse.status
        : 500;
      const message = error instanceof Error ? error.message : 'Internal server error';

      return new NextResponse(JSON.stringify({
        error: message,
        details: maybeResponse?.data ?? null
      }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'GET',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
