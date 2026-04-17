import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers';
import { DEFAULT_MODEL, sunoApi, AdvancedOptions } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const {
        reference_audio_id,
        prompt,
        tags,
        title,
        make_instrumental,
        model,
        wait_audio,
        negative_tags,
        vocal_gender,
        weirdness,
        style_influence,
        persona_id,
      } = body;

      if (!reference_audio_id || typeof reference_audio_id !== 'string') {
        return new NextResponse(
          JSON.stringify({ error: 'Missing required field: reference_audio_id (string) — UUID of the Suno clip to use as reference' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const advanced: AdvancedOptions | undefined =
        (vocal_gender || weirdness != null || style_influence != null || persona_id)
          ? {
              ...(vocal_gender && { vocal_gender }),
              ...(weirdness != null && { weirdness }),
              ...(style_influence != null && { style_influence }),
              ...(persona_id && { persona_id }),
            }
          : undefined;

      const audioInfo = await (await sunoApi((await cookies()).toString())).generateSimilar(
        reference_audio_id,
        prompt || '',
        tags || '',
        title || '',
        Boolean(make_instrumental),
        model || DEFAULT_MODEL,
        Boolean(wait_audio),
        negative_tags,
        advanced
      );

      return new NextResponse(JSON.stringify(audioInfo), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (error: any) {
      console.error('Error generating similar audio:', error);
      return new NextResponse(
        JSON.stringify({ error: error.response?.data?.detail || error.toString() }),
        {
          status: error.response?.status || 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: { Allow: 'POST', ...corsHeaders },
      status: 405,
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 200, headers: corsHeaders });
}
