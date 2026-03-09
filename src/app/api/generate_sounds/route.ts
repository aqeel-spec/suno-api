import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { DEFAULT_MODEL, sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { prompt, make_instrumental, model, wait_audio } = body;

      if (!prompt) {
        return new NextResponse(JSON.stringify({ error: 'prompt is required — describe the sound you want' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const audioInfo = await (await sunoApi((await cookies()).toString())).generate_sounds(
        prompt,
        make_instrumental !== false, // defaults to true for sound effects
        model || DEFAULT_MODEL,
        Boolean(wait_audio)
      );

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error generating sounds:', error?.response?.data ?? error?.message ?? error);
      if (error?.response?.status === 402) {
        return new NextResponse(JSON.stringify({ error: error.response.data.detail }), {
          status: 402,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      return new NextResponse(JSON.stringify({ error: error?.response?.data?.detail ?? error.toString() }), {
        status: error?.response?.status || 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: { Allow: 'POST', ...corsHeaders },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders,
  });
}
