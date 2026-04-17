import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { DEFAULT_MODEL, sunoApi, AdvancedOptions } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';
import { analyzeBuffer, analyzeUrl, buildFinalTags } from '@/lib/audioAnalyzer';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return new NextResponse('Method Not Allowed', {
      headers: { Allow: 'POST', ...corsHeaders },
      status: 405,
    });
  }

  try {
    const contentType = req.headers.get('content-type') ?? '';
    let analysis;
    let opts: Record<string, any> = {};

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file') as File | null;

      if (!file) {
        return new NextResponse(
          JSON.stringify({ error: 'Missing form field: file' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        return new NextResponse(
          JSON.stringify({ error: 'File too large. Maximum allowed size is 50 MB.' }),
          { status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      analysis = await analyzeBuffer(buffer, file.type || undefined);

      // Read optional overrides from other form fields
      const str = (key: string) => (form.get(key) as string | null) ?? undefined;
      opts = {
        title: str('title'),
        prompt: str('prompt'),
        extra_tags: str('extra_tags'),
        tags_override: str('tags_override'),
        negative_tags: str('negative_tags'),
        model: str('model'),
        wait_audio: str('wait_audio') === 'true',
        make_instrumental: str('make_instrumental') === 'true',
        vocal_gender: str('vocal_gender'),
        weirdness: str('weirdness') != null ? Number(str('weirdness')) : undefined,
        style_influence: str('style_influence') != null ? Number(str('style_influence')) : undefined,
        persona_id: str('persona_id'),
      };

    } else {
      // JSON path — accepts { url, title, prompt, extra_tags, tags_override, ... }
      const body = await req.json();

      if (!body.url || typeof body.url !== 'string') {
        return new NextResponse(
          JSON.stringify({ error: 'Provide either multipart/form-data with a "file" field, or JSON with a "url" field.' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      analysis = await analyzeUrl(body.url);
      opts = body;
    }

    // Build final tags: detected + user overrides
    const finalTags = buildFinalTags(analysis, {
      extra_tags: opts.extra_tags,
      tags_override: opts.tags_override,
    });

    const title = opts.title || analysis.title || 'Generated Song';
    const prompt = opts.prompt || '';

    // If no tags at all (file had no embedded metadata and user gave none), warn but continue
    if (!finalTags) {
      console.warn('[generate_from_audio] No style tags detected or provided — generating with empty tags');
    }

    const advanced: AdvancedOptions | undefined =
      (opts.vocal_gender || opts.weirdness != null || opts.style_influence != null || opts.persona_id)
        ? {
            ...(opts.vocal_gender && { vocal_gender: opts.vocal_gender }),
            ...(opts.weirdness != null && { weirdness: opts.weirdness }),
            ...(opts.style_influence != null && { style_influence: opts.style_influence }),
            ...(opts.persona_id && { persona_id: opts.persona_id }),
          }
        : undefined;

    const audioInfo = await (await sunoApi((await cookies()).toString())).custom_generate(
      prompt,
      finalTags,
      title,
      Boolean(opts.make_instrumental),
      opts.model || DEFAULT_MODEL,
      Boolean(opts.wait_audio),
      opts.negative_tags,
      advanced
    );

    return new NextResponse(
      JSON.stringify({ analysis, clips: audioInfo }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );

  } catch (error: any) {
    console.error('Error in generate_from_audio:', error);
    return new NextResponse(
      JSON.stringify({ error: error.response?.data?.detail || error.message || error.toString() }),
      {
        status: error.response?.status || 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
